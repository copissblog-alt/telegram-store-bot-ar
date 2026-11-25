#!/usr/bin/env node
'use strict';
// التشغيل: node bot.js   (أو: node bot.js /path/to/config.json)
const fs = require('node:fs');
const path = require('node:path');
const { createBot } = require('./src/bot');

const file = path.resolve(process.argv[2] || path.join(__dirname, 'config.json'));
if (!fs.existsSync(file)) {
  console.error(`لا يوجد ${file}\nانسخ config.example.json إلى config.json وعدّله.`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!cfg.token || !Array.isArray(cfg.owners) || !cfg.owners.length) {
  console.error('config.json: token و owners مطلوبان.');
  process.exit(1);
}
cfg.db = path.resolve(path.dirname(file), cfg.db || 'data/store.sqlite');

const bot = createBot(cfg);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('إيقاف بعد التحديث الحالي...');
    bot.stop();
  });
}
bot.run().then(() => process.exit(0), (e) => {
  console.error(e.message);
  process.exit(1);
});
