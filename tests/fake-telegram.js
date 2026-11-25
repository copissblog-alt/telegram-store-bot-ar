'use strict';
// خادم Bot API مزيف للاختبارات: يحفظ كل طلب، ويعيد التحديثات حتى يؤكدها البوت بـ offset كما يفعل تيليجرام،
// ويمكنه أن يفشل عمداً (502 أو 429 أو 403) لنختبر إعادة المحاولة.
const http = require('node:http');

function fakeTelegram() {
  const state = {
    updates: [],      // تحديثات لم تُؤكد بعد
    nextId: 1,
    calls: [],        // كل طلب: { method, params }
    failures: [],     // { method, code, description, retry_after, times }
    msgId: 100,
    waiters: [],
  };

  function result(method, params) {
    if (method === 'getMe') return { id: 1, is_bot: true, username: 'test_store_bot' };
    if (/^(sendMessage|sendPhoto)$/.test(method)) return { message_id: ++state.msgId, chat: { id: params.chat_id }, date: 0 };
    if (/^edit/.test(method)) return { message_id: params.message_id, chat: { id: params.chat_id } };
    return true;
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const method = req.url.split('/').pop();
      const params = body ? JSON.parse(body) : {};
      const reply = (obj, code = 200) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const f = state.failures.find((x) => x.method === method && x.times > 0);
      if (f) {
        f.times--;
        return reply({ ok: false, error_code: f.code, description: f.description || 'fail', ...(f.retry_after ? { parameters: { retry_after: f.retry_after } } : {}) }, f.code);
      }
      if (method === 'getUpdates') {
        const offset = params.offset || 0;
        if (offset) state.updates = state.updates.filter((u) => u.update_id >= offset); // التأكيد
        const send = () => reply({ ok: true, result: state.updates.slice(0, params.limit || 100) });
        if (state.updates.length || !params.timeout) return send();
        const t = setTimeout(() => { state.waiters = state.waiters.filter((w) => w !== wake); send(); }, params.timeout * 1000);
        const wake = () => { clearTimeout(t); send(); };
        state.waiters.push(wake);
        return;
      }
      state.calls.push({ method, params });
      reply({ ok: true, result: result(method, params) });
    });
  });

  const api = {
    state,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    push(update) {
      state.updates.push({ update_id: state.nextId++, ...update });
      const w = state.waiters.splice(0);
      w.forEach((f) => f());
    },
    msg(user, text, extra = {}) {
      api.push({ message: { message_id: ++state.msgId, from: user, chat: { id: user.id, type: 'private' }, date: 0, ...(text !== null ? { text } : {}), ...extra } });
    },
    tap(user, data, message = { message_id: 1 }) {
      api.push({ callback_query: { id: String(state.nextId), from: user, data, message: { chat: { id: user.id, type: 'private' }, ...message } } });
    },
    take() {
      return state.calls.splice(0);
    },
  };
  return api;
}

module.exports = { fakeTelegram };
