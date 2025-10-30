const isDev = process?.env?.npm_lifecycle_script?.includes('--watch')

import puppeteer from 'puppeteer'
import killPort from 'kill-port'
import express from 'express'
import { Server } from 'socket.io'
import http from 'http'
import open from 'open'

const PORT = 3000
const app = express()
const browsers = new Map()
let io

const random = (arr) => arr[Math.floor(Math.random() * arr.length)]
const delay = (ms = 5000) => new Promise((r) => setTimeout(r, ms))
const processedPathnames = [
  ['/api/livechat/conversation/new'], // new chat
  ['/api/livechat/conversation/chatUsers'], // get active cs
  ['/api/livechat/event/fetch-notifications'], // new chat update
  [
    '/api/livechat/conversation/fetch-wait-time-and-queue-positionflix-live-chat', // wait time
    '/api/livechat/conversation/fetch-wait-time-and-queue-position', // wait time
  ],
  'https://survey-app.sprinklr.com/index.html', // survey / chat closed
]

const loggerMap = {}

class BrowserSession {
  constructor(id, config = {}) {
    this.id = id
    this._config = config
    if (!config.debounceWaitTime) this._config.debounceWaitTime = 30_000
    if (!config.debounceNewMessage) this._config.debounceNewMessage = 20_000
    this._isReloading = false
    this._isStopping = false
    this._state = {
      agent: {},
      messages: [],
      waitTime: null,
      autoReply: config.autoReply ?? true,
      running: false,
      closed: false,
    }
  }

  get state() {
    return this._state
  }

  set state(partial) {
    this._state = { ...this._state, ...partial }
    io.emit('state:update', { id: this.id, state: this._state })
  }

  handleActivityUpdate(text) {
    io.emit('state:update', { id: this.id, state: { activities: [{ text, date: Date.now() }] } })
  }

  async submitSecureForm(message, messageId) {
    try {
      const iframeHandle = await this._page.$('iframe[name="spr-chat__box-frame"]')
      const frame = await iframeHandle.contentFrame()
      const input = await frame.waitForSelector(`[id="${messageId}"] form input`, { visible: true, timeout: 5000 })
      await input.focus()
      await input.type(message)
      const sendBtn = await frame.waitForSelector(`[id="${messageId}"] form button`, { visible: true, timeout: 5000 })
      await sendBtn.click()
    } catch (error) {
      this.handleActivityUpdate(`Submit gagal: ${error.message}`)
    }
  }

  async sendMessages(messages) {
    for (const message of messages) {
      try {
        const iframeHandle = await this._page.$('iframe[name="spr-chat__box-frame"]')
        const frame = await iframeHandle.contentFrame()
        const textarea = await frame.waitForSelector('#COMPOSER_ID', { visible: true, timeout: 5000 })
        await textarea.focus()
        await textarea.type(message)
        const sendBtn = await frame.waitForSelector('[data-testid="Submit"]', { visible: true, timeout: 5000 })
        await sendBtn.click()
      } catch (error) {
        this.handleActivityUpdate(`Pesan gagal: ${error.message}`)
      } finally {
        await delay(2000)
      }
    }
  }

