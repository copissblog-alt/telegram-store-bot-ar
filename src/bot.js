'use strict';
// حلقة الاستقبال: getUpdates ← معالجة كل تحديث في معاملة مع حفظ رقمه ← إرسال صندوق الصادر
const { openDb, kvGet, kvSet, tx } = require('./db');
const { createClient, TgError } = require('./tg');
const { createHandlers } = require('./handlers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createBot(cfg, log = (...a) => console.log(new Date().toISOString(), ...a)) {
  const db = openDb(cfg.db || './data/store.sqlite');
  const call = createClient(cfg.token, cfg.api);
  const h = createHandlers(db, cfg);
  let running = true;
  let wake = null;
  let onStop;
  const stopped = new Promise((r) => { onStop = r; });

  /**
   * أثر التحديث في القاعدة (طلب، سلة، مخزون) ورقمه يُحفظان في معاملة واحدة:
   * إن انطفأ البوت في أي لحظة، إما حُفظ الاثنان أو لا شيء، فلا يتكرر طلب ولا يضيع.
   */
  function processUpdate(u) {
    try {
      tx(db, () => {
        h.handle(u);
        kvSet(db, 'offset', u.update_id + 1);
      });
    } catch (e) {
      log('update', u.update_id, 'failed:', e.message);
      tx(db, () => {
        h.failed(u);
        kvSet(db, 'offset', u.update_id + 1); // لا نعلق على تحديث معطوب
      });
    }
  }

  /** يرسل الرسائل المنتظرة بالترتيب. يرجع false إن توقف عند خطأ مؤقت */
  async function flush() {
    for (;;) {
      const row = db.prepare('SELECT * FROM outbox ORDER BY id LIMIT 1').get();
      if (!row) return true;
      try {
        const res = await call(row.method, JSON.parse(row.payload));
        tx(db, () => {
          const [kind, id] = row.tag.split(':');
          if (kind === 'ownermsg' && res && res.message_id) {
            db.prepare('INSERT INTO owner_msgs (order_id, chat_id, message_id) VALUES (?, ?, ?)').run(Number(id), res.chat.id, res.message_id);
          }
          db.prepare('DELETE FROM outbox WHERE id = ?').run(row.id);
        });
      } catch (e) {
        if (!(e instanceof TgError) || e.retryable) {
          if (e.code === 429 && e.retryAfter) {
            log('rate limited, waiting', e.retryAfter, 's');
            await sleep(e.retryAfter * 1000);
            continue;
          }
          db.prepare('UPDATE outbox SET tries = tries + 1 WHERE id = ?').run(row.id);
          log('send failed, will retry:', e.message);
          return false;
        }
        // خطأ دائم: الرسالة لم تتغير، أو حظر العميل البوت، أو رسالة قديمة لا تُحذف
        if (!/not modified/.test(e.description)) log('dropped', row.method, e.message);
        db.prepare('DELETE FROM outbox WHERE id = ?').run(row.id);
      }
    }
  }

  async function pollOnce(timeout = 50) {
    const offset = Number(kvGet(db, 'offset', 0));
    const updates = await call('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] }, (timeout + 10) * 1000);
    for (const u of updates) {
      if (!running) break;
      processUpdate(u);
      await flush();
    }
    return updates.length;
  }

  async function run() {
    let backoff = 1;
    const me = await call('getMe');
    log(`@${me.username} يعمل`);
    while (running) {
      try {
        if (!(await flush())) throw new TgError(0, 'outbox pending');
        // الإيقاف لا ينتظر انتهاء الانتظار الطويل: الحالة في القاعدة سليمة بين أي خطوتين
        await Promise.race([pollOnce(Number(cfg.poll_timeout ?? 50)), stopped]);
        backoff = 1;
      } catch (e) {
        if (!running) break;
        if (e instanceof TgError && e.code === 401) throw new Error('التوكن غير صحيح (401). راجع config.json');
        if (e instanceof TgError && e.code === 409) log('409: نسخة أخرى من البوت تعمل بالتوكن نفسه، أو أن webhook مفعّل');
        else log('error:', e.message);
        await new Promise((r) => { wake = r; setTimeout(r, Math.min(backoff, 30) * 1000); });
        backoff *= 2;
      }
    }
  }

  function stop() {
    running = false;
    onStop();
    if (wake) wake();
  }

  return { db, call, processUpdate, flush, pollOnce, run, stop };
}

module.exports = { createBot };
