// src/controllers/messageController.js

const axios = require('axios')
const { MessageMedia, Location, Poll } = require('whatsapp-web.js')
const { Readable } = require('stream')
const { sessions } = require('../sessions')
const { sendErrorResponse, decodeBase64 } = require('../utils')
const { baseWebhookURL } = require('../config') // الرابط المختار تلقائيًّا (Test أو Prod)

////////////////////////////////////////////////////////////////////////////////
// دالة مساعدة لإرسال البيانات إلى الـ Webhook
////////////////////////////////////////////////////////////////////////////////
const sendWebhook = async (dataType, payload) => {
  if (!baseWebhookURL) {
    // إذا لم يُعرف الرابط في المتغيرات، نتجاهل الإرسال
    return
  }

  try {
    await axios.post(baseWebhookURL, {
      dataType,
      data: payload
    })
    console.log('✅ Webhook sent to:', baseWebhookURL, 'dataType:', dataType)
  } catch (error) {
    console.error('❌ Failed to send webhook:', error.message)
  }
}

////////////////////////////////////////////////////////////////////////////////
// دالة داخلية للعثور على رسالة بناءً على ID
////////////////////////////////////////////////////////////////////////////////
const _getMessageById = async (client, messageId, chatId) => {
  const chat = await client.getChatById(chatId)
  const messages = await chat.fetchMessages({ limit: 100 })
  return messages.find((message) => {
    return message.id.id === messageId
  })
}

////////////////////////////////////////////////////////////////////////////////
// يُعيد معلومات عن رسالة (يُستخدم بالـ POST /message/getClassInfo/:sessionId)
////////////////////////////////////////////////////////////////////////////////
const getClassInfo = async (req, res) => {
  /*
    #swagger.summary = 'Get message'
  */
  try {
    const { messageId, chatId } = req.body
    const client = sessions.get(req.params.sessionId)
    const message = await _getMessageById(client, messageId, chatId)
    if (!message) {
      throw new Error('Message not found')
    }
    res.json({ success: true, message })
  } catch (error) {
    sendErrorResponse(res, 500, error.message)
  }
}

////////////////////////////////////////////////////////////////////////////////
// حذف رسالة (يُستخدم بالـ POST /message/delete/:sessionId)
////////////////////////////////////////////////////////////////////////////////
const deleteMessage = async (req, res) => {
  /*
    #swagger.summary = 'Delete a message from the chat'
    #swagger.requestBody = {
      required: true,
      schema: {
        type: 'object',
        properties: {
          chatId: { type: 'string', example: '6281288888888@c.us' },
          messageId: { type: 'string', example: 'ABCDEF999999999' },
          everyone: { type: 'boolean', example: true },
          clearMedia: { type: 'boolean', example: true }
        }
      }
    }
  */
  try {
    const { messageId, chatId, everyone, clearMedia = true } = req.body
    const client = sessions.get(req.params.sessionId)
    const message = await _getMessageById(client, messageId, chatId)
    if (!message) {
      throw new Error('Message not found')
    }
    const result = await message.delete(everyone, clearMedia)
    res.json({ success: true, result })
    // ────────────────────────────────────────────────────────────────────────────
    // إرسال إشعار إلى الـ Webhook (نوع dataType = 'message_delete')
    // ────────────────────────────────────────────────────────────────────────────
    await sendWebhook('message_delete', {
      sessionId: req.params.sessionId,
      chatId,
      messageId,
      deletedForEveryone: everyone
    })
  } catch (error) {
    sendErrorResponse(res, 500, error.message)
  }
}