  async start() {
    if (this._state.running) return

    let shouldReload = true

    try {
      this._isStopping = false
      this.state = { running: true, closed: false }

      const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--lang=en-US']

      let proxy = null

      if (this._config?.proxy?.length) {
        const line = random(this._config.proxy)

        if (line) {
          const [proxyUrl, authPart] = line.trim().split('|')

          if (proxyUrl) {
            proxy = { url: proxyUrl, username: null, password: null }

            if (authPart) {
              const colonIndex = authPart.indexOf(':')
              if (colonIndex !== -1) {
                proxy.username = authPart.substring(0, colonIndex)
                proxy.password = authPart.substring(colonIndex + 1)
              }
            }

            this.handleActivityUpdate(`Proxy: ${JSON.stringify(proxy)}`)

            args.push(`--proxy-server=${proxy.url}`)
          }
        }
      }

      this._browser = await puppeteer.launch({ headless: true, defaultViewport: null, args })

      this.handleActivityUpdate(`Browser dibuka`)

      const [page] = await this._browser.pages()
      page.setDefaultTimeout(30_000)
      if (proxy?.username && proxy?.password) {
        await page.authenticate({ username: proxy.username, password: proxy.password })
      }
      this._page = page

      const helpText = random(this._config.selamatDatang)
      const defaultUrl = `https://help.netflix.com/en/interface/chat?helpText=${encodeURIComponent(helpText)}`

      const handleNewMessage = async (messages = []) => {
        if (!messages.length) return

        this.state = {
          messages: [
            ...this.state.messages.filter((m) => !messages.some((n) => n.payload.messageId === m.id)),
            ...messages,
          ],
        }

        if (!this._state.autoReply) return

        const lastIndex = messages.map((m) => m.sender).lastIndexOf('P_-100')
        const newMessages = lastIndex !== -1 ? messages.slice(lastIndex + 1) : messages

        for (const message of newMessages.filter((m) => m.payload.type === 'NEW_MESSAGE')) {
          const text = message.payload.notificationContent
          const sender = message.sender

          const patternCheckingMessage = [
            '2 minute',
            'two minute',
            'one minute',
            '1 minute',
            'two-minute',
            'one-minute',
            'next-minute',
          ]

          if (sender.startsWith('P_') && !sender.startsWith('P_-') && text.endsWith('?')) {
            this.handleActivityUpdate(`CS terindikasi: diakhiri ?`)
            this.state = { autoReply: false }
            return
          }

          if (
            sender.startsWith('P_') &&
            !sender.startsWith('P_-') &&
            !text.includes('https://') &&
            (text.includes('email') || text.includes('name'))
          ) {
            this.handleActivityUpdate(`CS terindikasi: menanyakan nama atau email`)
            this.state = { autoReply: false }
            return
          }

          if (
            sender.startsWith('P_') &&
            !sender.startsWith('P_-') &&
            !patternCheckingMessage.some((p) => text.toLowerCase().includes(p)) &&
            text.length < 100
          ) {
            this.handleActivityUpdate(
              `CS terindikasi: tidak template pesan, tidak termasuk peringatan 2 menit close, atau panjang pesan kurang dari 100`
            )
            this.state = { autoReply: false }
            return
          }

          if (this.debounceMessageTimer) clearTimeout(this.debounceMessageTimer)

          this.debounceMessageTimer = setTimeout(async () => {
            try {
              if (!this._state.autoReply) return

              const replyTexts = random(this._config.pingChat).split(':')

              const lastMessage = this._state.messages.at(-1)

              if (lastMessage.sender.startsWith('P_-')) {
                this.handleActivityUpdate(`Bot: mengirim pesan ${lastMessage.sender}`)
                this.sendMessages(replyTexts)
                return
              }

              if (lastMessage.sender.startsWith('P_') && lastMessage.text.includes('https://')) {
                const templateMessages = this._state.messages.filter(
                  (m) => m.sender.startsWith('P_') && m.text.includes('https://')
                )
                if (templateMessages.length >= 3) {
                  this.handleActivityUpdate(`Bot: template pesan 3x`)
                  await this.reload()
                  return
                }
                this.handleActivityUpdate(`Bot: membalas template pesan https://`)
                this.sendMessages(replyTexts)
                return
              }

              if (
                lastMessage.sender.startsWith('P_') &&
                patternCheckingMessage.some((p) => lastMessage.text.toLowerCase().includes(p))
              ) {
                this.handleActivityUpdate(`Bot: membalas template pesan peringatan 2 menit close`)
                this.sendMessages(replyTexts)
                return
              }
            } catch (error) {
              this.handleActivityUpdate(`Bot: ${error.message}`)
            }
          }, this._config.debounceNewMessage)
        }
      }

      page.on('request', (request) => {
        const method = request.method()
        const url = request.url()
        const postData = request.postData()

        if (!loggerMap[this.id]) loggerMap[this.id] = []
        loggerMap[this.id].push({ method, url, postData })
      })

      page.on('response', async (response) => {
        try {
          const urlObj = new URL(response.url())
          const baseUrl = urlObj.origin + urlObj.pathname

          const buffer = await response.buffer().catch(() => null)
          const data = { url: baseUrl, status: response.status(), body: buffer ? buffer.toString('utf8') : null }

          if (!response.ok()) {
            this.handleActivityUpdate(`Response Status: ${data.status}, ${baseUrl}`)

            if (baseUrl.includes('/interface/chat/startVendorChat') || baseUrl.includes('/interface/chat/authorize')) {
              this.handleActivityUpdate('Chat is unavailable')
              shouldReload = false
              this.reload()
            }

            return
          }

          try {
            data.body = JSON.parse(data.body)
          } catch {}

          if (baseUrl.includes('/api/pci/resources')) {
            this.state = {
              messages: this._state.messages.map((m) => {
                if (m?.payload?.chatMessage?.messagePayload?.attachment?.type === 'SECURE_FORM') {
                  m?.payload?.chatMessage?.messagePayload?.attachment.hideAttachment = true
                }
                return m
              }),
            }
            return
          }

          if (baseUrl.includes('/api/livechat/conversation/send')) {
            this.state = {
              messages: [
                ...this.state.messages,
                {
                  id: data.body.id,
                  payload: {
                    type: 'NEW_MESSAGE',
                    notificationContent: data.body.messagePayload.text,
                  },
                  conversationId: data.body.conversationId,
                  sender: data.body.sender,
                  creationTime: data.body.creationTime,
                },
              ],
            }
            return
          }

          const matchIndex = processedPathnames.flat().findIndex((p) => baseUrl.includes(p))

          switch (matchIndex) {
            case 0:
              this.handleActivityUpdate('Percakapan dimulai.')
              break
            case 1:
              this.state = { agent: data.body[0] }
              this.handleActivityUpdate(`CS ditemukan: ${data.body[0].fullName}`)
              break
            case 2:
              handleNewMessage(data.body.results)
              break
            case 3:
            case 4:
              this.state = { waitTime: data.body.waitTime }
              this.handleActivityUpdate(`Waktu estimasi: ${data.body.waitTime}ms`)
              if (this.waitTimeTimer) clearTimeout(this.waitTimeTimer)
              this.waitTimeTimer = setTimeout(async () => {
                if (!this._state.agent.userId) {
                  this.reload()
                }
              }, data.body.waitTime + this._config.debounceWaitTime)
              break
            case 5:
              this.handleActivityUpdate(`Percakapan telah ditutup`)
              this.state = { closed: true }
              this.reloadTimer = setTimeout(() => {
                this.reload()
              }, Number(this._config.waitTimeReload) * 1000)
              break
            default:
              break
          }
        } catch (error) {
          this.handleActivityUpdate(`Response Error: ${error.message}`)
        }
      })

      await page.goto(defaultUrl, { waitUntil: 'domcontentloaded' })

      try {
        const buttonChatAgent = await page.waitForSelector('div.chat-actions button.btn.btn-primary')
        await buttonChatAgent.click()
      } catch (error) {
        throw new Error('Button memulai percakapan tidak ditemukan')
      }
    } catch (error) {
      this.handleActivityUpdate(`Gagal membuka browser: ${error.message}`)
      if (shouldReload) this.reload()
    }
  }

