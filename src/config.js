// config.js
const dotenv = require('dotenv');
dotenv.config(); // Load environment variables from .env file

const isTest = process.env.NODE_ENV === 'test';

module.exports = {
  baseWebhookURL: isTest ? 'https://auto.n8blanc.com/webhook-test/whatsapp' : 'https://auto.n8blanc.com/webhook/whatsapp',
  sessionFolderPath: './.wwebjs_auth',
  maxAttachmentSize: 10000000, // 10MB
  setMessagesAsSeen: true,
  webVersion: "2.2412.51",
  webVersionCacheType: "local",
  recoverSessions: true,
  chromeBin: "",
  headless: true,
  releaseBrowserLock: true,
};
