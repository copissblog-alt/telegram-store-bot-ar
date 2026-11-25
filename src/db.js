'use strict';
// قاعدة SQLite المدمجة في Node (node:sqlite) — بلا أي مكتبة خارجية
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS categories (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  name        TEXT NOT NULL,
  price       INTEGER NOT NULL,          -- بالهللة (السنت): 1250 = 12.50
  description TEXT NOT NULL DEFAULT '',
  photo       TEXT NOT NULL DEFAULT '',  -- file_id من تيليجرام
  stock       INTEGER,                   -- NULL = بلا حد
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY,        -- معرف المستخدم في تيليجرام
  first_name TEXT NOT NULL DEFAULT '',
  username   TEXT NOT NULL DEFAULT '',
  step       TEXT NOT NULL DEFAULT '',   -- خطوة إتمام الطلب الحالية
  draft      TEXT NOT NULL DEFAULT '{}', -- بيانات الطلب قبل تأكيده
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cart (
  user_id    INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty        INTEGER NOT NULL,
  PRIMARY KEY (user_id, product_id)
);
CREATE TABLE IF NOT EXISTS orders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,
  address    TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  subtotal   INTEGER NOT NULL,
  delivery   INTEGER NOT NULL,
  total      INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'new',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id, id);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status, id);
CREATE TABLE IF NOT EXISTS order_items (
  order_id   INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL,
  name       TEXT NOT NULL,
  price      INTEGER NOT NULL,
  qty        INTEGER NOT NULL
);
-- رسائل تنتظر الإرسال: تُكتب في معاملة الطلب نفسها، وتُحذف بعد أن يقبلها تيليجرام
CREATE TABLE IF NOT EXISTS outbox (
  id      INTEGER PRIMARY KEY,
  method  TEXT NOT NULL,
  payload TEXT NOT NULL,
  tag     TEXT NOT NULL DEFAULT '',
  tries   INTEGER NOT NULL DEFAULT 0
);
-- رسائل الطلب عند أصحاب المتجر، لنعدّلها حين تتغير حالته
CREATE TABLE IF NOT EXISTS owner_msgs (
  order_id   INTEGER NOT NULL,
  chat_id    INTEGER NOT NULL,
  message_id INTEGER NOT NULL
);
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  // أرقام الطلبات تبدأ من 1001 لا من 1
  if (!db.prepare("SELECT 1 FROM sqlite_sequence WHERE name = 'orders'").get()) {
    db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('orders', 1000)").run();
  }
  return db;
}

function kvGet(db, k, def = null) {
  const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(k);
  return r ? r.v : def;
}

function kvSet(db, k, v) {
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
}

/** ينفذ fn داخل معاملة: كل شيء أو لا شيء */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { openDb, kvGet, kvSet, tx };
