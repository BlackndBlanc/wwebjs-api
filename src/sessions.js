// ✅ تم تعديل الكود لإزالة جميع أخطاء `SyntaxError: Unexpected identifier`
// وتم تعويض كل `template literals` ب concatenation باستخدام +

const { Client, LocalAuth } = require('whatsapp-web.js')
const fs = require('fs')
const path = require('path')
const sessions = new Map()
const {
  baseWebhookURL,
  sessionFolderPath,
  maxAttachmentSize,
  setMessagesAsSeen,
  webVersion,
  webVersionCacheType,
  recoverSessions,
  chromeBin,
  headless,
  releaseBrowserLock
} = require('./config')
const {
  triggerWebhook,
  waitForNestedObject,
  checkIfEventisEnabled,
  sendMessageSeenStatus
} = require('./utils')
const { logger } = require('./logger')
const {
  initWebSocketServer,
  terminateWebSocketServer,
  triggerWebSocket
} = require('./websocket')

// 👇 تصحيح السطر الخطأ الذي يسبب crash عند إنشاء جلسة موجودة مسبقًا
const setupSession = async (sessionId) => {
  try {
    if (sessions.has(sessionId)) {
      return {
        success: false,
        message: 'Session already exists for: ' + sessionId,
        client: sessions.get(sessionId)
      }
    }

    const localAuth = new LocalAuth({ clientId: sessionId, dataPath: sessionFolderPath })
    delete localAuth.logout
    localAuth.logout = () => {}

    const clientOptions = {
      puppeteer: {
        executablePath: chromeBin,
        headless,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
      },
      authStrategy: localAuth
    }

    if (webVersion) {
      clientOptions.webVersion = webVersion
      switch (webVersionCacheType.toLowerCase()) {
        case 'local':
          clientOptions.webVersionCache = { type: 'local' }
          break
        case 'remote':
          clientOptions.webVersionCache = {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/' + webVersion + '.html'
          }
          break
        default:
          clientOptions.webVersionCache = { type: 'none' }
      }
    }

    const client = new Client(clientOptions)

    if (releaseBrowserLock) {
      const singletonLockPath = path.resolve(path.join(sessionFolderPath, 'session-' + sessionId, 'SingletonLock'))
      const singletonLockExists = await fs.promises.lstat(singletonLockPath).then(() => true).catch(() => false)
      if (singletonLockExists) {
        logger.warn({ sessionId }, 'Browser lock file exists, removing')
        await fs.promises.unlink(singletonLockPath)
      }
    }

    try {
      await client.initialize()
    } catch (error) {
      logger.error({ sessionId, err: error }, 'Initialize error')
      throw error
    }

    initWebSocketServer(sessionId)
    initializeEvents(client, sessionId)

    sessions.set(sessionId, client)
    return { success: true, message: 'Session initiated successfully', client }
  } catch (error) {
    return { success: false, message: error.message, client: null }
  }
}

// ✅ تصحيح استخدام sessionId في هذا السطر أيضًا (في deleteSessionFolder):
const deleteSessionFolder = async (sessionId) => {
  try {
    const targetDirPath = path.join(sessionFolderPath, 'session-' + sessionId)
    const resolvedTargetDirPath = await fs.promises.realpath(targetDirPath)
    const resolvedSessionPath = await fs.promises.realpath(sessionFolderPath)
    const safeSessionPath = resolvedSessionPath + path.sep

    if (!resolvedTargetDirPath.startsWith(safeSessionPath)) {
      throw new Error('Invalid path: Directory traversal detected')
    }
    await fs.promises.rm(resolvedTargetDirPath, { recursive: true, force: true })
  } catch (error) {
    logger.error({ sessionId, err: error }, 'Folder deletion error')
    throw error
  }
}

// باقي الكود غير متأثر بالأخطاء ويُحتفظ به كما هو
// أضف هذا الملف إلى مشروعك واستبدل الجزء الموجود بداخله بالتصحيحات أعلاه فقط

module.exports = {
  sessions,
  setupSession,
  restoreSessions,
  validateSession,
  deleteSession,
  reloadSession,
  flushSessions
}
