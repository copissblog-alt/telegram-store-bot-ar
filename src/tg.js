'use strict';
// عميل Bot API صغير فوق fetch المدمج في Node

class TgError extends Error {
  constructor(code, description, retryAfter = 0) {
    super(`Telegram ${code}: ${description}`);
    this.code = code;
    this.description = description;
    this.retryAfter = retryAfter;
  }
  /** أخطاء تستحق إعادة المحاولة: الشبكة، وضغط الطلبات 429، وأعطال تيليجرام 5xx */
  get retryable() {
    return this.code === 0 || this.code === 429 || this.code >= 500;
  }
}

function createClient(token, api = 'https://api.telegram.org') {
  const base = `${api.replace(/\/$/, '')}/bot${token}/`;
  return async function call(method, params = {}, timeoutMs = 15000) {
    let res;
    try {
      res = await fetch(base + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new TgError(0, `network: ${e.cause?.code || e.name}`);
    }
    let body;
    try {
      body = await res.json();
    } catch {
      throw new TgError(res.status || 0, 'bad response');
    }
    if (!body.ok) {
      throw new TgError(body.error_code || res.status, body.description || 'error', body.parameters?.retry_after || 0);
    }
    return body.result;
  };
}

module.exports = { createClient, TgError };
