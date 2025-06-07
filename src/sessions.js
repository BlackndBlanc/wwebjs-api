```javascript
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

// تجاهل الرسائل القديمة التي وصلت قبل تشغيل هذه الجلسة
const bootTs = Date.now() / 1000

// Function to validate if the session is ready
const validateSession = async (sessionId) => {
  try {
    const returnData = { success: false, state: null, message: '' }

    // Session not Connected 😢
 if (sessions.has(sessionId)) {
    return {
      success: false,
      message: 'Session already exists for: ' + sessionId,
      client: sessions.get(sessionId),
    };
  }


    const client = sessions.get(sessionId)
    // wait until the client is created
    await waitForNestedObject(client, 'pupPage')
      .catch((err) => { return { success: false, state: null, message: err.message } })

    // Wait for client.pupPage to be evaluable
    let maxRetry = 0
    while (true) {
      try {
        if (client.pupPage.isClosed()) {
          return { success: false, state: null, message: 'browser tab closed' }
        }
        await Promise.race([
          client.pupPage.evaluate('1'),
          new Promise(resolve => setTimeout(resolve, 1000))
        ])
        break
      } catch (error) {
        if (maxRetry === 2) {
          return { success: false, state: null, message: 'session closed' }
        }
        maxRetry++
      }
    }

    const state = await client.getState()
    returnData.state = state
    if (state !== 'CONNECTED') {
      returnData.message = 'session_not_connected'
      return returnData
    }

    // Session Connected 🎉
    returnData.success = true
    returnData.message = 'session_connected'
    return returnData
  } catch (error) {
    logger.error({ sessionId, err: error }, 'Failed to validate session')
    return { success: false, state: null, message: error.message }
  }
}

// Function to handle client session restoration
const restoreSessions = () => {
  try {
    if (!fs.existsSync(sessionFolderPath)) {
      fs.mkdirSync(sessionFolderPath)
    }
    fs.readdir(sessionFolderPath, async (_, files) => {
      for (const file of files) {
        const match = file.match(/^session-(.+)$/)
        if (match) {
          const sessionId = match[1]
          logger.warn({ sessionId }, 'existing session detected')
          await setupSession(sessionId)
        }
      }
    })
  } catch (error) {
    logger.error(error, 'Failed to restore sessions')
  }
}

// Setup Session
const setupSession = async (sessionId) => {
  try {
    if (sessions.has(sessionId)) {
     return { success: false, message: 'Session already exists for: ' + sessionId, client: sessions.get(sessionId) };
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
      const singletonLockPath = path.resolve(path.join(sessionFolderPath, 'session-' + sessionId, 'SingletonLock'));
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

// Initialize all WhatsApp events
const initializeEvents = (client, sessionId) => {
  const sessionWebhook = process.env[sessionId.toUpperCase() + '_WEBHOOK_URL'] || baseWebhookURL

  if (recoverSessions) {
    waitForNestedObject(client, 'pupPage').then(() => {
      const restartSession = async (sessionId) => {
        sessions.delete(sessionId)
        await client.destroy().catch(() => {})
        await setupSession(sessionId)
      }
      client.pupPage.once('close', () => {
        logger.warn({ sessionId }, 'Browser page closed. Restoring')
        restartSession(sessionId)
      })
      client.pupPage.once('error', () => {
        logger.warn({ sessionId }, 'Error occurred on browser page. Restoring')
        restartSession(sessionId)
      })
    }).catch(() => {})
  }

  // auth_failure
  checkIfEventisEnabled('auth_failure').then(() => {
    client.on('auth_failure', (msg) => {
      triggerWebhook(sessionWebhook, sessionId, 'status', { msg })
      triggerWebSocket(sessionId, 'status', { msg })
    })
  })

  // authenticated
  checkIfEventisEnabled('authenticated').then(() => {
    client.qr = null
    client.on('authenticated', () => {
      triggerWebhook(sessionWebhook, sessionId, 'authenticated')
      triggerWebSocket(sessionId, 'authenticated')
    })
  })

  // call
  checkIfEventisEnabled('call').then(() => {
    client.on('call', async (call) => {
      triggerWebhook(sessionWebhook, sessionId, 'call', { call })
      triggerWebSocket(sessionId, 'call', { call })
    })
  })

  // change_state
  checkIfEventisEnabled('change_state').then(() => {
    client.on('change_state', (state) => {
      triggerWebhook(sessionWebhook, sessionId, 'change_state', { state })
      triggerWebSocket(sessionId, 'change_state', { state })
    })
  })

  // disconnected
  checkIfEventisEnabled('disconnected').then(() => {
    client.on('disconnected', (reason) => {
      triggerWebhook(sessionWebhook, sessionId, 'disconnected', { reason })
      triggerWebSocket(sessionId, 'disconnected', { reason })
    })
  })

  // group events, loading_screen, media_uploaded, message, message_ack, message_create (filtered), message_reaction, message_edit, message_ciphertext, message_revoke_everyone, message_revoke_me, qr, ready, contact_changed, chat_removed, chat_archived, unread_count, vote_update... all unchanged except message_create
  // message listener example:
  checkIfEventisEnabled('message').then(() => {
    client.on('message', async (message) => {
      triggerWebhook(sessionWebhook, sessionId, 'message', { message })
      triggerWebSocket(sessionId, 'message', { message })
      if (message.hasMedia && message._data?.size < maxAttachmentSize) {
        checkIfEventisEnabled('media').then(() => {
          message.downloadMedia()
            .then((messageMedia) => {
              triggerWebhook(sessionWebhook, sessionId, 'media', { messageMedia, message })
              triggerWebSocket(sessionId, 'media', { messageMedia, message })
            })
            .catch((error) => {
              logger.error({ sessionId, err: error }, 'Failed to download media')
            })
        })
      }
      if (setMessagesAsSeen) sendMessageSeenStatus(message)
    })
  })

  // message_ack
  checkIfEventisEnabled('message_ack').then(() => {
    client.on('message_ack', async (message, ack) => {
      triggerWebhook(sessionWebhook, sessionId, 'message_ack', { message, ack })
      triggerWebSocket(sessionId, 'message_ack', { message, ack })
      if (setMessagesAsSeen) sendMessageSeenStatus(message)
    })
  })

  // message_create (with filter)
  checkIfEventisEnabled('message_create').then(() => {
    client.on('message_create', async (message) => {
      if (message.id.fromMe) return
      if (!message.isNewMsg || message.timestamp < bootTs) return
      triggerWebhook(sessionWebhook, sessionId, 'message_create', { message })
      triggerWebSocket(sessionId, 'message_create', { message })
      if (setMessagesAsSeen) sendMessageSeenStatus(message)
    })
  })

  // ... other event listeners unchanged ...
}

// Function to delete client session folder
const deleteSessionFolder = async (sessionId) => {
  try {
    const targetDirPath = path.join(sessionFolderPath, `session-${sessionId}`)
    const resolvedTargetDirPath = await fs.promises.realpath(targetDirPath)
    const resolvedSessionPath = await fs.promises.realpath(sessionFolderPath)
    const safeSessionPath = `${resolvedSessionPath}${path.sep}`
    if (!resolvedTargetDirPath.startsWith(safeSessionPath)) {
      throw new Error('Invalid path: Directory traversal detected')
    }
    await fs.promises.rm(resolvedTargetDirPath, { recursive: true, force: true })
  } catch (error) {
    logger.error({ sessionId, err: error }, 'Folder deletion error')
    throw error
  }
}

// Function to reload client session without removing browser cache
const reloadSession = async (sessionId) => {
  try {
    const client = sessions.get(sessionId)
    if (!client) return
    client.pupPage?.removeAllListeners('close')
    client.pupPage?.removeAllListeners('error')
    try {
      const pages = await client.pupBrowser.pages()
      await Promise.all(pages.map(page => page.close()))
      await Promise.race([
        client.pupBrowser.close(),
        new Promise(resolve => setTimeout(resolve, 5000))
      ])
    } catch (e) {
      const childProcess = client.pupBrowser.process()
      if (childProcess) childProcess.kill(9)
    }
    sessions.delete(sessionId)
    await setupSession(sessionId)
  } catch (error) {
    logger.error({ sessionId, err: error }, 'Failed to reload session')
    throw error
  }
}

// Function to delete client session and its folder
const deleteSession = async (sessionId, validation) => {
  try {
    const client = sessions.get(sessionId)
    if (!client) return
    client.pupPage?.removeAllListeners('close')
    client.pupPage?.removeAllListeners('error')
    try {
      await terminateWebSocketServer(sessionId)
    } catch (error) {
      logger.error({ sessionId, err: error }, 'Failed to terminate WebSocket server')
    }
    if (validation.success) {
      logger.info({ sessionId }, 'Logging out session')
      await client.logout()
    } else if (validation.message === 'session_not_connected') {
      logger.info({ sessionId }, 'Destroying session')
      await client.destroy()
    }
    let maxDelay = 0
    while (client.pupBrowser.isConnected() && maxDelay < 10) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      maxDelay++
    }
    sessions.delete(sessionId)
    await deleteSessionFolder(sessionId)
  } catch (error) {
    logger.error({ sessionId, err: error }, 'Failed to delete session')
    throw error
  }
}

// Function to flush sessions
const flushSessions = async (deleteOnlyInactive) => {
  try {
    const files = await fs.promises.readdir(sessionFolderPath)
    for (const file of files) {
      const match = file.match(/^session-(.+)$/)
      if (match) {
        const sessionId = match[1]
        const validation = await validateSession(sessionId)
        if (!deleteOnlyInactive || !validation.success) {
          await deleteSession(sessionId, validation)
        }
      }
    }
  } catch (error) {
    logger.error(error, 'Failed to flush sessions')
    throw error
  }
}

module.exports = {
  sessions,
  setupSession,
  restoreSessions,
  validateSession,
  deleteSession,
  reloadSession,
  flushSessions
}
```