////////////////////////////////////////////////////////////////////////////////
// تحميل وسائط مرتبطة برسالة (يُستخدم بالـ POST /message/downloadMedia/:sessionId)
////////////////////////////////////////////////////////////////////////////////
const downloadMedia = async (req, res) => {
  /*
    #swagger.summary = 'Download attached message media'
  */
  try {
    const { messageId, chatId } = req.body
    const client = sessions.get(req.params.sessionId)
    const message = await _getMessageById(client, messageId, chatId)
    if (!message) {
      throw new Error('Message not found')
    }
    if (!message.hasMedia) {
      throw new Error('Message media not found')
    }
    const messageMedia = await message.downloadMedia()
    res.json({ success: true, messageMedia })

    // ────────────────────────────────────────────────────────────────────────────
    // إرسال إشعار إلى الـ Webhook (نوع dataType = 'message_download_media')
    // ────────────────────────────────────────────────────────────────────────────
    await sendWebhook('message_download_media', {
      sessionId: req.params.sessionId,
      chatId,
      messageId,
      mediaInfo: {
        mimetype: messageMedia.mimetype,
        filename: messageMedia.filename,
        size: messageMedia.data.length
      }
    })
  } catch (error) {
    sendErrorResponse(res, 500, error.message)
  }
}

////////////////////////////////////////////////////////////////////////////////
// تحميل وسائط كبيانات ثنائية (Binary) (يُستخدم بالـ POST /message/downloadMediaAsData/:sessionId)
////////////////////////////////////////////////////////////////////////////////
const downloadMediaAsData = async (req, res) => {
  /*
    #swagger.summary = 'Download attached message media as binary data'
  */
  try {
    const { messageId, chatId } = req.body
    const client = sessions.get(req.params.sessionId)
    const message = await _getMessageById(client, messageId, chatId)
    if (!message) {
      throw new Error('Message not found')
    }
    if (!message.hasMedia) {
      throw new Error('Message media not found')
    }
    const { data, mimetype, filename, filesize } = await message.downloadMedia()
    /* #swagger.responses[200] = { description: 'Binary data.' } */
    res.writeHead(200, {
      ...(mimetype && { 'Content-Type': mimetype }),
      ...(filesize && { 'Content-Length': filesize }),
      ...(filename && { 'Content-Disposition': `attachment; filename=${encodeURIComponent(filename)}` })
    })
    const readableStream = new Readable({
      read() {
        for (const chunk of decodeBase64(data)) {
          this.push(chunk)
        }
        this.push(null)
      }
    })
    readableStream.on('end', () => {
      res.end()
    })
    readableStream.pipe(res)

    // ────────────────────────────────────────────────────────────────────────────
    // إرسال إشعار إلى الـ Webhook (نوع dataType = 'message_download_as_data')
    // ────────────────────────────────────────────────────────────────────────────
    await sendWebhook('message_download_as_data', {
      sessionId: req.params.sessionId,
      chatId,
      messageId,
      filename
    })
  } catch (error) {
    sendErrorResponse(res, 500, error.message)
  }
}

////////////////////////////////////////////////////////////////////////////////
// إعادة توجيه رسالة (يُستخدم بالـ POST /message/forward/:sessionId)
////////////////////////////////////////////////////////////////////////////////
const forward = async (req, res) => {
  /*
    #swagger.summary = 'Forward a message to another chat'
    #swagger.requestBody = {
      required: true,
      schema: {
        type: 'object',
        properties: {
          chatId: { type: 'string', example: '6281288888888@c.us' },
          messageId: { type: 'string', example: 'ABCDEF999999999' },
          destinationChatId: { type: 'string', example: '6281288888889@c.us' }
        }
      }
    }
  */
  try {
    const { messageId, chatId, destinationChatId } = req.body
    const client = sessions.get(req.params.sessionId)
    const message = await _getMessageById(client, messageId, chatId)
    if (!message) {
      throw new Error('Message not found')
    }
    const result = await message.forward(destinationChatId)
    res.json({ success: true, result })

    // ────────────────────────────────────────────────────────────────────────────
    // إرسال إشعار إلى الـ Webhook (نوع dataType = 'message_forward')
    // ────────────────────────────────────────────────────────────────────────────
    await sendWebhook('message_forward', {
      sessionId: req.params.sessionId,
      chatId,
      messageId,
      destinationChatId
    })
  } catch (error) {
    sendErrorResponse(res, 500, error.message)
  }
}

