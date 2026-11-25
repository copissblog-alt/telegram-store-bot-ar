'use strict';
// التشغيل: npm test   (أو: node --test)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { fakeTelegram } = require('./fake-telegram');
const { createBot } = require('../src/bot');
const { parsePrice, money, normalizePhone } = require('../src/ui');

const OWNER = { id: 500, first_name: 'المالك' };
const SARA = { id: 701, first_name: 'سارة', username: 'sara' };
const ALI = { id: 702, first_name: 'علي' };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'store-bot-'));
let tg, bot, cfg;

const texts = (calls) => calls.map((c) => c.params.text || c.params.caption || '').join('\n---\n');
const find = (calls, method) => calls.filter((c) => c.method === method);
const buttons = (call) => (call?.params.reply_markup?.inline_keyboard || []).flat().map((b) => b.callback_data);
const last = (calls, method) => find(calls, method).at(-1);
async function step() {
  await bot.pollOnce(0);
  return tg.take();
}

test.before(async () => {
  tg = fakeTelegram();
  const api = await tg.listen();
  cfg = { token: '1:T', api, owners: [OWNER.id], store_name: 'متجر الاختبار', currency: 'ريال', delivery_fee: 15, min_order: 50, payment_note: 'الدفع عند الاستلام', db: path.join(tmp, 'store.sqlite') };
  bot = createBot(cfg, () => {});
});
test.after(async () => {
  bot.db.close();
  await tg.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('prices and phones: Arabic digits and decimal comma', () => {
  assert.equal(parsePrice('١٨٠'), 18000);
  assert.equal(parsePrice('12٫5'), 1250);
  assert.equal(parsePrice('12.555'), null);
  assert.equal(money(1500, 'ريال'), '15 ريال');
  assert.equal(money(1250, 'ريال'), '12.50 ريال');
  assert.equal(normalizePhone('٠٥٥١٢٣٤٥٦٧'), '966551234567');
  assert.equal(normalizePhone('+966 55 123 4567'), '966551234567');
  assert.equal(normalizePhone('12345'), null);
});

test('/start shows the store menu', async () => {
  tg.msg(SARA, '/start');
  const c = await step();
  assert.match(texts(c), /متجر الاختبار/);
  assert.deepEqual(buttons(c[0]), ['cats', 'cart', 'my']);
});

test('owner adds products by photo caption and by /add; bad line gets the format', async () => {
  tg.msg(OWNER, null, { photo: [{ file_id: 'small' }, { file_id: 'PHOTO_BIG' }], caption: 'عسل سدر | ١٨٠ | العسل | من جبال الجنوب | 3' });
  tg.msg(OWNER, '/add عسل سمر | 120 | العسل');
  tg.msg(OWNER, '/add تمر سكري | 45٫5 | التمور | | -');
  tg.msg(OWNER, null, { photo: [{ file_id: 'x' }], caption: 'بلا سعر' });
  let c = await step();
  assert.match(texts(c), /أُضيف المنتج رقم 1/);
  assert.match(texts(c), /أُضيف المنتج رقم 3/);
  assert.match(texts(c), /لم أفهم المنتج/);
  const p = bot.db.prepare('SELECT * FROM products WHERE id = 1').get();
  assert.equal(p.photo, 'PHOTO_BIG');
  assert.equal(p.price, 18000);
  assert.equal(p.stock, 3);
  tg.msg(SARA, '/add hack | 1 | x');
  c = await step();
  assert.equal(bot.db.prepare('SELECT COUNT(*) n FROM products').get().n, 3, 'customers cannot add products');
});

test('catalog: categories, product list, photo card', async () => {
  tg.tap(SARA, 'cats');
  let c = await step();
  assert.deepEqual(buttons(last(c, 'editMessageText')).slice(0, 2).sort(), ['c:1:0', 'c:2:0']);
  tg.tap(SARA, 'c:1:0');
  c = await step();
  assert.match(JSON.stringify(last(c, 'editMessageText').params.reply_markup), /عسل سدر · 180 ريال/);
  tg.tap(SARA, 'p:1', { message_id: 9 });
  c = await step();
  assert.ok(find(c, 'deleteMessage').length && last(c, 'sendPhoto').params.photo === 'PHOTO_BIG', 'photo product -> sendPhoto with file_id');
  assert.match(last(c, 'sendPhoto').params.caption, /بقي 3 فقط/);
});

test('cart: add, stock limit, +/- and totals with delivery', async () => {
  for (let i = 0; i < 4; i++) tg.tap(SARA, 'add:1', { message_id: 20, photo: [{}] });
  let c = await step();
  const answers = find(c, 'answerCallbackQuery').map((a) => a.params.text);
  assert.deepEqual(answers.slice(0, 3), ['أُضيف ✓ — في سلتك منه 1', 'أُضيف ✓ — في سلتك منه 2', 'أُضيف ✓ — في سلتك منه 3']);
  assert.equal(answers[3], 'المتاح 3 فقط');
  assert.ok(find(c, 'editMessageReplyMarkup').length, 'cart count updated on the product card');
  tg.tap(SARA, 'dec:1');
  tg.tap(SARA, 'add:3');
  tg.tap(SARA, 'cart', { message_id: 30 });
  c = await step();
  const t = last(c, 'editMessageText').params.text;
  assert.match(t, /عسل سدر × 2 = 360 ريال/);
  assert.match(t, /تمر سكري × 1 = 45.50 ريال/);
  assert.match(t, /الإجمالي: <b>420.50 ريال<\/b>/);
});

test('checkout: name button, contact of someone else refused, Arabic-digit phone, location, skip note', async () => {
  tg.tap(SARA, 'co', { message_id: 30 });
  let c = await step();
  assert.match(texts(c), /ما الاسم/);
  assert.ok(buttons(last(c, 'editMessageText')).includes('nm'));
  tg.tap(SARA, 'nm', { message_id: 30 });
  c = await step();
  assert.equal(last(c, 'sendMessage').params.reply_markup.keyboard[0][0].request_contact, true);
  tg.msg(SARA, null, { contact: { phone_number: '966500000000', user_id: 999 } });
  tg.msg(SARA, '٠٥٥١٢٣٤٥٦٧');
  c = await step();
  assert.match(texts(c), /الرقم غير صحيح/);
  assert.match(texts(c), /عنوان التوصيل/);
  tg.msg(SARA, null, { location: { latitude: 24.7136, longitude: 46.6753 } });
  c = await step();
  assert.deepEqual(c[0].params.reply_markup, { remove_keyboard: true });
  tg.tap(SARA, 'sk', { message_id: 40 });
  c = await step();
  const s = last(c, 'sendMessage').params.text;
  assert.match(s, /راجع طلبك/);
  assert.match(s, /055 123 4567/);
  assert.match(s, /maps\.google\.com\/\?q=24\.7136,46\.6753/);
  assert.deepEqual(buttons(last(c, 'sendMessage')), ['ok', 'co', 'cx']);
});

test('confirm: order #1001, stock reduced, cart emptied, owner notified; second tap does nothing', async () => {
  tg.tap(SARA, 'ok', { message_id: 41 });
  tg.tap(SARA, 'ok', { message_id: 41 });
  const c = await step();
  assert.match(texts(c), /استلمنا طلبك رقم #1001/);
  const ownerMsg = find(c, 'sendMessage').find((m) => m.params.chat_id === OWNER.id);
  assert.match(ownerMsg.params.text, /طلب #1001/);
  assert.match(ownerMsg.params.text, /\+966551234567/);
  assert.deepEqual(buttons(ownerMsg), ['st:1001:accepted', 'st:1001:cancelled']);
  assert.equal(find(c, 'answerCallbackQuery').at(-1).params.text, 'هذا الطلب أُرسل أو أُلغي سابقاً');
  assert.equal(bot.db.prepare('SELECT COUNT(*) n FROM orders').get().n, 1);
  assert.equal(bot.db.prepare('SELECT stock FROM products WHERE id = 1').get().stock, 1);
  assert.equal(bot.db.prepare('SELECT COUNT(*) n FROM cart WHERE user_id = ?').get(SARA.id).n, 0);
  assert.equal(bot.db.prepare('SELECT COUNT(*) n FROM owner_msgs WHERE order_id = 1001').get().n, 1, 'owner message id saved after sending');
  const item = bot.db.prepare('SELECT * FROM order_items WHERE order_id = 1001 AND product_id = 1').get();
  assert.equal(item.price, 18000, 'price snapshot');
});

test('price change later does not touch the order', async () => {
  tg.msg(OWNER, '/price 1 200');
  await step();
  assert.equal(bot.db.prepare('SELECT total FROM orders WHERE id = 1001').get().total, 42050);
});

test('owner moves the order: customer told, owner message edited; customers cannot', async () => {
  tg.tap(SARA, 'st:1001:accepted');
  let c = await step();
  assert.equal(bot.db.prepare('SELECT status FROM orders WHERE id = 1001').get().status, 'new');
  tg.tap(OWNER, 'st:1001:delivered');
  c = await step();
  assert.equal(last(c, 'answerCallbackQuery').params.text, 'تغيرت حالة الطلب قبل قليل', 'cannot jump new -> delivered');
  tg.tap(OWNER, 'st:1001:accepted');
  c = await step();
  const toSara = find(c, 'sendMessage').find((m) => m.params.chat_id === SARA.id);
  assert.match(toSara.params.text, /طلبك <b>#1001<\/b> قيد التجهيز/);
  const edit = find(c, 'editMessageText').find((m) => m.params.chat_id === OWNER.id);
  assert.match(edit.params.text, /الحالة: <b>👍 قيد التجهيز/);
  assert.deepEqual(buttons(edit), ['st:1001:shipped', 'st:1001:cancelled']);
});

test('min order, customer cancel restores stock, cannot cancel after accept', async () => {
  tg.tap(ALI, 'add:3');
  tg.tap(ALI, 'co');
  let c = await step();
  assert.equal(last(c, 'answerCallbackQuery').params.text, 'أقل مبلغ للطلب 50 ريال');
  tg.tap(ALI, 'add:1');
  tg.tap(ALI, 'co');
  tg.msg(ALI, '<i>علي</i>');
  tg.msg(ALI, '0501112222');
  tg.msg(ALI, 'الرياض، حي النرجس، شارع 12');
  tg.msg(ALI, 'بعد العصر');
  tg.tap(ALI, 'ok');
  c = await step();
  const ownerMsg = find(c, 'sendMessage').find((m) => m.params.chat_id === OWNER.id && /#1002/.test(m.params.text));
  assert.match(ownerMsg.params.text, /&lt;i&gt;علي&lt;\/i&gt;/, 'customer text is escaped');
  assert.equal(bot.db.prepare('SELECT stock FROM products WHERE id = 1').get().stock, 0);
  tg.tap(ALI, 'mc:1002');
  c = await step();
  assert.equal(bot.db.prepare('SELECT status FROM orders WHERE id = 1002').get().status, 'cancelled');
  assert.equal(bot.db.prepare('SELECT stock FROM products WHERE id = 1').get().stock, 1, 'stock back');
  assert.match(texts(c), /ألغى العميل الطلب <b>#1002<\/b>/);
  tg.tap(SARA, 'mc:1001');
  c = await step();
  assert.match(last(c, 'answerCallbackQuery').params.text, /لا يمكن إلغاء/);
});

test('owner hides a product; customers cannot open it', async () => {
  tg.tap(OWNER, 'ph:2', { message_id: 50 });
  await step();
  tg.tap(ALI, 'p:2');
  const c = await step();
  assert.equal(find(c, 'answerCallbackQuery')[0].params.text, 'هذا المنتج لم يعد متاحاً');
  tg.tap(ALI, 'ph:2');
  await step();
  assert.equal(bot.db.prepare('SELECT active FROM products WHERE id = 2').get().active, 0, 'customer pressing owner button changes nothing');
});

test('outbox: 502 keeps the message for later, 429 waits retry_after, 403 (blocked) is dropped', async () => {
  tg.state.failures.push({ method: 'sendMessage', code: 502, description: 'Bad Gateway', times: 1 });
  tg.msg(SARA, '/start');
  let c = await step();
  assert.equal(find(c, 'sendMessage').length, 0);
  assert.equal(bot.db.prepare('SELECT COUNT(*) n FROM outbox').get().n, 1, 'still waiting in outbox');
  await bot.flush();
  assert.equal(find(tg.take(), 'sendMessage').length, 1, 'sent on retry');
  tg.state.failures.push({ method: 'sendMessage', code: 429, description: 'Too Many Requests', retry_after: 1, times: 1 });
  const t0 = Date.now();
  tg.msg(SARA, '/start');
  c = await step();
  assert.ok(Date.now() - t0 >= 1000 && find(c, 'sendMessage').length === 1, 'waited retry_after then sent');
  tg.state.failures.push({ method: 'sendMessage', code: 403, description: 'Forbidden: bot was blocked by the user', times: 1 });
  tg.msg(SARA, '/start');
  await step();
  assert.equal(bot.db.prepare('SELECT COUNT(*) n FROM outbox').get().n, 0);
});

test('crash: kill -9 in the middle of 100 orders, restart -> exactly 100 orders, none twice', async () => {
  const dbFile = path.join(tmp, 'crash.sqlite');
  const db = require('../src/db').openDb(dbFile);
  db.exec("INSERT INTO categories (name) VALUES ('x'); INSERT INTO products (category_id, name, price, created_at) VALUES (1, 'p', 1000, 0)");
  const draft = JSON.stringify({ name: 'n', phone: '966550000000', address: 'عنوان', note: '' });
  for (let i = 0; i < 100; i++) {
    db.prepare("INSERT INTO users (id, step, draft, updated_at) VALUES (?, 'confirm', ?, 0)").run(1000 + i, draft);
    db.prepare('INSERT INTO cart VALUES (?, 1, 2)').run(1000 + i);
    tg.tap({ id: 1000 + i, first_name: 'u' }, 'ok');
  }
  db.close();
  const conf = path.join(tmp, 'crash.json');
  fs.writeFileSync(conf, JSON.stringify({ ...cfg, db: dbFile, poll_timeout: 1 }));
  const start = () => spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'bot.js'), conf], { stdio: 'ignore' });
  const count = () => { const d = new DatabaseSync(dbFile); const n = d.prepare('SELECT COUNT(*) n FROM orders').get().n; d.close(); return n; };
  let p = start();
  while (count() < 30) await new Promise((r) => setTimeout(r, 5));
  p.kill('SIGKILL');
  await new Promise((r) => p.on('exit', r));
  const atCrash = count();
  p = start();
  while (tg.state.updates.length) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 300));
  p.kill('SIGTERM');
  await new Promise((r) => p.on('exit', r));
  const d = new DatabaseSync(dbFile);
  const orders = d.prepare('SELECT COUNT(*) n, COUNT(DISTINCT user_id) u FROM orders').get();
  d.close();
  tg.take();
  assert.ok(atCrash < 100, `killed mid-way (at ${atCrash})`);
  assert.deepEqual([orders.n, orders.u], [100, 100]);
});
