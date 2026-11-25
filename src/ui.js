'use strict';
// النصوص العربية، والأسعار، والأزرار

const STATUS = {
  new: '🆕 جديد',
  accepted: '👍 قيد التجهيز',
  shipped: '🚚 في الطريق',
  delivered: '📦 تم التسليم',
  cancelled: '❌ ملغى',
};

// ما يُسمح به لصاحب المتجر من كل حالة
const NEXT = {
  new: ['accepted', 'cancelled'],
  accepted: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

const ACTION = { accepted: '👍 قبول', shipped: '🚚 شُحن', delivered: '📦 سُلّم', cancelled: '❌ إلغاء' };

const CUSTOMER_STATUS_MSG = {
  accepted: (id) => `👍 طلبك <b>#${id}</b> قيد التجهيز الآن.`,
  shipped: (id) => `🚚 طلبك <b>#${id}</b> في الطريق إليك.`,
  delivered: (id) => `📦 تم تسليم طلبك <b>#${id}</b>. شكراً لك!`,
  cancelled: (id) => `❌ أُلغي طلبك <b>#${id}</b>. للاستفسار راسلنا هنا.`,
};

/** هروب النص قبل إرساله بصيغة HTML */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** الأرقام العربية والفارسية إلى لاتينية، والفاصلة العشرية العربية ٫ إلى نقطة */
function latin(s) {
  return String(s ?? '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/[٫,]/g, '.');
}

/** "12.5" أو "١٢٫٥" ← 1250 هللة. null إن لم يكن سعراً صحيحاً */
function parsePrice(s) {
  const t = latin(s).trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
  const [a, b = ''] = t.split('.');
  return Number(a) * 100 + Number((b + '00').slice(0, 2));
}

/** 1250 ← "12.50 ريال"، و 1500 ← "15 ريال" */
function money(cents, currency) {
  const v = cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
  return `${v} ${currency}`;
}

/** جوال سعودي بأي صيغة ← 9665XXXXXXXX، أو رقم دولي يبدأ بـ + */
function normalizePhone(raw) {
  const s = latin(raw).trim();
  const intl = s.startsWith('+') || s.startsWith('00');
  let d = s.replace(/\D+/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  const m = d.match(/^(?:966|0)?(5\d{8})$/);
  if (m) return '966' + m[1];
  if (intl && /^[1-9]\d{7,14}$/.test(d)) return d;
  return null;
}

/** عزل نص يُقرأ من اليسار لليمين (جوال، تاريخ) داخل رسالة عربية، فلا ينقلب "055 123 4567" إلى "4567 123 055" */
const ltr = (s) => '\u2066' + s + '\u2069';

function showPhone(p) {
  const m = String(p).match(/^966(5\d)(\d{3})(\d{4})$/);
  return ltr(m ? `0${m[1]} ${m[2]} ${m[3]}` : '+' + p);
}

const btn = (text, data) => ({ text, callback_data: data });
const kb = (rows) => ({ inline_keyboard: rows.filter((r) => r.length) });

module.exports = { STATUS, NEXT, ACTION, CUSTOMER_STATUS_MSG, esc, latin, parsePrice, money, normalizePhone, showPhone, ltr, btn, kb };