  async stop(force = true) {
    if (force) this._isStopping = true
    if (this.debounceMessageTimer) clearTimeout(this.debounceMessageTimer)
    if (this.waitTimeTimer) clearTimeout(this.waitTimeTimer)
    if (this.reloadTimer) clearTimeout(this.reloadTimer)

    if (this._page) {
      this._page.removeAllListeners('response')
      this._page.removeAllListeners('request')
    }

    await this._browser?.close()?.catch((error) => this.handleActivityUpdate(`Gagal menutup browser: ${error.message}`))

    browsers.delete(this.id)
    this.state = { running: !force, agent: {}, messages: [], waitTime: null, closed: false }
    this.handleActivityUpdate(`Browser ditutup`)
  }

  async reload() {
    if (this._isReloading || this._isStopping) return

    this._isReloading = true

    this.handleActivityUpdate(`Browser memulai ulang`)

    await this.stop(false)
    await delay(5000)

    if (this._isStopping) return

    const browser = new BrowserSession(this.id, this._config)
    browsers.set(this.id, browser)

    browser.start()
    this._isReloading = false
  }
}

const exitProcess = async (error) => {
  console.error(error)
  ;[...browsers].forEach(([id, s]) => s?._browser?.close()?.catch(() => {}))
  await delay(1000)
  process.exit()
}
process.on('SIGINT', exitProcess)
process.on('unhandledRejection', exitProcess)
process.on('uncaughtException', exitProcess)

function startServer() {
  const server = http.createServer(app)

  io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } })

  io.on('connection', (client) => {
    ;[...browsers].forEach(([id, s]) => (s.state = {}))

    client.on('start-browser', async (data) => {
      for (const { id, config } of data) {
        if (browsers.has(id)) continue
        const browser = new BrowserSession(id, config)
        browsers.set(id, browser)
        browser.start()
      }
    })

    client.on('stop-browser', ({ id }) => {
      const browser = browsers.get(id)
      if (browser) browser.stop(true)
    })

    client.on('stop-program', exitProcess)

    client.on('send-message', ({ id, message, messageId }) => {
      const browser = browsers.get(id)
      if (browser) {
        if (messageId) {
          browser.submitSecureForm(message, messageId)
        } else {
          browser.sendMessages([message])
        }
      }
    })

    client.on('state:update', ({ id, state }) => {
      const browser = browsers.get(id)
      if (browser) browser.state = state
    })
  })

  server.on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      await killPort(PORT, 'tcp').then(startServer).catch(exitProcess)
    }
  })

  server.listen(PORT, '127.0.0.1', async () => {
    console.log(`Listening: ${PORT}`)
    if (!isDev) open(`http://127.0.0.1:${PORT}`)
  })
}

