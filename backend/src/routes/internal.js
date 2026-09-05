import { Router } from 'express';
import crypto from 'crypto';
import db from '../database.js';
import { DEFAULT_TENANT_ID } from '../database.js';
import { parseMessage, computeDelta, isAdminName } from '../whatsappParser.js';
import { parseSms } from './bank.js';
import { otpIngestHandler } from './otp.js';

const router = Router();

/**
 * tenant resolution داخل /api/internal:
 *  - owner مسجّل دخول (cookie) → دائماً يستخدم tenant_id من token (لا يمكن تجاوزه من body/query).
 *  - admin (cookie) أو خدمة داخلية (X-Internal-Api-Key) → يقرأ من body.tenant_id / query.tenant_id.
 *  - افتراضياً: 1 (DEFAULT_TENANT_ID).
 */
function tidFrom(reqOrObj) {
  // 1) owner: دائماً من token، لا يمكن تجاوزه
  if (reqOrObj?.user?.role === 'owner' && reqOrObj?.user?.tenant_id) {
    return reqOrObj.user.tenant_id;
  }
  // 2) admin / internal: من body أو query
  const raw = reqOrObj?.body?.tenant_id ?? reqOrObj?.query?.tenant_id ?? reqOrObj?.tenant_id;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) return n;
  return DEFAULT_TENANT_ID;
}