////////////////////////////////////////////////////////////////////////////////
// الحصول على معلومات وصول الرسالة (يُستخدم بالـ POST /message/getInfo/:sessionId)
////////////////////////////////////////////////////////////////////////////////
const getInfo = async (req, res) => {
  /*
    #swagger.summary = 'Get information about message delivery status'
    #swagger.description = 'May return null if the message does not exist or is not sent by you.'
  */
  try {
    const { messageId, chatId } = req.body
    const client = sessions.get(req.params.sessionId)
    const message = await _getMessageById(client, messageId, chatId)
    if (!message) {
      throw new Error('Message not found')
    }
    const info = await message.getInfo()
    res.json({ success: true, info })

    // ────────────────────────────────────────────────────────────────────────────
    // إرسال إشعار إلى الـ Webhook (نوع dataType = 'message_info')
    // ────────────────────────────────────────────────────────────────────────────
    await sendWebhook('message_info', {
      sessionId: req.params.sessionId,
      chatId,
      messageId,
      info
    })
  } catch (error) {
    sendErrorResponse(res, 500, error.message)
  }
}

////////////////////////////////////////////////////////////////////////////////
// الحصول على قائمة من جهات الاتصال المذكورة في رسالة (يُستخدم بالـ POST /message/getMentions/:sessionId)
////////////////////////////////////////////////////////////////////////////////
const getMentions = async (req, res) => {
  /*
    #swagger.summary = 'Get the contacts mentioned'
  */
  try {
    const { messageId, chatId } = req.body
    const client = sessions.get(req.params.sessionId)
    const message = await _getMessageById(client, messageId, chatId)
    if (!message) {
      throw new Error('Message not found')
    }
    const contacts = await message.getMentions()
    res.json({ success: true, contacts })

    // ────────────────────────────────────────────────────────────────────────────
    // إرسال إشعار إلى الـ Webhook (نوع dataType = 'message_mentions')
    // ────────────────────────────────────────────────────────────────────────────
    await sendWebhook('message_mentions', {
      sessionId: req.params.sessionId,
      chatId,
      messageId,
      mentions: contacts.map(c => c.id._serialized)
    })
  } catch (error) {
    sendErrorResponse(res, 500, error.message)
  }
}

////////////////////////////////////////////////////////////////////////////////
// الحصول على معلومات أمر داخل رسالة (يُستخدم بالـ POST /message/getOrder/:sessionId)
////////////////////////////////////////////////////////////////////////////////
const getOrder = async (req, res) => {
  /*
    #swagger.summary = 'Get the order details'
  */
  try {
    const { messageId, chatId } = req.body
    const client = sessions.get(req.params.sessionId)
    const message = await _getMessageById(client, messageId, chatId)
    if (!message) {
      throw new Error('Message not found')
    }
    const order = await message.getOrder()
    res.json({ success: true, order })

    // ────────────────────────────────────────────────────────────────────────────
    // إرسال إشعار إلى الـ Webhook (نوع dataType = 'message_order')
    // ────────────────────────────────────────────────────────────────────────────
    await sendWebhook('message_order', {
      sessionId: req.params.sessionId,
      chatId,
      messageId,
      order
    })
  } catch (error) {
    sendErrorResponse(res, 500, error.message)
  }
}

////////////////////////////////////////////////////////////////////////////////
// الحصول على معلومات الدفع داخل رسالة (يُستخدم بالـ POST /message/getPayment/:sessionId)
////////////////////////////////////////////////////////////////////////////////
const getPayment = async (req, res) => {
  /*
    #swagger.summary = 'Get the payment details'
  */
  try {
    const { messageId, chatId } = req.body
    const client = sessions.get(req.params.sessionId)
    const message = await _getMessageById(client, messageId, chatId)
    if (!message) {
      throw new Error('Message not found')
    }
    const payment = await message.getPayment()
    res.json({ success: true, payment })

    // ────────────────────────────────────────────────────────────────────────────
    // إرسال إشعار إلى الـ Webhook (نوع dataType = 'message_payment')
    // ────────────────────────────────────────────────────────────────────────────
    await sendWebhook('message_payment', {
      sessionId: req.params.sessionId,
      chatId,
      messageId,
      payment
    })
  } catch (error) {
    sendErrorResponse(res, 500, error.message)
  }
}

