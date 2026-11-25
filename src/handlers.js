'use strict';
// منطق المتجر كاملاً. كل دالة هنا متزامنة: تقرأ وتكتب في القاعدة وتضع الرسائل في صندوق الصادر،
// ولا تتصل بالشبكة أبداً. لهذا تُنفذ داخل معاملة واحدة مع حفظ رقم التحديث.
const { STATUS, NEXT, ACTION, CUSTOMER_STATUS_MSG, esc, latin, parsePrice, money, normalizePhone, showPhone, ltr, btn, kb } = require('./ui');

const PAGE = 8;

function createHandlers(db, cfg) {
  const owners = new Set((cfg.owners || []).map(Number));
  const cur = cfg.currency || 'ريال';
  const delivery = parsePrice(String(cfg.delivery_fee ?? 0)) ?? 0;
  const minOrder = parsePrice(String(cfg.min_order ?? 0)) ?? 0;
  const now = () => Math.floor(Date.now() / 1000);
  const off = Number(cfg.utc_offset ?? 3) * 3600; // فرق التوقيت عن UTC بالثواني (السعودية +3)
  const localTime = (ts) => ltr(new Date((ts + off) * 1000).toISOString().slice(0, 16).replace('T', ' '));
  const m = (c) => money(c, cur);
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);

  // ===== الإرسال عبر صندوق الصادر =====
  function send(method, payload, tag = '') {
    run('INSERT INTO outbox (method, payload, tag) VALUES (?, ?, ?)', method, JSON.stringify(payload), tag);
  }
  function say(chat, text, markup, tag = '') {
    send('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) }, tag);
  }
  /** يعرض شاشة: يعدّل الرسالة التي ضُغط زرها إن كانت نصاً، وإلا يرسل رسالة جديدة */
  function show(ctx, text, markup) {
    if (ctx.msg && !ctx.msg.photo) {
      send('editMessageText', { chat_id: ctx.chat, message_id: ctx.msg.message_id, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: markup });
      return;
    }
    if (ctx.msg) send('deleteMessage', { chat_id: ctx.chat, message_id: ctx.msg.message_id });
    say(ctx.chat, text, markup);
  }

  // ===== المستخدمون والسلة =====
  function touchUser(from) {
    run(`INSERT INTO users (id, first_name, username, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET first_name = excluded.first_name, username = excluded.username, updated_at = excluded.updated_at`,
      from.id, String(from.first_name || '').slice(0, 64), String(from.username || ''), now());
    return one('SELECT * FROM users WHERE id = ?', from.id);
  }
  function setStep(uid, step, draft) {
    run('UPDATE users SET step = ?, draft = ? WHERE id = ?', step, JSON.stringify(draft || {}), uid);
  }
  function cartItems(uid) {
    return all(`SELECT c.product_id id, c.qty, p.name, p.price, p.stock, p.active
                FROM cart c JOIN products p ON p.id = c.product_id WHERE c.user_id = ? ORDER BY p.name`, uid);
  }
  function cartCount(uid) {
    return one('SELECT COALESCE(SUM(qty), 0) n FROM cart WHERE user_id = ?', uid).n;
  }

  // ===== الشاشات =====
  function home(ctx) {
    const n = cartCount(ctx.uid);
    const rows = [[btn('🛍 المنتجات', 'cats')], [btn(`🛒 السلة${n ? ` (${n})` : ''}`, 'cart'), btn('📦 طلباتي', 'my')]];
    if (owners.has(ctx.uid)) rows.push([btn('⚙️ لوحة المتجر', 'ad')]);
    show(ctx, `<b>${esc(cfg.store_name || 'المتجر')}</b>\n${esc(cfg.welcome || 'أهلاً بك! تصفح المنتجات واطلب من هنا مباشرة.')}`, kb(rows));
  }

  function categories(ctx) {
    const cats = all(`SELECT c.id, c.name, COUNT(p.id) n FROM categories c JOIN products p ON p.category_id = c.id AND p.active = 1
                      GROUP BY c.id ORDER BY c.name`);
    if (!cats.length) return show(ctx, 'لا توجد منتجات متاحة حالياً.', kb([[btn('⬅️ الرئيسية', 'home')]]));
    if (cats.length === 1) return category(ctx, cats[0].id, 0);
    const rows = [];
    for (let i = 0; i < cats.length; i += 2) rows.push(cats.slice(i, i + 2).map((c) => btn(`${c.name} (${c.n})`, `c:${c.id}:0`)));
    rows.push([btn('⬅️ الرئيسية', 'home')]);
    show(ctx, '🛍 <b>اختر القسم</b>', kb(rows));
  }

  function category(ctx, id, page) {
    const cat = one('SELECT * FROM categories WHERE id = ?', id);
    if (!cat) return categories(ctx);
    const total = one('SELECT COUNT(*) n FROM products WHERE category_id = ? AND active = 1', id).n;
    const pages = Math.max(1, Math.ceil(total / PAGE));
    page = Math.min(Math.max(0, page), pages - 1);
    const items = all('SELECT * FROM products WHERE category_id = ? AND active = 1 ORDER BY name LIMIT ? OFFSET ?', id, PAGE, page * PAGE);
    const rows = items.map((p) => [btn(`${p.name} · ${m(p.price)}${p.stock === 0 ? ' · نفد' : ''}`, `p:${p.id}`)]);
    const nav = [];
    if (page > 0) nav.push(btn('‹ السابق', `c:${id}:${page - 1}`));
    if (page < pages - 1) nav.push(btn('التالي ›', `c:${id}:${page + 1}`));
    rows.push(nav, [btn('⬅️ الأقسام', 'cats'), btn(`🛒 السلة (${cartCount(ctx.uid)})`, 'cart')]);
    show(ctx, `<b>${esc(cat.name)}</b>${pages > 1 ? ` · صفحة ${page + 1} من ${pages}` : ''}`, kb(rows));
  }

  function productMarkup(ctx, p) {
    const rows = [];
    if (p.active && p.stock !== 0) rows.push([btn('➕ أضف إلى السلة', `add:${p.id}`)]);
    rows.push([btn(`🛒 السلة (${cartCount(ctx.uid)})`, 'cart'), btn('⬅️ رجوع', `c:${p.category_id}:0`)]);
    if (owners.has(ctx.uid)) rows.push([btn(p.active ? '👁 إخفاء' : '👁 إظهار', `ph:${p.id}`), btn('🗑 حذف', `pd:${p.id}`)]);
    return kb(rows);
  }

  function productText(p) {
    const stock = p.stock === null ? '' : p.stock === 0 ? '\n⛔️ نفدت الكمية' : p.stock <= 5 ? `\n⚠️ بقي ${p.stock} فقط` : '';
    return `<b>${esc(p.name)}</b>\n💰 ${m(p.price)}${p.description ? `\n\n${esc(p.description)}` : ''}${stock}${p.active ? '' : '\n\n(مخفي عن العملاء)'}`;
  }

  function product(ctx, id) {
    const p = one('SELECT * FROM products WHERE id = ?', id);
    if (!p || (!p.active && !owners.has(ctx.uid))) {
      ctx.toast('هذا المنتج لم يعد متاحاً');
      return categories(ctx);
    }
    if (!p.photo) return show(ctx, productText(p), productMarkup(ctx, p));
    if (ctx.msg) send('deleteMessage', { chat_id: ctx.chat, message_id: ctx.msg.message_id });
    send('sendPhoto', { chat_id: ctx.chat, photo: p.photo, caption: productText(p), parse_mode: 'HTML', reply_markup: productMarkup(ctx, p) });
  }

  function addToCart(ctx, id) {
    const p = one('SELECT * FROM products WHERE id = ? AND active = 1', id);
    if (!p) return ctx.toast('هذا المنتج لم يعد متاحاً', true);
    const have = one('SELECT qty FROM cart WHERE user_id = ? AND product_id = ?', ctx.uid, id)?.qty || 0;
    if (p.stock !== null && have + 1 > p.stock) return ctx.toast(p.stock === 0 ? 'نفدت الكمية' : `المتاح ${p.stock} فقط`, true);
    run('INSERT INTO cart (user_id, product_id, qty) VALUES (?, ?, 1) ON CONFLICT DO UPDATE SET qty = qty + 1', ctx.uid, id);
    ctx.toast(`أُضيف ✓ — في سلتك منه ${have + 1}`);
    if (ctx.msg) send('editMessageReplyMarkup', { chat_id: ctx.chat, message_id: ctx.msg.message_id, reply_markup: productMarkup(ctx, p) });
  }

  function cartView(ctx) {
    let items = cartItems(ctx.uid);
    const gone = items.filter((i) => !i.active);
    if (gone.length) {
      for (const g of gone) run('DELETE FROM cart WHERE user_id = ? AND product_id = ?', ctx.uid, g.id);
      items = items.filter((i) => i.active);
    }
    if (!items.length) return show(ctx, '🛒 سلتك فارغة.', kb([[btn('🛍 تصفح المنتجات', 'cats')], [btn('⬅️ الرئيسية', 'home')]]));
    const sub = items.reduce((s, i) => s + i.price * i.qty, 0);
    const lines = items.map((i) => `• ${esc(i.name)} × ${i.qty} = ${m(i.price * i.qty)}`);
    const rows = items.map((i) => [btn('➖', `dec:${i.id}`), btn(`${i.name} × ${i.qty}`, 'noop'), btn('➕', `inc:${i.id}`)]);
    rows.push([btn('✅ إتمام الطلب', 'co')], [btn('🗑 تفريغ السلة', 'clr'), btn('🛍 متابعة التسوق', 'cats')]);
    const note = gone.length ? '\n\nحُذف من سلتك ما لم يعد متاحاً.' : '';
    show(ctx, `🛒 <b>سلتك</b>\n\n${lines.join('\n')}\n\nالمجموع: <b>${m(sub)}</b>${delivery ? `\nالتوصيل: ${m(delivery)}\nالإجمالي: <b>${m(sub + delivery)}</b>` : ''}${note}`, kb(rows));
  }

  function changeQty(ctx, id, delta) {
    const row = one('SELECT c.qty, p.stock FROM cart c JOIN products p ON p.id = c.product_id WHERE c.user_id = ? AND c.product_id = ?', ctx.uid, id);
    if (!row) return cartView(ctx);
    const qty = row.qty + delta;
    if (delta > 0 && row.stock !== null && qty > row.stock) return ctx.toast(`المتاح ${row.stock} فقط`, true);
    if (qty <= 0) run('DELETE FROM cart WHERE user_id = ? AND product_id = ?', ctx.uid, id);
    else run('UPDATE cart SET qty = ? WHERE user_id = ? AND product_id = ?', qty, ctx.uid, id);
    cartView(ctx);
  }

  // ===== إتمام الطلب: الاسم ← الجوال ← العنوان ← ملاحظة ← تأكيد =====
  function checkout(ctx) {
    const items = cartItems(ctx.uid).filter((i) => i.active);
    if (!items.length) return cartView(ctx);
    const sub = items.reduce((s, i) => s + i.price * i.qty, 0);
    if (sub < minOrder) return ctx.toast(`أقل مبلغ للطلب ${m(minOrder)}`, true);
    setStep(ctx.uid, 'name', {});
    const rows = ctx.user.first_name ? [[btn(`استخدم: ${ctx.user.first_name}`, 'nm')]] : [];
    rows.push([btn('❌ إلغاء', 'cx')]);
    show(ctx, '👤 ما الاسم الذي نكتبه على الطلب؟', kb(rows));
  }

  function askPhone(ctx, draft) {
    setStep(ctx.uid, 'phone', draft);
    say(ctx.chat, '📱 رقم جوالك للتواصل عند التوصيل؟\nاضغط الزر بالأسفل، أو اكتبه مثل 0551234567', {
      keyboard: [[{ text: '📱 أرسل رقمي', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true,
    });
  }

  function askAddress(ctx, draft) {
    setStep(ctx.uid, 'address', draft);
    say(ctx.chat, '📍 عنوان التوصيل: المدينة والحي والشارع، أو أرسل موقعك من الزر بالأسفل.', {
      keyboard: [[{ text: '📍 أرسل موقعي', request_location: true }]], resize_keyboard: true, one_time_keyboard: true,
    });
  }

  function askNote(ctx, draft) {
    setStep(ctx.uid, 'note', draft);
    say(ctx.chat, `✓ العنوان: ${esc(draft.address)}`, { remove_keyboard: true });
    say(ctx.chat, '📝 أي ملاحظة على الطلب؟ (وقت مناسب للتوصيل، مقاس، تغليف هدية...)', kb([[btn('تخطي ←', 'sk')]]));
  }

  function summary(ctx, draft) {
    setStep(ctx.uid, 'confirm', draft);
    const items = cartItems(ctx.uid).filter((i) => i.active);
    const sub = items.reduce((s, i) => s + i.price * i.qty, 0);
    const text = `🧾 <b>راجع طلبك</b>\n\n${items.map((i) => `• ${esc(i.name)} × ${i.qty} = ${m(i.price * i.qty)}`).join('\n')}\n\n`
      + `المجموع: ${m(sub)}\nالتوصيل: ${m(delivery)}\nالإجمالي: <b>${m(sub + delivery)}</b>\n\n`
      + `👤 ${esc(draft.name)}\n📱 ${showPhone(draft.phone)}\n📍 ${esc(draft.address)}${draft.note ? `\n📝 ${esc(draft.note)}` : ''}`
      + (cfg.payment_note ? `\n\n💳 ${esc(cfg.payment_note)}` : '');
    const markup = kb([[btn('✅ تأكيد الطلب', 'ok')], [btn('✏️ تعديل البيانات', 'co'), btn('❌ إلغاء', 'cx')]]);
    if (ctx.cq) show(ctx, text, markup);
    else say(ctx.chat, text, markup);
  }

  function onCheckoutInput(ctx, msg) {
    const draft = JSON.parse(ctx.user.draft || '{}');
    const text = (msg.text || '').trim();
    switch (ctx.user.step) {
      case 'name':
        if (text.length < 2 || text.length > 60) return say(ctx.chat, 'اكتب الاسم (من حرفين إلى 60 حرفاً).');
        return askPhone(ctx, { ...draft, name: text });
      case 'phone': {
        let phone = null;
        if (msg.contact) phone = msg.contact.user_id === ctx.uid ? normalizePhone('+' + String(msg.contact.phone_number).replace(/^\+/, '')) : null;
        else phone = normalizePhone(text);
        if (!phone) return say(ctx.chat, 'الرقم غير صحيح. اكتبه مثل 0551234567، أو اضغط زر «أرسل رقمي».');
        return askAddress(ctx, { ...draft, phone });
      }
      case 'address': {
        let address;
        if (msg.location) address = `📍 https://maps.google.com/?q=${msg.location.latitude},${msg.location.longitude}`;
        else if (text.length >= 5 && text.length <= 300) address = text;
        else return say(ctx.chat, 'اكتب العنوان (5 أحرف على الأقل)، أو أرسل موقعك.');
        return askNote(ctx, { ...draft, address });
      }
      case 'note':
        if (text.length > 300) return say(ctx.chat, 'الملاحظة حتى 300 حرف.');
        return summary(ctx, { ...draft, note: text });
      default:
        return say(ctx.chat, 'اضغط أحد الأزرار في الرسالة السابقة، أو أرسل /start للبداية.');
    }
  }

  /** تأكيد الطلب: السعر والكمية يُثبَّتان الآن، والمخزون يُخصم، والسلة تُفرَّغ — في معاملة التحديث نفسها */
  function confirm(ctx) {
    if (ctx.user.step !== 'confirm') return ctx.toast('هذا الطلب أُرسل أو أُلغي سابقاً');
    const draft = JSON.parse(ctx.user.draft);
    const items = cartItems(ctx.uid);
    const bad = items.find((i) => !i.active || (i.stock !== null && i.qty > i.stock));
    if (!items.length || bad) {
      setStep(ctx.uid, '', {});
      ctx.toast(bad ? `«${bad.name}» لم تعد الكمية متاحة. راجع سلتك.` : 'سلتك فارغة', true);
      return cartView(ctx);
    }
    const sub = items.reduce((s, i) => s + i.price * i.qty, 0);
    const t = now();
    const res = run(`INSERT INTO orders (user_id, name, phone, address, note, subtotal, delivery, total, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ctx.uid, draft.name, draft.phone, draft.address, draft.note || '', sub, delivery, sub + delivery, t, t);
    const id = Number(res.lastInsertRowid);
    for (const i of items) {
      run('INSERT INTO order_items (order_id, product_id, name, price, qty) VALUES (?, ?, ?, ?, ?)', id, i.id, i.name, i.price, i.qty);
      if (i.stock !== null) run('UPDATE products SET stock = stock - ? WHERE id = ?', i.qty, i.id);
    }
    run('DELETE FROM cart WHERE user_id = ?', ctx.uid);
    setStep(ctx.uid, '', {});
    show(ctx, `✅ <b>استلمنا طلبك رقم #${id}</b>\nالإجمالي: ${m(sub + delivery)}\n\nسنرسل لك هنا كل تحديث على حالته.${cfg.payment_note ? `\n\n💳 ${esc(cfg.payment_note)}` : ''}`,
      kb([[btn('📦 طلباتي', 'my'), btn('🛍 متابعة التسوق', 'cats')]]));
    for (const o of owners) say(o, orderText(id), orderMarkup(id), `ownermsg:${id}`);
  }

  function orderText(id) {
    const o = one('SELECT * FROM orders WHERE id = ?', id);
    const items = all('SELECT * FROM order_items WHERE order_id = ?', id);
    const u = one('SELECT username FROM users WHERE id = ?', o.user_id);
    return `🛒 <b>طلب #${o.id}</b> · ${localTime(o.created_at)}\n\n`
      + `👤 ${esc(o.name)}${u?.username ? ` (@${esc(u.username)})` : ''}\n📱 ${ltr('+' + o.phone)}\n📍 ${esc(o.address)}${o.note ? `\n📝 ${esc(o.note)}` : ''}\n\n`
      + `${items.map((i) => `• ${esc(i.name)} × ${i.qty} = ${m(i.price * i.qty)}`).join('\n')}\n\n`
      + `المجموع ${m(o.subtotal)} + التوصيل ${m(o.delivery)} = <b>${m(o.total)}</b>\n\nالحالة: <b>${STATUS[o.status]}</b>`;
  }

  function orderMarkup(id) {
    const o = one('SELECT status FROM orders WHERE id = ?', id);
    return kb([NEXT[o.status].map((s) => btn(ACTION[s], `st:${id}:${s}`))]);
  }

  /** تغيير حالة الطلب: يعدّل رسالته عند كل أصحاب المتجر ويخبر العميل */
  function setStatus(id, status, byCustomer = false) {
    const o = one('SELECT * FROM orders WHERE id = ?', id);
    if (!o || !NEXT[o.status].includes(status)) return false;
    run('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', status, now(), id);
    if (status === 'cancelled') {
      for (const i of all('SELECT product_id, qty FROM order_items WHERE order_id = ?', id)) {
        run('UPDATE products SET stock = stock + ? WHERE id = ? AND stock IS NOT NULL', i.qty, i.product_id);
      }
    }
    for (const r of all('SELECT chat_id, message_id FROM owner_msgs WHERE order_id = ?', id)) {
      send('editMessageText', { chat_id: r.chat_id, message_id: r.message_id, text: orderText(id) + (byCustomer ? '\n(ألغاه العميل)' : ''), parse_mode: 'HTML', reply_markup: orderMarkup(id) });
    }
    if (!byCustomer) say(o.user_id, CUSTOMER_STATUS_MSG[status](id), kb([[btn('📦 طلباتي', 'my')]]));
    return true;
  }

  function myOrders(ctx) {
    const orders = all('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 5', ctx.uid);
    if (!orders.length) return show(ctx, 'لا توجد طلبات بعد.', kb([[btn('🛍 تصفح المنتجات', 'cats')]]));
    const lines = orders.map((o) => `<b>#${o.id}</b> · ${m(o.total)} · ${STATUS[o.status]}`);
    const rows = orders.filter((o) => o.status === 'new').map((o) => [btn(`إلغاء الطلب #${o.id}`, `mc:${o.id}`)]);
    rows.push([btn('⬅️ الرئيسية', 'home')]);
    show(ctx, `📦 <b>آخر طلباتك</b>\n\n${lines.join('\n')}`, kb(rows));
  }

  function customerCancel(ctx, id) {
    const o = one('SELECT * FROM orders WHERE id = ? AND user_id = ?', id, ctx.uid);
    if (!o || o.status !== 'new') return ctx.toast('لا يمكن إلغاء هذا الطلب الآن. راسلنا هنا.', true);
    setStatus(id, 'cancelled', true);
    for (const own of owners) say(own, `❌ ألغى العميل الطلب <b>#${id}</b>.`);
    ctx.toast('أُلغي الطلب');
    myOrders(ctx);
  }

  // ===== أصحاب المتجر =====
  const FORMAT = 'الصيغة:\n<code>الاسم | السعر | القسم | الوصف | الكمية</code>\nالوصف والكمية اختياريان. مثال:\n<code>عسل سدر 1 كيلو | 180 | العسل | من جبال الجنوب | 20</code>';

  /** إضافة منتج من سطر واحد، مع صورة أو بدونها */
  function addProduct(ctx, line, photo) {
    const parts = String(line || '').split('|').map((s) => s.trim());
    const [name, priceRaw, catName, description = '', stockRaw = ''] = parts;
    const price = parsePrice(priceRaw || '');
    const stock = stockRaw === '' || stockRaw === '-' ? null : /^\d{1,6}$/.test(latin(stockRaw)) ? Number(latin(stockRaw)) : NaN;
    if (parts.length < 3 || !name || name.length > 80 || price === null || !catName || catName.length > 40 || Number.isNaN(stock) || description.length > 700) {
      return say(ctx.chat, `لم أفهم المنتج.\n${FORMAT}`);
    }
    run('INSERT INTO categories (name) VALUES (?) ON CONFLICT(name) DO NOTHING', catName);
    const cat = one('SELECT id FROM categories WHERE name = ?', catName);
    const r = run('INSERT INTO products (category_id, name, price, description, photo, stock, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      cat.id, name, price, description, photo || '', stock, now());
    say(ctx.chat, `✅ أُضيف المنتج رقم ${r.lastInsertRowid}: <b>${esc(name)}</b> · ${m(price)} · ${esc(catName)}`, kb([[btn('عرض المنتج', `p:${r.lastInsertRowid}`)]]));
  }

  function adminPanel(ctx) {
    const day = Math.floor((now() + off) / 86400) * 86400 - off; // بداية اليوم بتوقيت المتجر
    const today = one("SELECT COUNT(*) n, COALESCE(SUM(total), 0) s FROM orders WHERE created_at >= ? AND status <> 'cancelled'", day);
    const open = all("SELECT id, name, total, status FROM orders WHERE status IN ('new', 'accepted', 'shipped') ORDER BY id DESC LIMIT 10");
    const counts = one("SELECT SUM(status = 'new') n, SUM(status = 'accepted') a, SUM(status = 'shipped') s FROM orders");
    const prods = one('SELECT COUNT(*) n, SUM(active) a FROM products');
    const text = `⚙️ <b>لوحة المتجر</b>\n\nاليوم: ${today.n} طلب · ${m(today.s)}\n🆕 جديدة ${counts.n || 0} · 👍 قيد التجهيز ${counts.a || 0} · 🚚 في الطريق ${counts.s || 0}\n`
      + `المنتجات: ${prods.a || 0} ظاهر من ${prods.n}\n\nلإضافة منتج أرسل صورته وفي وصفها سطر المنتج.\n${FORMAT}\n\n`
      + 'أوامر: /price رقم السعر · /stock رقم الكمية (أو - بلا حد) · /products';
    show(ctx, text, kb([...open.map((o) => [btn(`#${o.id} · ${o.name} · ${m(o.total)} · ${STATUS[o.status]}`, `o:${o.id}`)]), [btn('⬅️ الرئيسية', 'home')]]));
  }

  function ownerCommand(ctx, text) {
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd.split('@')[0]) {
      case '/add': return addProduct(ctx, arg, '');
      case '/admin': return adminPanel(ctx);
      case '/products': {
        const ps = all('SELECT p.id, p.name, p.price, p.stock, p.active, c.name cat FROM products p JOIN categories c ON c.id = p.category_id ORDER BY c.name, p.name LIMIT 100');
        return say(ctx.chat, ps.length ? ps.map((p) => `${p.id}. ${esc(p.name)} · ${m(p.price)} · ${esc(p.cat)}${p.stock === null ? '' : ` · كمية ${p.stock}`}${p.active ? '' : ' · مخفي'}`).join('\n') : 'لا منتجات بعد.');
      }
      case '/price': {
        const [id, v] = rest;
        const price = parsePrice(v || '');
        const r = price === null ? { changes: 0 } : run('UPDATE products SET price = ? WHERE id = ?', price, Number(latin(id)));
        return say(ctx.chat, r.changes ? `✅ السعر الجديد ${m(price)}. الطلبات السابقة تبقى بسعرها.` : 'الصيغة: /price رقم_المنتج السعر');
      }
      case '/stock': {
        const [id, v] = rest;
        const stock = v === '-' ? null : /^\d{1,6}$/.test(latin(v || '')) ? Number(latin(v)) : undefined;
        const r = stock === undefined ? { changes: 0 } : run('UPDATE products SET stock = ? WHERE id = ?', stock, Number(latin(id)));
        return say(ctx.chat, r.changes ? `✅ الكمية: ${stock === null ? 'بلا حد' : stock}` : 'الصيغة: /stock رقم_المنتج الكمية (أو - بلا حد)');
      }
      default: return false;
    }
  }

  // ===== التوجيه =====
  function onMessage(msg) {
    if (msg.chat.type !== 'private' || !msg.from) return;
    const user = touchUser(msg.from);
    const ctx = { uid: msg.from.id, chat: msg.chat.id, user, msg: null, toast() {} };
    const text = (msg.text || '').trim();
    const owner = owners.has(ctx.uid);

    if (owner && msg.photo) {
      return addProduct(ctx, msg.caption, msg.photo[msg.photo.length - 1].file_id);
    }
    if (text === '/start' || text === '/menu') {
      if (user.step) setStep(ctx.uid, '', {});
      if (user.step && user.step !== 'name') say(ctx.chat, 'أُلغي إتمام الطلب، وسلتك محفوظة.', { remove_keyboard: true });
      return home(ctx);
    }
    if (text === '/cart') return cartView(ctx);
    if (text === '/orders') return myOrders(ctx);
    if (owner && text.startsWith('/') && ownerCommand(ctx, text) !== false) return;
    if (user.step) return onCheckoutInput(ctx, msg);
    return home(ctx);
  }

  function onCallback(cq) {
    if (!cq.message || cq.message.chat.type !== 'private') return null;
    const user = touchUser(cq.from);
    let answer = { callback_query_id: cq.id };
    const ctx = {
      uid: cq.from.id, chat: cq.message.chat.id, user, msg: cq.message, cq,
      toast(text, alert = false) { answer = { callback_query_id: cq.id, text, show_alert: alert }; },
    };
    const [a, x, y] = String(cq.data || '').split(':');
    const id = Number(x);
    const owner = owners.has(ctx.uid);
    switch (a) {
      case 'home': home(ctx); break;
      case 'cats': categories(ctx); break;
      case 'c': category(ctx, id, Number(y) || 0); break;
      case 'p': product(ctx, id); break;
      case 'add': addToCart(ctx, id); break;
      case 'cart': cartView(ctx); break;
      case 'inc': changeQty(ctx, id, 1); break;
      case 'dec': changeQty(ctx, id, -1); break;
      case 'clr': run('DELETE FROM cart WHERE user_id = ?', ctx.uid); setStep(ctx.uid, '', {}); cartView(ctx); break;
      case 'co': checkout(ctx); break;
      case 'nm':
        if (user.step === 'name' && user.first_name) { ctx.msg = null; askPhone(ctx, { name: user.first_name }); } break;
      case 'sk':
        if (user.step === 'note') summary({ ...ctx, cq: null }, { ...JSON.parse(user.draft), note: '' }); break;
      case 'ok': confirm(ctx); break;
      case 'cx': setStep(ctx.uid, '', {}); show(ctx, 'أُلغي إتمام الطلب، وسلتك محفوظة.', kb([[btn('🛒 السلة', 'cart'), btn('⬅️ الرئيسية', 'home')]])); break;
      case 'my': myOrders(ctx); break;
      case 'mc': customerCancel(ctx, id); break;
      case 'noop': break;
      // أزرار أصحاب المتجر فقط
      case 'ad': if (owner) adminPanel(ctx); break;
      case 'o': if (owner) say(ctx.chat, orderText(id), orderMarkup(id), `ownermsg:${id}`); break;
      case 'st':
        if (owner) ctx.toast(setStatus(id, y) ? `الحالة الآن: ${STATUS[y]}` : 'تغيرت حالة الطلب قبل قليل', false);
        break;
      case 'ph':
        if (owner) {
          run('UPDATE products SET active = 1 - active WHERE id = ?', id);
          const p = one('SELECT * FROM products WHERE id = ?', id);
          if (p) { ctx.toast(p.active ? 'ظاهر للعملاء' : 'مخفي عن العملاء'); send(p.photo ? 'editMessageCaption' : 'editMessageText', { chat_id: ctx.chat, message_id: ctx.msg.message_id, [p.photo ? 'caption' : 'text']: productText(p), parse_mode: 'HTML', reply_markup: productMarkup(ctx, p) }); }
        }
        break;
      case 'pd':
        if (owner) {
          const used = one('SELECT 1 FROM order_items WHERE product_id = ? LIMIT 1', id);
          if (used) { run('UPDATE products SET active = 0 WHERE id = ?', id); ctx.toast('له طلبات سابقة، فأخفيناه بدل حذفه', true); }
          else { run('DELETE FROM cart WHERE product_id = ?', id); run('DELETE FROM products WHERE id = ?', id); ctx.toast('حُذف المنتج'); }
          categories({ ...ctx });
        }
        break;
      default: break;
    }
    send('answerCallbackQuery', answer);
    return null;
  }

  function handle(update) {
    if (update.message) return onMessage(update.message);
    if (update.callback_query) return onCallback(update.callback_query);
    return null;
  }

  /** يُستعمل حين يفشل تحديث: نرد على الزر حتى لا يبقى يدور */
  function failed(update) {
    if (update.callback_query) send('answerCallbackQuery', { callback_query_id: update.callback_query.id, text: 'حدث خطأ، حاول مرة أخرى', show_alert: true });
  }

  return { handle, failed };
}

module.exports = { createHandlers };