// ─── Auth middleware (X-Internal-Api-Key) — للبوت فقط ───────────────────────
function internalAuth(req, res, next) {
  const key = process.env.INTERNAL_API_KEY || '';
  if (!key) return next();
  const provided = req.headers['x-internal-api-key'] || '';
  try {
    const a = Buffer.from(provided.padEnd(64));
    const b = Buffer.from(key.padEnd(64));
    if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Unauthorized' });
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Helpers: قائمة المجموعات المسموحة (settings table) ────────────────────
const ALLOWED_GROUPS_KEY = 'whatsapp_allowed_groups';

function normalizeName(s) {
  return String(s || '').trim().toLowerCase();
}

function getAllowedGroups(tenantId = DEFAULT_TENANT_ID) {
  const row = db.prepare('SELECT value FROM settings WHERE tenant_id = ? AND key = ?').get(tenantId, ALLOWED_GROUPS_KEY);
  if (!row) return [];
  try {
    const arr = JSON.parse(row.value);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function isGroupAllowed(groupName, tenantId = DEFAULT_TENANT_ID) {
  const list = getAllowedGroups(tenantId);
  if (list.length === 0) return false; // قائمة فارغة = لا شيء مسموح (افتراضي آمن)
  const n = normalizeName(groupName);
  if (!n) return false;
  return list.some(g => normalizeName(g) === n);
}

// ─── Helpers: قراءة الكلمات المفتاحية من جدول settings ──────────────────────
const KW_KEYS = {
  us: 'whatsapp_kw_us',
  them: 'whatsapp_kw_them',
  try: 'whatsapp_kw_try',
  usd: 'whatsapp_kw_usd',
  ignore: 'whatsapp_kw_ignore',
};

function getKeywords(tenantId = DEFAULT_TENANT_ID) {
  const out = { us: [], them: [], try: [], usd: [], ignore: [] };
  for (const [k, key] of Object.entries(KW_KEYS)) {
    const row = db.prepare('SELECT value FROM settings WHERE tenant_id = ? AND key = ?').get(tenantId, key);
    if (row) {
      try {
        const arr = JSON.parse(row.value);
        if (Array.isArray(arr)) out[k] = arr;
      } catch {}
    }
  }
  return out;
}

function getAdminToken(tenantId = DEFAULT_TENANT_ID) {
  const row = db.prepare('SELECT value FROM settings WHERE tenant_id = ? AND key = ?').get(tenantId, 'whatsapp_admin_token');
  return row?.value || 'admin';
}

// ─── يبحث عن أوّل بند مربوط بمجموعة (بالاسم) ─────────────────────────────────
function findItemByGroupName(groupName, tenantId = DEFAULT_TENANT_ID) {
  const n = normalizeName(groupName);
  if (!n) return null;
  const rows = db.prepare(`
    SELECT ac.item_id, ac.whatsapp_group_name, i.name as item_name
    FROM api_configs ac
    JOIN items i ON i.id = ac.item_id AND i.tenant_id = ac.tenant_id
    WHERE ac.provider_type = 'whatsapp_group' AND i.is_active = 1 AND ac.tenant_id = ?
  `).all(tenantId);
  for (const r of rows) {
    if (normalizeName(r.whatsapp_group_name) === n) return r;
  }
  return null;
}

// ingest فقط يحتاج auth (يُستدعى من البوت)
router.post('/ingest', internalAuth, (req, res) => {
  const { tenant_id, group_id, group_name, sender, sender_name, message_id, text, is_group } = req.body;
  if (!text || !group_id) return res.status(400).json({ error: 'text and group_id required' });

  const tId = Number.isInteger(Number(tenant_id)) && Number(tenant_id) > 0 ? Number(tenant_id) : DEFAULT_TENANT_ID;

  const log = (decision, extra = {}) => {
    console.log('[ingest]', JSON.stringify({
      tenant_id: tId, group_name, sender_name, text: text.slice(0, 80), decision, ...extra,
    }));
  };

  // فلترة: نقبل فقط رسائل المجموعات من القائمة المعتمدة
  if (!is_group) {
    log('skipped_not_group');
    return res.json({ ok: true, filtered: true, reason: 'not_group' });
  }
  if (!isGroupAllowed(group_name, tId)) {
    log('skipped_group_not_allowed', { allowed_list: getAllowedGroups(tId) });
    return res.json({ ok: true, filtered: true, reason: 'group_not_in_allowed_list' });
  }

  // 1) حفظ الرسالة الخام (للأرشيف والمراجعة)
  const info = db.prepare(`
    INSERT OR IGNORE INTO whatsapp_messages
      (tenant_id, group_id, group_name, sender, sender_name, message_id, text, is_group)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tId,
    group_id,
    group_name || null,
    sender || null,
    sender_name || null,
    message_id || null,
    text,
    is_group ? 1 : 0
  );

  // لو الرسالة مكرّرة (INSERT OR IGNORE لم يُدخِل)، اخرج
  if (!info.changes) return res.json({ ok: true, duplicate: true });
  const dbMessageId = info.lastInsertRowid;

  // 2) محاولة ربط المجموعة ببند (whatsapp_group provider)
  const link = findItemByGroupName(group_name, tId);
  if (!link) {
    log('no_item_linked');
    return res.json({ ok: true, no_item_linked: true });
  }

  // 3) تحليل النصّ
  const parsed = parseMessage(text, getKeywords(tId));
  if (!parsed) {
    log('parse_failed_no_match');
    return res.json({ ok: true, parsed: null, applied: false });
  }
  if (parsed.ignored) {
    log('parse_ignored', { reason: parsed.reason });
    return res.json({ ok: true, parsed, applied: false });
  }

  // 4) تحديد المصدر (us / them) من اسم المرسل
  const adminToken = getAdminToken(tId);
  const source = isAdminName(sender_name, adminToken) ? 'us' : 'them';

  // 5) حساب الـ delta وتطبيقه على current_values
  const delta = computeDelta({ ...parsed, source });
  const field = parsed.currency === 'USD' ? 'usd_amount' : 'try_amount';

  const cv = db.prepare('SELECT id, try_amount, usd_amount FROM current_values WHERE item_id = ? AND tenant_id = ?').get(link.item_id, tId);
  let balanceAfter;
  if (cv) {
    const current = parsed.currency === 'USD' ? (cv.usd_amount || 0) : (cv.try_amount || 0);
    balanceAfter = current + delta;
    db.prepare(`UPDATE current_values SET ${field} = ? WHERE item_id = ? AND tenant_id = ?`)
      .run(balanceAfter, link.item_id, tId);
  } else {
    balanceAfter = delta;
    db.prepare(`INSERT INTO current_values (tenant_id, item_id, ${field}) VALUES (?, ?, ?)`)
      .run(tId, link.item_id, balanceAfter);
  }

  // 6) حفظ سجل العملية
  db.prepare(`
    INSERT INTO whatsapp_transactions
      (tenant_id, item_id, message_id, source, direction, currency, amount, delta, balance_after, raw_text, sender_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tId,
    link.item_id,
    dbMessageId,
    source,
    parsed.direction,
    parsed.currency,
    parsed.amount,
    delta,
    balanceAfter,
    text,
    sender_name || ''
  );

  log('applied', { item: link.item_name, source, ...parsed, delta, balance_after: balanceAfter });

  res.json({
    ok: true,
    applied: true,
    item_id: link.item_id,
    source,
    direction: parsed.direction,
    currency: parsed.currency,
    amount: parsed.amount,
    delta,
    balance_after: balanceAfter,
  });
});

/**
 * POST /api/internal/whatsapp/preview-parse
 * اختبار محلّل الرسائل بدون حفظ. body: { text, sender_name?, group_name? }
 */
router.post('/whatsapp/preview-parse', (req, res) => {
  const { text, sender_name, group_name, tenant_id } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  const tId = Number.isInteger(Number(tenant_id)) && Number(tenant_id) > 0 ? Number(tenant_id) : DEFAULT_TENANT_ID;
  const keywords = getKeywords(tId);
  const parsed = parseMessage(text, keywords);
  const source = isAdminName(sender_name, getAdminToken(tId)) ? 'us' : 'them';
  const delta = parsed && !parsed.ignored ? computeDelta({ ...parsed, source }) : null;
  const link = group_name ? findItemByGroupName(group_name, tId) : null;
  res.json({
    text,
    sender_name: sender_name || null,
    group_name: group_name || null,
    keywords,
    admin_token: getAdminToken(tId),
    parsed,
    source,
    delta,
    linked_item: link || null,
    group_allowed: group_name ? isGroupAllowed(group_name, tId) : null,
    allowed_groups: getAllowedGroups(tId),
  });
});

/**
 * GET /api/internal/whatsapp/allowed-groups
 * قائمة أسماء المجموعات المعتمدة
 */
router.get('/whatsapp/allowed-groups', (req, res) => {
  const tId = tidFrom(req);
  res.json({ groups: getAllowedGroups(tId) });
});

/**
 * PUT /api/internal/whatsapp/allowed-groups
 * body: { groups: ["اسم المجموعة 1", "اسم المجموعة 2"] }
 */
router.put('/whatsapp/allowed-groups', (req, res) => {
  const tId = tidFrom(req);
  const groups = Array.isArray(req.body?.groups) ? req.body.groups : null;
  if (!groups) return res.status(400).json({ error: 'groups array required' });
  const clean = groups.map(g => String(g || '').trim()).filter(Boolean);
  db.prepare(`
    INSERT INTO settings (tenant_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value
  `).run(tId, ALLOWED_GROUPS_KEY, JSON.stringify(clean));
  res.json({ groups: clean });
});

/**
 * GET /api/internal/whatsapp/health
 * فحص قابلية الوصول للبوت (مستقل عن وجود جلسة)
 *  - reachable=true → البوت يعمل
 *  - reachable=false → البوت متوقف أو BOT_URL خاطئ
 */
router.get('/whatsapp/health', async (req, res) => {
  const botUrl = process.env.BOT_URL || 'http://localhost:3100';
  try {
    const r = await fetch(`${botUrl}/healthz`);
    if (!r.ok) return res.json({ reachable: false, error: `bot_status_${r.status}` });
    const data = await r.json();
    res.json({ reachable: true, ...data });
  } catch (e) {
    res.json({ reachable: false, error: e.code || 'bot_unreachable' });
  }
});

/**
 * GET /api/internal/whatsapp/status
 * الواجهة تستعلم عن حالة جلسة الواتساب من البوت
 *  - 404 من البوت = البوت يعمل لكن لا توجد جلسة بعد ("idle")
 *  - فشل الاتصال أو 5xx = البوت غير متاح ("offline")
 *  - 401 = مشكلة في INTERNAL_API_KEY
 */
router.get('/whatsapp/status', async (req, res) => {
  const botUrl = process.env.BOT_URL || 'http://localhost:3100';
  const key = process.env.INTERNAL_API_KEY || '';
  const tId = tidFrom(req);
  try {
    const r = await fetch(`${botUrl}/sessions/${tId}`, {
      headers: { 'X-Internal-Api-Key': key },
    });
    if (r.status === 404) return res.json({ state: 'idle' });
    if (r.status === 401) return res.json({ state: 'offline', error: 'auth_mismatch' });
    if (!r.ok) return res.json({ state: 'offline', error: `bot_status_${r.status}` });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.json({ state: 'offline', error: e.code || 'bot_unreachable' });
  }
});

/**
 * POST /api/internal/whatsapp/start
 * الواجهة تطلب بدء/إعادة ربط الجلسة
 */
router.post('/whatsapp/start', async (req, res) => {
  const botUrl = process.env.BOT_URL || 'http://localhost:3100';
  const key = process.env.INTERNAL_API_KEY || '';
  const tId = tidFrom(req);
  try {
    const force = req.query.force === '1';
    const r = await fetch(`${botUrl}/sessions/${tId}/start${force ? '?force=1' : ''}`, {
      method: 'POST',
      headers: { 'X-Internal-Api-Key': key, 'Content-Type': 'application/json' },
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/internal/whatsapp/reset
 * مسح كامل لمجلد auth للجلسة + بدء جلسة جديدة (للجلسات العالقة)
 */
router.post('/whatsapp/reset', async (req, res) => {
  const botUrl = process.env.BOT_URL || 'http://localhost:3100';
  const key = process.env.INTERNAL_API_KEY || '';
  const tId = tidFrom(req);
  try {
    const r = await fetch(`${botUrl}/sessions/${tId}/reset`, {
      method: 'POST',
      headers: { 'X-Internal-Api-Key': key, 'Content-Type': 'application/json' },
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/internal/whatsapp/logout
 */
router.post('/whatsapp/logout', async (req, res) => {
  const botUrl = process.env.BOT_URL || 'http://localhost:3100';
  const key = process.env.INTERNAL_API_KEY || '';
  const tId = tidFrom(req);
  try {
    await fetch(`${botUrl}/sessions/${tId}/logout`, {
      method: 'POST',
      headers: { 'X-Internal-Api-Key': key },
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/internal/whatsapp/messages
 * Query params:
 *   - page (default 1)
 *   - pageSize (default 20, max 100)
 *   - financial_only (1 = الرسائل المالية فقط — التي حُلِّلت كحركة لنا/لكم)
 *   - q (بحث في النص أو اسم المرسل أو المجموعة)
 *   - limit (توافق رجعي: لو مُمرَّر، يُتجاهل page/pageSize)
 * Returns: { items, total, page, pageSize, totalPages }
 *  - عند تمرير `limit` فقط: يُرجع المصفوفة المسطّحة (للحفاظ على التوافق).
 */
router.get('/whatsapp/messages', (req, res) => {
  const tId = tidFrom(req);
  // التوافق الرجعي: لو `limit` مُمرَّر، يرجع المصفوفة كما كان
  if (req.query.limit && !req.query.page && !req.query.pageSize) {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const rows = db.prepare(`
      SELECT * FROM whatsapp_messages WHERE tenant_id = ? ORDER BY id DESC LIMIT ?
    `).all(tId, limit);
    return res.json(rows);
  }

  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize) || 20, 1), 100);
  const offset = (page - 1) * pageSize;
  const financialOnly = req.query.financial_only === '1' || req.query.financial_only === 'true';
  const q = String(req.query.q || '').trim();

  const where = ['m.tenant_id = ?'];
  const params = [tId];

  if (financialOnly) {
    // الرسائل المالية = التي لها سجلّ في whatsapp_transactions
    where.push(`EXISTS (SELECT 1 FROM whatsapp_transactions t WHERE t.message_id = m.id AND t.tenant_id = m.tenant_id)`);
  }

  if (q) {
    where.push(`(m.text LIKE ? OR m.sender_name LIKE ? OR m.group_name LIKE ?)`);
    const like = `%${q}%`;
    params.push(like, like, like);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;

  const totalRow = db.prepare(`
    SELECT COUNT(*) as cnt FROM whatsapp_messages m ${whereSql}
  `).get(...params);
  const total = totalRow?.cnt || 0;

  const items = db.prepare(`
    SELECT
      m.*,
      t.id        as tx_id,
      t.source    as tx_source,
      t.direction as tx_direction,
      t.currency  as tx_currency,
      t.amount    as tx_amount,
      t.delta     as tx_delta,
      t.balance_after as tx_balance_after,
      i.name      as tx_item_name
    FROM whatsapp_messages m
    LEFT JOIN whatsapp_transactions t ON t.message_id = m.id AND t.tenant_id = m.tenant_id
    LEFT JOIN items i ON i.id = t.item_id AND i.tenant_id = m.tenant_id
    ${whereSql}
    ORDER BY m.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  res.json({
    items,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
});

/**
 * DELETE /api/internal/whatsapp/messages/:id
 * حذف رسالة واحدة (وحركتها المرتبطة عبر FK ON DELETE SET NULL — تبقى الحركة).
 */
router.delete('/whatsapp/messages/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  const tId = tidFrom(req);
  const info = db.prepare('DELETE FROM whatsapp_messages WHERE id = ? AND tenant_id = ?').run(id, tId);
  res.json({ ok: true, deleted: info.changes });
});

/**
 * POST /api/internal/whatsapp/messages/delete-bulk
 * body: { ids: [1,2,3] }
 */
router.post('/whatsapp/messages/delete-bulk', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(n => parseInt(n)).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids array required' });
  const tId = tidFrom(req);
  const placeholders = ids.map(() => '?').join(',');
  const info = db.prepare(`DELETE FROM whatsapp_messages WHERE tenant_id = ? AND id IN (${placeholders})`).run(tId, ...ids);
  res.json({ ok: true, deleted: info.changes });
});

/**
 * GET /api/internal/whatsapp/groups
 * كل المجموعات التي وصلت منها رسائل (لاكتشاف الأسماء الصحيحة)
 */
router.get('/whatsapp/groups', (req, res) => {
  const tId = tidFrom(req);
  const rows = db.prepare(`
    SELECT group_name, group_id, COUNT(*) as msg_count, MAX(created_at) as last_at
    FROM whatsapp_messages
    WHERE tenant_id = ? AND is_group = 1 AND group_name IS NOT NULL AND group_name != ''
    GROUP BY group_name
    ORDER BY last_at DESC
  `).all(tId);
  res.json(rows);
});

/**
 * GET /api/internal/whatsapp/all-groups
 * كل مجموعات الحساب على واتساب مباشرةً (من البوت)
 */
router.get('/whatsapp/all-groups', async (req, res) => {
  const botUrl = process.env.BOT_URL || 'http://localhost:3100';
  const key = process.env.INTERNAL_API_KEY || '';
  const tId = tidFrom(req);
  try {
    const r = await fetch(`${botUrl}/sessions/${tId}/groups`, {
      headers: { 'X-Internal-Api-Key': key },
    });
    if (!r.ok) return res.json([]);
    const data = await r.json();
    res.json(data);
  } catch {
    res.json([]);
  }
});

/**
 * GET /api/internal/whatsapp/keywords
 * كل قوائم الكلمات + الرمز الإداري (admin token)
 */
router.get('/whatsapp/keywords', (req, res) => {
  const tId = tidFrom(req);
  const kw = getKeywords(tId);
  res.json({
    us: kw.us,
    them: kw.them,
    try: kw.try,
    usd: kw.usd,
    ignore: kw.ignore,
    admin_token: getAdminToken(tId),
  });
});

/**
 * PUT /api/internal/whatsapp/keywords
 * body: { us:[], them:[], try:[], usd:[], ignore:[], admin_token:'admin' }
 */
router.put('/whatsapp/keywords', (req, res) => {
  const tId = tidFrom(req);
  const upsert = db.prepare(`
    INSERT INTO settings (tenant_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value
  `);
  const cleanArr = (a) => Array.isArray(a) ? a.map(s => String(s || '').trim()).filter(Boolean) : null;

  const fields = { us: KW_KEYS.us, them: KW_KEYS.them, try: KW_KEYS.try, usd: KW_KEYS.usd, ignore: KW_KEYS.ignore };
  for (const [k, settingKey] of Object.entries(fields)) {
    const arr = cleanArr(req.body?.[k]);
    if (arr) upsert.run(tId, settingKey, JSON.stringify(arr));
  }
  if (req.body?.admin_token && typeof req.body.admin_token === 'string') {
    upsert.run(tId, 'whatsapp_admin_token', req.body.admin_token.trim() || 'admin');
  }
  res.json({ ok: true });
});

/**
 * GET /api/internal/whatsapp/transactions?item_id=...&limit=50
 * سجلّ العمليات المُحلَّلة لبند معيّن
 */
router.get('/whatsapp/transactions', (req, res) => {
  const tId = tidFrom(req);
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const itemId = req.query.item_id;
  let rows;
  if (itemId) {
    rows = db.prepare(`
      SELECT * FROM whatsapp_transactions WHERE tenant_id = ? AND item_id = ?
      ORDER BY id DESC LIMIT ?
    `).all(tId, itemId, limit);
  } else {
    rows = db.prepare(`
      SELECT t.*, i.name as item_name FROM whatsapp_transactions t
      LEFT JOIN items i ON i.id = t.item_id AND i.tenant_id = t.tenant_id
      WHERE t.tenant_id = ?
      ORDER BY t.id DESC LIMIT ?
    `).all(tId, limit);
  }
  res.json(rows);
});

// ─── Bank message ingest (Google Messages Web scraper) ──────────────────────
/**
 * POST /api/internal/bank-message/ingest
 * يُستدعى من خدمة messages-scraper (port 3101) لكل رسالة جديدة من KUVEYT TURK.
 *
 * Body: {
 *   source: 'gmsg',
 *   contact_name: 'KUVEYT TURK',
 *   text: '<full message text>',
 *   occurred_at: '...'           // اختياري
 *   external_id: '<hash 24 hex>' // ضروري لمنع التكرار
 * }
 *
 * يُعيد استخدام نفس parseSms من routes/bank.js (= صفر مخاطرة على المنطق الحالي).
 * يُخزّن في bank_transactions مع source='gmsg' و external_id (UNIQUE).
 */
router.post('/bank-message/ingest', internalAuth, (req, res) => {
  const { source, text, external_id, occurred_at, contact_name, tenant_id } = req.body || {};

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text required' });
  }
  if (!external_id) {
    return res.status(400).json({ error: 'external_id required' });
  }
  const tId = Number.isInteger(Number(tenant_id)) && Number(tenant_id) > 0 ? Number(tenant_id) : DEFAULT_TENANT_ID;
  const effSource = source === 'gmsg' ? 'gmsg' : 'gmsg'; // حالياً نقبل gmsg فقط من هذا الـ endpoint

  // dedup: لو سبق ودخلت هذه الرسالة بنفس external_id، نُرجع duplicate دون تعديل أي شيء
  const existing = db.prepare(
    'SELECT id FROM bank_transactions WHERE tenant_id = ? AND external_id = ?'
  ).get(tId, external_id);
  if (existing) {
    return res.json({ ok: true, duplicate: true, transaction_id: existing.id });
  }

  // parse — نفس parser SMS الحالي
  const parsed = parseSms(text);
  if (!parsed) {
    // نسجّل المحاولة في bank_sms_log كي تظهر في لوحة التشخيص
    db.prepare(`
      INSERT INTO bank_sms_log
        (tenant_id, ip, secret_ok, parse_status, error_message, sender, raw_body, item_id, direction, amount, transaction_id)
      VALUES (?, ?, 1, 'no_pattern', ?, ?, ?, NULL, '', NULL, NULL)
    `).run(tId, 'gmsg-scraper', 'gmsg: pattern not matched', contact_name || '', text);
    return res.status(422).json({ ok: false, error: 'no_pattern' });
  }

  // اعثر على أوّل بند bank مُفعَّل (نفس منطق webhook الحالي) — مُقيَّد بالمستأجر
  const bankItem = db.prepare(`
    SELECT i.id, cv.try_amount
    FROM items i LEFT JOIN current_values cv ON cv.item_id = i.id AND cv.tenant_id = i.tenant_id
    WHERE i.type = 'bank' AND i.is_active = 1 AND i.tenant_id = ?
    ORDER BY i.sort_order ASC LIMIT 1
  `).get(tId);
  if (!bankItem) {
    db.prepare(`
      INSERT INTO bank_sms_log
        (tenant_id, ip, secret_ok, parse_status, error_message, sender, raw_body, item_id, direction, amount, transaction_id)
      VALUES (?, ?, 1, 'no_bank_item', 'No active bank item', ?, ?, NULL, ?, ?, NULL)
    `).run(tId, 'gmsg-scraper', contact_name || '', text, parsed.direction, parsed.amount);
    return res.status(404).json({ ok: false, error: 'no_bank_item' });
  }

  const currentBalance = bankItem.try_amount || 0;
  const newBalance = parsed.direction === 'in'
    ? currentBalance + parsed.amount
    : currentBalance - parsed.amount;

  // atomic: update balance + insert tx (مع external_id) + log
  let txId;
  try {
    txId = db.transaction(() => {
      db.prepare('UPDATE current_values SET try_amount = ? WHERE item_id = ? AND tenant_id = ?')
        .run(newBalance, bankItem.id, tId);

      const ins = db.prepare(`
        INSERT INTO bank_transactions
          (tenant_id, item_id, direction, amount, sender_receiver, description, transaction_time,
           raw_sms, balance_after, source, external_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        tId,
        bankItem.id,
        parsed.direction,
        parsed.amount,
        parsed.senderReceiver,
        parsed.description,
        parsed.transactionTime || occurred_at || '',
        text,
        newBalance,
        'gmsg',
        external_id,
      );
      const newId = ins.lastInsertRowid;

      db.prepare(`
        INSERT INTO bank_sms_log
          (tenant_id, ip, secret_ok, parse_status, error_message, sender, raw_body, item_id, direction, amount, transaction_id)
        VALUES (?, ?, 1, 'applied', '', ?, ?, ?, ?, ?, ?)
      `).run(tId, 'gmsg-scraper', contact_name || '', text, bankItem.id, parsed.direction, parsed.amount, newId);

      return newId;
    })();
  } catch (e) {
    // SQLITE_CONSTRAINT_UNIQUE → سباق مع طلب آخر بنفس external_id
    if (String(e.message).includes('UNIQUE')) {
      const existing2 = db.prepare(
        'SELECT id FROM bank_transactions WHERE tenant_id = ? AND external_id = ?'
      ).get(tId, external_id);
      return res.json({ ok: true, duplicate: true, transaction_id: existing2?.id });
    }
    return res.status(500).json({ ok: false, error: e.message });
  }

  res.json({
    ok: true,
    applied: true,
    transaction_id: txId,
    direction: parsed.direction,
    amount: parsed.amount,
    balance_before: currentBalance,
    balance_after: newBalance,
    source: effSource,
  });
});

// ─── OTP message ingest (نسخة السكرابر الثانية — AKBANK) ────────────────────
/**
 * POST /api/internal/otp-message/ingest
 * يُستدعى من messages-scraper المُشغَّلة بـ GMSG_MODE=otp (بورت 3102) لكل رسالة
 * جديدة من محادثة AKBANK. يستخرج كود CepSifre ويحفظه في otp_codes.
 *
 * منفصل تماماً عن /bank-message/ingest: لا يمسّ رصيداً ولا bank_transactions
 * ولا ينتمي لأي مستأجر — سجلّه يُقرأ من الصفحة العامّة /islam.
 */
router.post('/otp-message/ingest', internalAuth, otpIngestHandler);

// ─── Bank source status (proxy إلى messages-scraper) ────────────────────────
/**
 * GET /api/internal/bank-message/status
 * الواجهة تستعلم عن حالة messages-scraper (port 3101).
 *  - reachable=false → الخدمة غير متاحة
 */
router.get('/bank-message/status', async (req, res) => {
  const url = process.env.GMSG_SCRAPER_URL || 'http://127.0.0.1:3101';
  const key = process.env.INTERNAL_API_KEY || '';
  try {
    const r = await fetch(`${url}/status`, {
      headers: { 'X-Internal-Api-Key': key },
    });
    if (!r.ok) return res.json({ reachable: false, error: `http_${r.status}` });
    const data = await r.json();
    res.json({ reachable: true, ...data });
  } catch (e) {
    res.json({ reachable: false, error: e.code || 'unreachable' });
  }
});

/**
 * POST /api/internal/bank-message/start
 * أمر بدء/استئناف خدمة messages-scraper
 */
router.post('/bank-message/start', async (req, res) => {
  const url = process.env.GMSG_SCRAPER_URL || 'http://127.0.0.1:3101';
  const key = process.env.INTERNAL_API_KEY || '';
  try {
    const r = await fetch(`${url}/start`, {
      method: 'POST',
      headers: { 'X-Internal-Api-Key': key, 'Content-Type': 'application/json' },
    });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.code || e.message });
  }
});

/**
 * POST /api/internal/bank-message/recheck
 * فحص فوري: هل اكتمل الإقران (قائمة المحادثات ظاهرة)؟ إن نعم — انتقل لـ running
 * بدون إعادة تشغيل المتصفّح. زر "تحديث الحالة" يستدعيه.
 */
router.post('/bank-message/recheck', async (req, res) => {
  const url = process.env.GMSG_SCRAPER_URL || 'http://127.0.0.1:3101';
  const key = process.env.INTERNAL_API_KEY || '';
  try {
    const r = await fetch(`${url}/recheck`, {
      method: 'POST',
      headers: { 'X-Internal-Api-Key': key, 'Content-Type': 'application/json' },
    });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.code || e.message });
  }
});

/**
 * GET /api/internal/bank-message/debug-page
 * يعيد URL/title/body من Chromium الحالي للتشخيص.
 */
router.get('/bank-message/debug-page', async (req, res) => {
  const url = process.env.GMSG_SCRAPER_URL || 'http://127.0.0.1:3101';
  const key = process.env.INTERNAL_API_KEY || '';
  try {
    const r = await fetch(`${url}/debug-page`, {
      headers: { 'X-Internal-Api-Key': key },
    });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.code || e.message });
  }
});

/**
 * GET /api/internal/bank-message/screenshot
 * يعيد JPEG لشاشة Chromium (لعرض QR في الواجهة).
 */
router.get('/bank-message/screenshot', async (req, res) => {
  const url = process.env.GMSG_SCRAPER_URL || 'http://127.0.0.1:3101';
  const key = process.env.INTERNAL_API_KEY || '';
  try {
    const r = await fetch(`${url}/screenshot`, {
      headers: { 'X-Internal-Api-Key': key },
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return res.status(r.status).type('application/json').send(txt || '{"error":"upstream"}');
    }
    const buf = Buffer.from(await r.arrayBuffer());
    const ct = r.headers.get('content-type') || 'image/jpeg';
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.code || e.message });
  }
});

// ─── proxy عام لكل /interact/* (نقر/كتابة/مفتاح/تمرير/تنقّل) ────────────────
async function _proxyToScraper(req, res, subpath) {
  const url = process.env.GMSG_SCRAPER_URL || 'http://127.0.0.1:3101';
  const key = process.env.INTERNAL_API_KEY || '';
  try {
    const r = await fetch(`${url}${subpath}`, {
      method: req.method,
      headers: { 'X-Internal-Api-Key': key, 'Content-Type': 'application/json' },
      body: req.method === 'GET' ? undefined : JSON.stringify(req.body || {}),
    });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.code || e.message });
  }
}

router.post('/bank-message/interact/click',  (req, res) => _proxyToScraper(req, res, '/interact/click'));
router.post('/bank-message/interact/type',   (req, res) => _proxyToScraper(req, res, '/interact/type'));
router.post('/bank-message/interact/key',    (req, res) => _proxyToScraper(req, res, '/interact/key'));
router.post('/bank-message/interact/scroll', (req, res) => _proxyToScraper(req, res, '/interact/scroll'));
router.post('/bank-message/interact/goto',   (req, res) => _proxyToScraper(req, res, '/interact/goto'));
router.get( '/bank-message/interact/url',    (req, res) => _proxyToScraper(req, res, '/interact/url'));

// تشخيص: يعرض آخر رسائل يراها السكرابر + wrappers_count + seen flags.
router.get('/bank-message/peek', (req, res) => _proxyToScraper(req, res, '/peek'));

// إيقاف مؤقّت / استئناف (للسماح بتسجيل دخول Google يدوياً من الواجهة).
router.post('/bank-message/pause',  (req, res) => _proxyToScraper(req, res, '/pause'));
router.post('/bank-message/resume', (req, res) => _proxyToScraper(req, res, '/resume'));

// إعادة معالجة كل الرسائل الواردة المرئية حالياً (تجاوز seen) — لاستعادة رسائل بُلِعت.
router.post('/bank-message/replay', (req, res) => _proxyToScraper(req, res, '/replay'));

export default router;