////////////////////////////////////////////////////////////////////////////////
// الحصول على الرسالة المنقولة (Quoted) داخل رسالة (يُستخدم بالـ POST /message/getQuotedMessage/:sessionId)
////////////////////////////////////////////////////////////////////////////////
const getQuotedMessage = async (req, res) => {
  /*
    #swagger.summary = 'Get the quoted message'
  */
  try {
    const { messageId, chatId } = req.body
    const client = sessions.get(req.params.sessionId)
    const message = await _getMessageById(client, messageId, chatId)
    if (!message) {
      throw new Error('Message not found')
    }
    const quotedMessage = await message.getQuotedMessage()
    res.json({ success: true, quotedMessage })

    // ────────────────────────────────────────────────────────────────────────────
    // إرسال إشعار إلى الـ Webhook (نوع dataType = 'message_quoted')
    // ────────────────────────────────────────────────────────────────────────────
    await sendWebhook('message_quoted', {
      sessionId: req.params.sessionId,
      chatId,
      messageId,
      quotedMessage
    })
  } catch (error) {
    sendErrorResponse(res, 500, error.message)
  }
}

////////////////////////////////////////////////////////////////////////////////
// الإعجاب (React) برسالة (يُستخدم بالـ POST /message/react/:sessionId)
////////////////////////////////////////////////////////////////////////////////
const react = async (req, res) => {
  /*
    #swagger.summary = 'React with an emoji'
  */
  try {
    const { messageId, chatId, reaction = '' } = req.body
    const client = sessions.get(req.params.sessionId)
    const message = await _getMessageById(client, messageId, chatId)
    if (!message) {
      throw new Error('Message not found')
    }
    const result = await message.react(reaction)
    res.json({ success: true, result })

    // ────────────────────────────────────────────────────────────────────────────
    // إرسال إشعار إلى الـ Webhook (نوع dataType = 'message_react')
    // ────────────────────────────────────────────────────────────────────────────
    await sendWebhook('message_react', {
      sessionId: req.params.sessionId,
      chatId,
      messageId,
      reaction
    })
  } catch (error) {
    sendErrorResponse(res, 500, error.message)
  }
}

////////////////////////////////////////////////////////////////////////////////
// الرد على رسالة (Reply) (يُستخدم بالـ POST /message/reply/:sessionId)
////////////////////////////////////////////////////////////////////////////////
const reply = async (req, res) => {
  /*
    #swagger.summary = 'Send a message as a reply'
  */
  try {
    const { messageId, chatId, content, contentType, options } = req.body
    const client = sessions.get(req.params.sessionId)
    const message = await _getMessageById(client, messageId, chatId)
    if (!message) {
      throw new Error('Message not found')
    }

    let contentMessage
    switch (contentType) {
      case 'string':
        if (options?.media) {
          const media = options.media
          media.filename = null
          media.filesize = null
          options.media = new MessageMedia(media.mimetype, media.data, media.filename, media.filesize)
        }
        contentMessage = content
        break
      case 'MessageMediaFromURL':
        contentMessage = await MessageMedia.fromUrl(content, { unsafeMime: true })
        break
      case 'MessageMedia':
        contentMessage = new MessageMedia(content.mimetype, content.data, content.filename, content.filesize)
        break
      case 'Location':
        contentMessage = new Location(content.latitude, content.longitude, content.description)
        break
      case 'Contact': {
        const contactId = content.contactId.endsWith('@c.us')
          ? content.contactId
          : `${content.contactId}@c.us`
        contentMessage = await client.getContactById(contactId)
        break
      }
      case 'Poll':
        contentMessage = new Poll(content.pollName, content.pollOptions, content.options)
        // إصلاح عدم ظهور أحداث الاستطلاع (فتح الدردشة بعد إرسال الاستطلاع)
        await client.interface.openChatWindow(chatId)
        break
      default:
        return sendErrorResponse(res, 400, 'Invalid contentType')
    }

    const repliedMessage = await message.reply(contentMessage, chatId, options)
    res.json({ success: true, repliedMessage })

    // ────────────────────────────────────────────────────────────────────────────
    // إرسال إشعار إلى الـ Webhook (نوع dataType = 'message_reply')
    // ────────────────────────────────────────────────────────────────────────────
    await sendWebhook('message_reply', {
      sessionId: req.params.sessionId,
      chatId,
      messageId,
      contentType,
      content,
      options: !!options
    })
  } catch (error) {
    sendErrorResponse(res, 500, error.message)
  }
}