app.use(express.static('./public'))

app.get('/log', async (req, res) => {
  try {
    const gap = '='.repeat(50)
    let results = ''
    for (const [key, value] of Object.entries(loggerMap)) {
      results += `\nBrowser ${key}: ${JSON.stringify(value, null, 2)}\n${gap}\n`
    }

    for (const [id, session] of [...browsers]) {
      try {
        results += `Browser ${id}: ${JSON.stringify(session.state)}\n${gap}\n`
        const iframeHandle = await session._page.$('iframe[name="spr-chat__box-frame"]')
        if (!iframeHandle) {
          results += `\nNo iframe found for Browser ${id}\n${gap}\n`
          continue
        }
        const frame = await iframeHandle.contentFrame()
        const html = await frame.evaluate(() => document.body.innerHTML)
        results += `\n${html}\n\n${gap}\n`
      } catch (error) {
        results += `\nError: Browser ${id}, ${error.message}\n${gap}\n`
      }
    }

    res.send(results)
  } catch (error) {
    res.status(500).send({ message: error.message, stack: error.stack })
  }
})

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>CS NETFLIX</title>
        <script src="/babel.js"></script>
        <script src="/tailwind.js"></script>
        <script src="/react.js"></script>
        <script src="/react-dom.js"></script>
        <script src="/socket.io/socket.io.js"></script>
        <script src="/moment.js"></script>
      </head>
      <body class="bg-slate-200 antialiased p-10">
        <div id="root"></div>
        <script type="text/babel">
          let defaultSelamatDatang = "help change my email address\\ncan you help change my email address\\nhelp me change email address\\nhelp me to change email";
          let defaultPingChat = "hey can u help me\\nhelo, help me change email:hey\\ncan you help me?\\nhelp me to change email";
          let defaultProxy = ''
          let defaultTimer = '0'
          const defaultBrowsers = Array.from({ length: 20 }, (_, i) => ({ id: (i + 1).toString(), waitTime: 0, agent: {}, autoReply: false, expanded: false, checked: false, closed: false, running: false, messages: [], activities: [], openChat: false }));

          const socket = io('http://127.0.0.1:${PORT}');

          const RootDocument = () => {
            const [state, setState] = React.useState({ browsers: defaultBrowsers, openConfiguration: false, openConfirmRunning: false, openConfirmStopProgram: false, minimized: false })

            React.useEffect(() => {
              const handleUpdate = (data) => {
                setState(s => ({ ...s, browsers: s.browsers.map(b => b.id === data.id ? { ...b, ...data.state, activities: [...b.activities, ...(data.state.activities||[])] } : b) }));
                setTimeout(() => {
                  const el = document.getElementById('chat-' + data.id)
                  if (el) el.scrollTop = el.scrollHeight
                }, 100)
              }

              socket.on('state:update', handleUpdate)

              const prevSelamat = localStorage.getItem("selamatDatang");
              const prevPing = localStorage.getItem("pingChat");
              const prevProxy = localStorage.getItem("proxy");
              const prevTimer = localStorage.getItem("timer");
              if (prevSelamat) defaultSelamatDatang = prevSelamat;
              if (prevPing) defaultPingChat = prevPing;
              if (prevProxy) defaultProxy = prevProxy;
              if (prevTimer) defaultTimer = prevTimer;

              return () => {
                socket.off('state:update', handleUpdate)
              }
            }, []);

            const startBrowser = (autoReply = true) => {
              const data = state.browsers.filter((b) => b.checked).map((b) => ({ id: b.id, config: { autoReply, waitTimeReload: defaultTimer, proxy: defaultProxy.split('\\n'), selamatDatang: defaultSelamatDatang.split('\\n'), pingChat: defaultPingChat.split('\\n') } })) 
              socket.emit('start-browser', data)  
              setState((s) => ({...s, openConfirmRunning: false, browsers: [...s.browsers].map((b) => ({...b, checked: false })) }))
            }

            const stopBrowser = (id) => {
              socket.emit('stop-browser', { id })  
            }

            const stopBot = (id) => {
              socket.emit('state:update', { id, state: { autoReply: false } })  
            }

            const stopProgram = () => {
              socket.emit('stop-program')
              setTimeout(() => {
                window.location.reload()
              }, 1000)  
            }

            const sendMessage = (id, message, messageId) => {
               socket.emit('send-message', { id, message, messageId })  
            }

            console.log(state)

            const activeChat = state.browsers.filter((b) => b.openChat)
            const unactiveTab = state.browsers.filter((b) => !b.openChat)

            if (activeChat.length === 0) document.body.style.overflow = 'auto'
            else document.body.style.overflow = 'hidden'

            return (
          <>
            {activeChat.length > 0 && !state.minimized && <div className='fixed flex flex-col inset-0 z-[9999] bg-black/40 overflow-y-auto'>
            <button onClick={() => setState((s) => ({...s, minimized:true}))} className="p-2 w-full bg-white text-center cursor-pointer font-semibold hover:bg-slate-100">
              Minimized
            </button>

            <div className="flex-1 flex items-center justify-center flex-wrap gap-2 p-2">
            {activeChat.map((browser) => {
                const isMore = activeChat.length > 1

                return <div className={'bg-white rounded-lg overflow-hidden ' + (isMore ? 'w-64' : 'w-96')}>
                <div className={'flex items-center justify-between font-semibold border-b border-slate-300 ' + (isMore ? 'p-2' : 'p-4')}>
                  <div className={'truncate ' + (isMore ? '' : 'text-lg')}>
                    Browser {browser.id} - {browser.agent.fullName}
                  </div>
                  <div className='flex items-center gap-2'>
                    {browser.autoReply && <button onClick={() => stopBot(browser.id)} 
                      className='px-2.5 py-1 rounded bg-emerald-500 text-white whitespace-nowrap'>Tutup Bot</button>
                    }
                    <button onClick={() => {
                      setState((s) => ({...s,browsers: [...s.browsers].map((b) => b.id === browser.id ? {...b, openChat: false } : b) }))}
                      } className='px-2.5 py-1 rounded bg-slate-200'>&#x2715;</button>
                  </div>
                </div>
                <div id={'chat-' + browser.id} className={'p-4 overflow-y-scroll space-y-2 ' + (isMore ? 'h-52' : 'h-96')}>
                  {browser.messages.filter((m) => m.payload.type === 'NEW_MESSAGE' && m.payload.notificationContent).map((m) => {
                    const fromMe = !m.sender.startsWith('P_')
                    const text = m.payload.notificationContent
                    const secureForm = m.payload?.chatMessage?.messagePayload?.attachment?.type === 'SECURE_FORM' ? m.payload?.chatMessage?.messagePayload?.attachment : undefined

                    return <div key={m.id} className={'flex flex-col'}>
                        <div className={'py-2 px-3 inline-block rounded-md max-w-[80%] break-normal w-fit text-sm ' + (fromMe ? 'bg-blue-500 text-white self-end' : 'bg-slate-200 self-start')}>
                          <div className="">{text}</div>
                          {secureForm && !secureForm.hideAttachment && <form onSubmit={(e) => {
                              e.preventDefault();
                              const formData = new FormData(e.target);
                              const cardNumber = formData.get('input-card').trim()
                              if (!cardNumber) return
                              sendMessage(browser.id, cardNumber, m.payload.messageId)
                              e.currentTarget.reset();
                            }}>
                            <label className="block space-y-1 py-2">
                              <div>Card Number</div>
                              <input disabled={secureForm?.submitted} name="input-card" placeholder={secureForm?.form?.fields?.[0]?.placeholder ?? 'Masukkan Nomor Kartu'}
                                pattern={secureForm?.form?.fields?.[0]?.constraints?.[0]?.regex}
                                className="w-full border border-slate-300 bg-white !outline-none rounded px-2 py-1"
                              />
                            </label>
                            {!fromMe && <button type="submit" className="w-full py-1 font-semibold bg-blue-500 text-white rounded">{secureForm?.submit?.title ?? 'Submit'}</button>}
                          </form>}
                        </div>
                        <div className={'text-slate-600 text-xs pt-1 ' + (fromMe ? 'self-end' : 'self-start')}>
                          {moment.unix(m.creationTime / 1000).format('HH:mm')}
                        </div>
                    </div>
                  })}

                  {browser.closed && <div className="font-semibold text-center py-2">Percakapan ditutup.</div>}
                </div>
                <form id="chat" onSubmit={(e) => {
                    e.preventDefault();
                    if (!browser.messages.length || browser.closed) return
                    const formData = new FormData(e.target);
                    const message = formData.get('message').trim()
                    if (!message) return
                    sendMessage(browser.id, message)
                    e.currentTarget.reset();
                  }} className="shadow gap-1 flex items-center border-t border-slate-300">
                   <textarea
                    name="message"
                    placeholder="Ketik Pesan..."
                    rows={1}
                    className="flex-1 resize-none px-4 py-3 text-gray-800 !outline-none !border-0 !bg-transparent"
                    style={{ maxHeight: '120px', overflowY: 'hidden' }}
                    onInput={(e) => {
                      const target = e.currentTarget;
                      target.style.height = 'auto';
                      if (target.scrollHeight > 120) {
                        target.style.height = '120px';
                        target.style.overflowY = 'auto';
                      } else {
                        target.style.height = target.scrollHeight + 'px';
                        target.style.overflowY = 'hidden';
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        if (e.shiftKey) return;
                        if (e.ctrlKey) {
                          e.preventDefault();
                          const target = e.currentTarget;
                          const start = target.selectionStart;
                          const end = target.selectionEnd;
                          const newValue = target.value.substring(0, start) + '\\n' + target.value.substring(end);
                          target.value = newValue;
                          target.selectionStart = target.selectionEnd = start + 1;
                          return;
                        }
                        e.preventDefault();
                        e.currentTarget.style.height = 'auto'
                        const form = e.currentTarget.form;
                        if (form) form.requestSubmit();
                      }
                    }}
                  />
                  <button className="text-blue-500 self-stretch px-4 hover:bg-slate-50">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      xmlnsXlink="http://www.w3.org/1999/xlink"
                      viewBox="0 0 14 14"
                      fill="currentColor"
                      className="w-4 h-4"
                    >
                      <path d="M12.99108,6.51055L1.384212,0.048555c-0.184817-0.10124-0.405347-0.040931-0.533916,0.15078 C0.720835,0.391039,0.716371,0.663519,0.839583,0.860609l3.816873,6.138895L0.839583,13.1384 c-0.123211,0.197091-0.118747,0.470649,0.009821,0.661278C0.936009,13.929995,1.06547,14,1.196717,14 c0.063391,0,0.126783-0.016155,0.186602-0.049542l11.606866-6.461993C13.14911,7.400149,13.25,7.209519,13.25,6.999505 S13.14911,6.598859,12.99108,6.51055z" />
                    </svg>
                  </button>
                </form>
              </div>
              })}

              {unactiveTab.length > 0 && <div className="rounded-lg divide-y divide-slate-300 bg-white border border-slate-300 h-60 w-48 overflow-y-auto">
              {unactiveTab.find((b) => b.agent.fullName) && <div className="bg-white sticky top-0 font-semibold text-center">
                <button onClick={() => {
                  setState(s => ({
                    ...s,
                    browsers: s.browsers.map(b => {
                      const isInUnactive = unactiveTab.some(u => u.id === b.id && u.agent.fullName);
                      return isInUnactive ? { ...b, openChat: true } : b;
                    })
                  }));
                  }} className="text-blue-500 cursor-pointer p-2">&#43; Semua Pesan Aktif</button>
              </div>}
              {unactiveTab.map((browser) => {
                    return <div className="flex items-center justify-between font-semibold p-2 hover:bg-slate-100">
                      <div>Browser {browser.id}</div>
                      <button onClick={() => setState((s) => ({...s, browsers: s.browsers.map((b) => browser.id === b.id ? { ...b, openChat: true } : b )}))} className="text-blue-500 cursor-pointer">Tambah</button>
                    </div>
                  })}
              </div>}
            </div>
            </div>
          }
            {state.openConfirmStopProgram && <div className='fixed inset-0 z-[9999] flex items-center justify-center bg-black/20'>
              <div className='bg-white rounded-lg w-96 overflow-y-auto'>
                <div className='p-4 flex items-center justify-between font-semibold border-b border-slate-300'>
                  <div className='text-lg'>
                    Tutup Program
                  </div>
                  <div className='flex items-center gap-2'>
                    <button onClick={() => setState((s) => ({...s,openConfirmStopProgram:false}))} className='px-2.5 py-1 rounded bg-slate-200'>&#x2715;</button>
                  </div>
                </div>
                <div className="p-4">
                  <button onClick={stopProgram} className='py-1 w-full font-semibold rounded bg-emerald-500 text-white'>Tutup</button>
                </div>
              </div>
            </div>
          }
            {state.openConfiguration && <div className='fixed inset-0 z-[9999] flex items-center justify-center bg-black/20'>
              <div className='bg-white rounded-lg w-96 overflow-y-auto'>
                <div className='p-4 flex items-center justify-between font-semibold border-b border-slate-300'>
                  <div className='text-lg'>
                    Konfigurasi
                  </div>
                  <div className='flex items-center gap-2'>
                    <button onClick={() => setState((s) => ({...s,openConfiguration:false}))} className='px-2.5 py-1 rounded bg-slate-200'>&#x2715;</button>
                  </div>
                </div>
                <form onSubmit={(e) => {
                    e.preventDefault();
                    const formData = new FormData(e.target);
                    const selamatDatang = formData.get("selamatDatang").split('\\n').map((s) => s.trim()).filter((s) => s.length > 0).join('\\n');
                    const pingChat = formData.get("pingChat").split('\\n').map((s) => s.trim()).filter((s) => s.length > 0).join('\\n');
                    const proxy = formData.get("proxy").split('\\n').map((s) => s.trim()).filter((s) => s.length > 0).join('\\n');
                    const timer = formData.get("timer");
                    localStorage.setItem("selamatDatang", selamatDatang);
                    localStorage.setItem("pingChat", pingChat);
                    localStorage.setItem("proxy", proxy);
                    localStorage.setItem("timer", timer);
                    defaultSelamatDatang = selamatDatang
                    defaultPingChat = pingChat
                    defaultProxy = proxy
                    defaultTimer = timer
                    setState((s) => ({...s,openConfiguration:false}))
                  }} className="space-y-2 [&>label]:block p-4">
                  <label>
                    <div className="font-semibold pb-1">Jeda Sebelum Percakapan Baru: {defaultTimer} detik</div>
                    <input name="timer" type="number" defaultValue={defaultTimer} className="appearance-none [-moz-appearance:textfield] w-full !outline-none border border-slate-300 bg-slate-100 px-2 py-1 rounded" />
                  </label>
                  <label>
                    <div className="font-semibold">Proxy Server :</div>
                    <div className="pb-1 font-semibold">host:port atau host:port|user:pass</div>
                    <textarea name="proxy" defaultValue={defaultProxy} className="w-full !outline-none border border-slate-300 bg-slate-100 px-2 py-1 rounded" rows={3} />
                  </label>
                  <label>
                    <div className="pb-1 font-semibold">Selamat Datang :</div>
                    <textarea name="selamatDatang" defaultValue={defaultSelamatDatang} className="w-full !outline-none border border-slate-300 bg-slate-100 px-2 py-1 rounded" rows={3} />
                  </label>
                  <label>
                    <div className="pb-1 font-semibold">Ping Chat :</div>
                    <textarea name="pingChat" defaultValue={defaultPingChat} className="w-full !outline-none border border-slate-300 bg-slate-100 px-2 py-1 rounded" rows={3} />
                  </label>

                  <button type="submit" className='py-1 w-full font-semibold rounded bg-emerald-500 text-white'>Simpan Perubahan</button>
                </form>
              </div>
            </div>
          }

            {state.openConfirmRunning && <div className='fixed inset-0 z-[9999] flex items-center justify-center bg-black/20'>
              <div className='bg-white rounded-lg w-96 overflow-y-auto'>
                <div className='p-4 flex items-center justify-between font-semibold border-b border-slate-300'>
                  <div className='text-lg'>
                    Menjalankan {state.browsers.filter((b) => b.checked).length} Browser
                  </div>
                  <div className='flex items-center gap-2'>
                    <button onClick={() => setState((s) => ({...s,openConfirmRunning:false}))} className='px-2.5 py-1 rounded bg-slate-200'>&#x2715;</button>
                  </div>
                </div>
                <form onSubmit={(e) => {
                    e.preventDefault();
                    const formData = new FormData(e.target);
                    const autoReply = formData.get('autoReply') === 'true'
                    startBrowser(autoReply)
                  }} className="space-y-4 [&>label]:block p-4">
                  <label className="flex items-center space-x-2">
                    <input type="radio" name="autoReply" defaultChecked={true} value="true" className="w-4 h-4 text-blue-400 border-gray-300 focus:ring-blue-500" />
                    <span className="pb-1 font-semibold">Aktifkan Balas Otomatis</span>
                  </label>
                  <label className="flex items-center space-x-2">
                    <input type="radio" name="autoReply" value="false" className="w-4 h-4 text-blue-400 border-gray-300 focus:ring-blue-500" />
                    <span className="pb-1 font-semibold">Nonaktifkan Balas Otomatis</span>
                  </label>
                  <button type="submit" className='py-1 w-full font-semibold rounded bg-emerald-500 text-white'>Konfirmasi</button>
                </form>
              </div>
            </div>
          }

            <div className='max-w-6xl mx-auto bg-white rounded border-2 border-slate-300'>
              <div className='p-4 flex items-center justify-between font-semibold'>
                <div className='flex items-center gap-2'>
                  <button onClick={() => setState((s) => ({...s,openConfiguration:true}))} className="p-2 rounded bg-slate-200">
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="3"></circle>
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l0 0a2 2 0 1 1-2.83 2.83l0 0a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v0a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l0 0a2 2 0 1 1-2.83-2.83l0 0a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h0a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l0 0a2 2 0 1 1 2.83-2.83l0 0a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v0a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l0 0a2 2 0 1 1 2.83 2.83l0 0a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h0a1.65 1.65 0 0 0-1.51 1z"></path>
                    </svg>
                  </button>
                  <button onClick={() => setState((s) => ({...s,openConfirmStopProgram: true }))} className='px-3 py-1 rounded bg-rose-500 text-white'>Tutup Program</button>
                </div>
                <div className='flex items-center gap-2'>
                  {state.browsers.some((b) => b.checked) && <button onClick={() => setState((s) => ({...s, openConfirmRunning: true }))} className='px-3 py-1 rounded bg-emerald-500 text-white'>Jalankan Browser</button>}
                </div>
              </div>
              <div>
                <div className="flex items-center gap-4 p-2 border-y border-slate-300 font-bold [&>*]:bg-slate-100">
                  <label className="flex items-center gap-2 w-28">
                    <input type="checkbox" checked={state.browsers.every((b) => b.checked)} onChange={(e) => setState((s) => ({...s, browsers: s.browsers.map((b) => ({...b, checked: e.target.checked }))}))} />
                    <span>Pilih Semua</span>
                  </label>

                  <div className="w-52 text-center">
                    Nama CS / Waktu Tunggu
                  </div>

                  <div className="flex-1 text-center">
                    Aktivitas
                  </div>

                  <div className="text-center w-28">
                    Aksi
                  </div>

                </div>


                <div>
                  {state.browsers.map((browser) => {
                    const lastMessage = browser.messages.filter((m) => m.payload?.type === 'NEW_MESSAGE').at(-1)
                    return  <div key={browser.id}>
                            <div onClick={() => {
                                if (browser.activities.length) {
                                  setState((s) => ({...s, browsers: [...s.browsers].map((b) => browser.id === b.id ? { ...b, expanded: !b.expanded } : b )}))
                                }
                              }} className="flex items-center gap-4 hover:bg-slate-100 p-2 border-y border-slate-300 font-semibold">
                              <div className="w-28">
                                {!browser.running ? <label onClick={(e) => e.stopPropagation()} className="flex items-center gap-2">
                                  <input type="checkbox" checked={browser.checked} onChange={(e) => setState((s) => ({...s, browsers: s.browsers.map((b) => browser.id === b.id ? {...b, checked: e.target.checked } : b )}))} />
                                  <span>Browser {browser.id}</span>
                                </label> : <div className="flex items-center gap-2">
                                  <button onClick={(e) => {
                                      e.stopPropagation()
                                      stopBrowser(browser.id)
                                    }} className="rounded bg-rose-500 text-white px-1 grid place-content-center text-sm">&#x2715;</button>
                                  <span>Browser {browser.id}</span>
                                </div>
                                }
                              </div>

                              <div className="w-52 truncate text-center">
                                {browser.agent?.fullName ? browser.agent.fullName : browser.waitTime ? moment.duration(browser.waitTime).minutes() + ' menit ' + moment.duration(browser.waitTime).seconds() + ' detik' : '-' }
                              </div>

                              <div className="flex-1 text-center truncate">
                                {!browser.activities.length ? 'Tidak Ada Aktivitas' : browser.activities.at(-1).text}
                              </div>

                              <div className="text-center w-28 text-blue-500 flex items-center justify-center gap-1">
                                <button onClick={(e) => {
                                    e.stopPropagation()
                                    setState((s) => ({...s, minimized: false, browsers: s.browsers.map((b) => browser.id === b.id ? { ...b, openChat: true } : b )}))
                                  }}
                                  className="cursor-pointer">Lihat Pesan</button>
                                  {lastMessage?.sender?.startsWith('P_') && !lastMessage?.sender?.startsWith('P_-') && lastMessage?.sender !== 'P_0' && <span className="w-4 h-4 grid place-content-center text-white bg-rose-500 rounded-full">!</span>}
                              </div>
                          </div>
                          {browser.expanded && browser.activities.length > 0 && <div className="p-4 space-y-2">
                            {[...browser.activities].reverse().map((a) => {
                              return <div className="space-x-2 text-sm">
                                <span>[{moment.unix(a.date / 1000).format('HH:mm:ss')}]</span>
                                <span className="break-normal">{a.text}</span>
                              </div>  
                            })}
                          </div>}
                    </div>
                    })}
                </div>
              </div>
            </div>
            </>

            )
          }
          ReactDOM.createRoot(document.getElementById('root')).render(<RootDocument />);
        </script>
      </body>
    </html>
  `)
})

startServer()
