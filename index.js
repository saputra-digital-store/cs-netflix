import puppeteer from 'puppeteer'
import fs from 'fs/promises'

const height = 720
const width = 500

const id = Date.now()

const random = (arr) => arr[Math.floor(Math.random() * arr.length)]
const delay = (ms = 5000) => new Promise((r) => setTimeout(r, ms))

const state = {
  agent: { userId: '', firstName: '', lastName: '', fullName: '' },
  autoReply: { enable: false, init: false },
  waitTimeTimer: 0,
  debounceMessageTimer: 0,
  messages: [],
}

const browser = await puppeteer.launch({
  headless: false,
  ignoreHTTPSErrors: true,
  defaultViewport: null,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-sync',
    `--window-size=${width},${height}`,
    '--ignore-certificate-errors',
  ],
})

const logger = async (data) => {
  try {
    const d = new Date()
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const formatted = `${yyyy}-${mm}-${dd}`
    const dir = `./log/${formatted}`
    await fs.mkdir(dir, { recursive: true })
    await fs.appendFile(`${dir}/${id}.txt`, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  } catch (error) {
    console.error(error)
  }
}

const getChatFile = async (path) =>
  (await fs.readFile(path, 'utf-8'))
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

try {
  const welcomeTexts = await getChatFile('./selamat-datang.txt')
  const pingChats = await getChatFile('./ping-chat.txt')

  const defaultUrl = `https://help.netflix.com/en/interface/chat?helpText=${random(welcomeTexts)}`

  const [page] = await browser.pages()
  const session = await page.createCDPSession()
  const { windowId } = await session.send('Browser.getWindowForTarget')
  await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })

  await page.goto(defaultUrl, { waitUntil: 'domcontentloaded' })

  const setWindowActive = async () => {
    console.log('window active')
    logger('window active')
    state.autoReply.enable = false
    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal', width, height } })
  }

  const sendMessages = async (messages = []) => {
    for (const message of messages) {
      try {
        const iframeHandle = await page.$('iframe[name="spr-chat__box-frame"]')
        const frame = await iframeHandle.contentFrame()
        const textarea = await frame.waitForSelector('#COMPOSER_ID', { visible: true })
        await textarea.focus()
        await frame.type('#COMPOSER_ID', message)
        const sendBtn = await frame.waitForSelector('[data-testid="Submit"]', { visible: true })
        await sendBtn.click()
      } catch (error) {
        console.error(error)
        logger(error.stack || error.message)
      } finally {
        await delay(2000)
      }
    }
  }

  const handleNewMessage = async (messages = []) => {
    try {
      for (const message of messages) {
        const text = message.payload.notificationContent
        state.messages.push({
          id: message.id,
          text,
          date: message.creationTime,
          sender: message.sender,
        })

        if (!state.autoReply.enable) return

        const patternCheckingMessage = [
          '2 minute',
          'two minute',
          'one minute',
          '1 minute',
          'two-minute',
          'one-minute',
          'next-minute',
        ]

        if (message.sender.startsWith('P_') && !message.sender.startsWith('P_-') && text.endsWith('?')) {
          logger('message endsWith ?')
          await setWindowActive()
          return
        }

        if (
          message.sender.startsWith('P_') &&
          !message.sender.startsWith('P_-') &&
          !text.includes('https://') &&
          (text.includes('email') || text.includes('name'))
        ) {
          logger('message contains email or name')
          await setWindowActive()
          return
        }

        if (
          message.sender.startsWith('P_') &&
          !message.sender.startsWith('P_-') &&
          !patternCheckingMessage.some((p) => text.toLowerCase().includes(p)) &&
          text.length < 100
        ) {
          logger('message leas than 100, not includes pattern cehcking, and not contains https://')
          await setWindowActive()
          return
        }

        if (state.debounceMessageTimer) clearTimeout(state.debounceMessageTimer)

        state.debounceMessageTimer = setTimeout(async () => {
          try {
            if (!state.autoReply.enable) return
            const replyTexts = random(pingChats)
              .split(':')
              .map((t) => t.trim())
              .filter(Boolean)

            const lastMessage = state.messages.at(-1)

            if (lastMessage.sender.startsWith('P_-')) {
              sendMessages(replyTexts)
              return
            }

            if (lastMessage.sender.startsWith('P_') && lastMessage.text.includes('https://')) {
              const templateMessages = state.messages.filter(
                (m) => m.sender.startsWith('P_') && m.text.includes('https://')
              )
              if (templateMessages.length >= 3) {
                logger('conversation failed: https:// 4x')
                browser.close().catch(console.error)
                return
              }
              sendMessages(replyTexts)
              return
            }

            if (
              lastMessage.sender.startsWith('P_') &&
              patternCheckingMessage.some((p) => lastMessage.text.toLowerCase().includes(p))
            ) {
              sendMessages(replyTexts)
              return
            }
          } catch (error) {
            console.error(error)
            logger(error.stack || error.message)
          }
        }, 20_000)
      }
    } catch (error) {
      console.error(error)
      logger(error.stack || error.message)
    }
  }

  page.on('response', async (response) => {
    try {
      const allowedUrl = [
        'https://prod-netflix-live-chat.sprinklr.com/api/livechat/conversation/new', // new chat
        'https://prod-netflix-live-chat.sprinklr.com/api/livechat/conversation/chatUsers', // get active cs
        'https://prod-netflix-live-chat.sprinklr.com/api/livechat/event/fetch-notifications', // new chat update
        'https://prod-netsprinklr.com/api/livechat/conversation/fetch-wait-time-and-queue-positionflix-live-chat.', // wait time
        'https://prod-netflix-live-chat.sprinklr.com/api/livechat/conversation/fetch-wait-time-and-queue-position', // wait time
        'https://survey-app.sprinklr.com/index.html', // survey / chat closed
      ]

      const urlObj = new URL(response.url())
      const baseUrl = urlObj.origin + urlObj.pathname
      if (!allowedUrl.includes(baseUrl)) return

      const buffer = await response.buffer().catch(() => null)
      const data = { url: baseUrl, status: response.status(), body: buffer ? buffer.toString('utf8') : null }

      logger(data)
      console.log(data)
      if (!buffer) return

      let payload

      try {
        payload = JSON.parse(data.body)
      } catch {}

      if (baseUrl === allowedUrl[1]) {
        state.agent = payload[0]
        await page.evaluate((agent) => {
          document.title = `${agent.fullName} - ${document.title}`
        }, state.agent)
      }

      if (baseUrl === allowedUrl[2]) {
        let newMessage = payload.results.filter(
          (r) => r.payload.type === 'NEW_MESSAGE' && r.payload.notificationContent
        )

        if (!state.autoReply.init) {
          const isStartConversation = newMessage.find((m) => m.sender === 'P_-100')
          if (isStartConversation) {
            state.autoReply.init = true
            state.autoReply.enable = true
          }
        }

        if (newMessage.length && state.autoReply.enable) {
          handleNewMessage(newMessage)
        }
      }

      if (baseUrl === allowedUrl[3] || baseUrl === allowedUrl[4]) {
        if (state.waitTimeTimer) clearTimeout(state.waitTimeTimer)
        state.waitTimeTimer = setTimeout(() => {
          if (!state.autoReply.init) {
            logger('auto reply failed')
            browser.close().catch(console.error)
          }
        }, payload.waitTime + 30_000)
      }

      if (baseUrl === allowedUrl[allowedUrl.length - 1]) {
        logger(state.messages)
        logger(state.agent)
        logger(state.autoReply)
        logger('conversation end')
        browser.close().catch(console.error)
      }
    } catch (error) {
      console.error(error)
      logger(error.stack || error.message)
    }
  })

  const buttonChatAgent = await page.waitForSelector('div.chat-actions button.btn.btn-primary', { timeout: 9000000 })
  await buttonChatAgent.click()
} catch (error) {
  console.error(error)
  logger(error.stack || error.message)
  browser.close().catch(console.error)
}