////////////////////////////////////////////////////////////////////////////////
// تمييز الرسالة (Star) (يُستخدم بالـ POST /message/star/:sessionId)
////////////////////////////////////////////////////////////////////////////////
const star = async (req, res) => {
  /*
    #swagger.summary = 'Star the message'
  */
  try {
    const { messageId, chatId } = req.body
    const client = sessions.get(req.params.sessionId)
    const message = await _getMessageById(client, messageId, chatId)
    if (!message) {
      throw new Error('Message not found')
    }
    const result = await message.star()
    res.json({ success: true, result })

    // ────────────────────────────────────────────────────────────────────────────
    // إرسال إشعار إلى الـ Webhook (نوع dataType = 'message_star')
    // ────────────────────────────────────────────────────────────────────────────
    await sendWebhook('message_star', {
      sessionId: req.params.sessionId,
      chatId,
      messageId
    })
  } catch (error) {
    sendErrorResponse(res, 500, error.message)
  }
}

////////////////////////////////////////////////////////////////////////////////
// إزالة تمييز الرسالة (Unstar) (يُستخدم بالـ POST /message/unstar/:sessionId)
////////////////////////////////////////////////////////////////////////////////
const unstar = async (req, res) => {
  /*
    #swagger.summary = 'Unstar the message'
  */
  try {
    const { messageId, chatId } = req.body
    const client = sessions.get(req.params.sessionId)
    const message = await _getMessageById(client, messageId, chatId)
    if (!message) {
      throw new Error('Message not found')
    }
    const result = await message.unstar()
    res.json({ success: true, result })

    // ────────────────────────────────────────────────────────────────────────────
    // إرسال إشعار إلى الـ Webhook (نوع dataType = 'message_unstar')
    // ────────────────────────────────────────────────────────────────────────────
    await sendWebhook('message_unstar', {
      sessionId: req.params.sessionId,
      chatId,
      messageId
    })
  } catch (error) {
    sendErrorResponse(res, 500, error.message)
  }
}

////////////////////////////////////////////////////////////////////////////////
// الحصول على ردود الفعل (Reactions) (يُستخدم بالـ POST /message/getReactions/:sessionId)
////////////////////////////////////////////////////////////////////////////////
const getReactions = async (req, res) => {
  /*
    #swagger.summary = 'Get the reactions associated'
  */
  try {
    const { messageId, chatId } = req.body
    const client = sessions.get(req.params.sessionId)
    const message = await _getMessageById(client, messageId, chatId)
    if (!message) {
      throw new Error('Message not found')
    }
    const result = await message.getReactions()
    res.json({ success: true, result })

    // ────────────────────────────────────────────────────────────────────────────
    // إرسال إشعار إلى الـ Webhook (نوع dataType = 'message_reactions')
    // ────────────────────────────────────────────────────────────────────────────
    await sendWebhook('message_reactions', {
      sessionId: req.params.sessionId,
      chatId,
      messageId,
      reactions: result
    })
  } catch (error) {
    sendErrorResponse(res, 500, error.message)
  }
}

////////////////////////////////////////////////////////////////////////////////
// الحصول على مجموعات تم ذكرها في الرسالة (Group Mentions) (يُستخدم بالـ POST /message/getGroupMentions/:sessionId)
////////////////////////////////////////////////////////////////////////////////
const getGroupMentions = async (req, res) => {
  /*
    #swagger.summary = 'Get groups mentioned in this message'
  */
  try {
    const { messageId, chatId } = req.body
    const client = sessions.get(req.params.sessionId)
    const message = await _getMessageById(client, messageId, chatId)
    if (!message) {
      throw new Error('Message not found')
    }
    const result = await message.getGroupMentions()
    res.json({ success: true, result })

    // ────────────────────────────────────────────────────────────────────────────
    // إرسال إشعار إلى الـ Webhook (نوع dataType = 'message_group_mentions')
    // ────────────────────────────────────────────────────────────────────────────
    await sendWebhook('message_group_mentions', {
      sessionId: req.params.sessionId,
      chatId,
      messageId,
      groups: result.map(g => g.id._serialized)
    })
  } catch (error) {
    sendErrorResponse(res, 500, error.message)
  }
}

////////////////////////////////////////////////////////////////////////////////
// تعديل رسالة (Edit) (يُستخدم بالـ POST /message/edit/:sessionId)
////////////////////////////////////////////////////////////////////////////////
const edit = async (req, res) => {
  /*
    #swagger.summary = 'Edit the message'
    #swagger.requestBody = {
      required: true,
      schema: {
        type: 'object',
        properties: {
          chatId: { type: 'string', example: '6281288888888@c.us' },
          messageId: { type: 'string', example: 'ABCDEF999999999' },
          content: { type: 'string' },
          options: { type: 'object' }
        }
      }
    }
  */
  try {
    const { messageId, chatId, content, options } = req.body
    const client = sessions.get(req.params.sessionId)
    const message = await _getMessageById(client, messageId, chatId)
    if (!message) {
      throw new Error('Message not found')
    }
    const editedMessage = await message.edit(content, options)
    res.json({ success: true, message: editedMessage })

    // ────────────────────────────────────────────────────────────────────────────
    // إرسال إشعار إلى الـ Webhook (نوع dataType = 'message_edit')
    // ────────────────────────────────────────────────────────────────────────────
    await sendWebhook('message_edit', {
      sessionId: req.params.sessionId,
      chatId,
      messageId,
      newContent: content
    })
  } catch (error) {
    sendErrorResponse(res, 500, error.message)
  }
}

////////////////////////////////////////////////////////////////////////////////
// الحصول على معلومات جهة الاتصال من داخل رسالة (يُستخدم بالـ POST /message/getContact/:sessionId)
////////////////////////////////////////////////////////////////////////////////
const getContact = async (req, res) => {
  /*
    #swagger.summary = 'Get the contact'
  */
  try {
    const { messageId, chatId } = req.body
    const client = sessions.get(req.params.sessionId)
    const message = await _getMessageById(client, messageId, chatId)
    if (!message) {
      throw new Error('Message not found')
    }
    const contact = await message.getContact()
    res.json({ success: true, contact })

    // ────────────────────────────────────────────────────────────────────────────
    // إرسال إشعار إلى الـ Webhook (نوع dataType = 'message_contact')
    // ────────────────────────────────────────────────────────────────────────────
    await sendWebhook('message_contact', {
      sessionId: req.params.sessionId,
      chatId,
      messageId,
      contact: contact.id._serialized
    })
  } catch (error) {
    sendErrorResponse(res, 500, error.message)
  }
}

////////////////////////////////////////////////////////////////////////////////
// إرسال رسالة جديدة (يُستخدم بالـ POST /message/send/:sessionId)
// هنا نضيف استدعاء sendWebhook ليرسل إشعارًا عند كل رسالة جديدة
////////////////////////////////////////////////////////////////////////////////
const sendMessage = async (req, res) => {
  const { sessionId, phone, message } = req.body

  const session = sessions.get(sessionId)
  if (!session) {
    return res.status(404).json({ success: false, message: 'Session not found' })
  }

  try {
    const sentMessage = await session.sendMessage(`${phone}@c.us`, message)
    res.json({ success: true, message: sentMessage })

    // ────────────────────────────────────────────────────────────────────────────
    // بعد نجاح إرسال الرسالة، نرسل بياناتها إلى الـ Webhook
    // ────────────────────────────────────────────────────────────────────────────
    await sendWebhook('message_send', {
      sessionId,
      to: `${phone}@c.us`,
      content: message,
      messageId: sentMessage.id._serialized
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

module.exports = {
  getClassInfo,
  deleteMessage,
  downloadMedia,
  downloadMediaAsData,
  forward,
  getInfo,
  getMentions,
  getOrder,
  getPayment,
  getQuotedMessage,
  react,
  reply,
  star,
  unstar,
  getReactions,
  getGroupMentions,
  edit,
  getContact,
  sendMessage
}
