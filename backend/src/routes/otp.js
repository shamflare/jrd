import { Router } from 'express';
import db from '../database.js';
import { parseOtpCode, isOtpSender } from '../otpParser.js';

/**
 * سجلّ أكواد OTP لأكبنك — مستقلّ تماماً عن نظام المستأجرين.
 *
 * - الاستقبال: POST /api/internal/otp-message/ingest  (محمي بـ INTERNAL_API_KEY)
 *   يُستدعى من نفس messages-scraper المقترن الذي يقرأ رسائل كويت ترك؛ فهو
 *   يتناوب على محادثتَي KUVEYT TURK و CEPSIFRE في الجلسة نفسها.
 * - العرض/التفريغ: /api/public/otp/*  — عامّ بلا تسجيل دخول (صفحة /islam).
 */

// ─── ingest (يُركَّب داخل /api/internal مع internalAuth) ────────────────────
export function otpIngestHandler(req, res) {
  const { text, external_id, occurred_at, contact_name } = req.body || {};

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text required' });
  }
  if (!external_id) {
    return res.status(400).json({ error: 'external_id required' });
  }

  // النسخة الثانية من السكرابر تفتح محادثة CEPSIFRE فقط، لكن نُكرّر الفحص
  // هنا كي لا تتسرّب رسالة من مصدر آخر لو أُعيد ضبطه.
  if (!isOtpSender({ contactName: contact_name, text })) {
    return res.status(422).json({ ok: false, error: 'not_otp_sender' });
  }

  const existing = db.prepare('SELECT id, code FROM otp_codes WHERE external_id = ?').get(external_id);
  if (existing) {
    return res.json({ ok: true, duplicate: true, id: existing.id, code: existing.code });
  }

  const parsed = parseOtpCode(text);
  if (!parsed) {
    return res.status(422).json({ ok: false, error: 'no_code' });
  }

  try {
    const ins = db.prepare(`
      INSERT INTO otp_codes (code, raw_text, contact_name, external_id, occurred_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(parsed.code, text, contact_name || '', external_id, occurred_at || '');
    return res.json({ ok: true, applied: true, id: ins.lastInsertRowid, code: parsed.code });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      const dup = db.prepare('SELECT id, code FROM otp_codes WHERE external_id = ?').get(external_id);
      return res.json({ ok: true, duplicate: true, id: dup?.id, code: dup?.code });
    }
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─── حدّ المعدّل ────────────────────────────────────────────────────────────
/**
 * نافذة منزلقة بسيطة في الذاكرة — بلا اعتماديات جديدة.
 * ضرورية لأن هذه المسارات عامّة بلا تسجيل دخول، فلا شيء آخر يمنع طرقها بلا حدّ.
 *
 * ملاحظة: خلف Caddy يكون req.socket.remoteAddress هو عنوان الوكيل نفسه،
 * فنعتمد أوّل عنوان في X-Forwarded-For (الذي يضبطه Caddy) كما يفعل bank.js.
 */
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function rateLimit({ windowMs, max }) {
  const hits = new Map(); // ip → { count, resetAt }
  // تنظيف دوري حتى لا تنمو الخريطة بلا حدّ. unref كي لا يمنع إغلاق العملية.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of hits) if (b.resetAt <= now) hits.delete(ip);
  }, Math.max(windowMs, 60_000));
  sweeper.unref?.();

  return (req, res, next) => {
    const now = Date.now();
    const ip = clientIp(req);
    let b = hits.get(ip);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      hits.set(ip, b);
    }
    b.count++;
    if (b.count > max) {
      const retry = Math.ceil((b.resetAt - now) / 1000);
      res.set('Retry-After', String(retry));
      return res.status(429).json({ error: 'rate_limited', retry_after: retry });
    }
    next();
  };
}

// ─── الراوتر العام (بلا auth) ───────────────────────────────────────────────
const router = Router();

// لا نسمح بأي تخزين وسيط — الصفحة تستطلع كل بضع ثوانٍ وتحتاج أحدث كود.
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// الصفحة تستطلع 12 مرّة/دقيقة؛ 120 تترك هامشاً واسعاً لعدّة تبويبات خلف نفس
// الـ IP وتوقف الطرق الآلي. الحذف أندر بكثير فحدّه أضيق.
const readLimit  = rateLimit({ windowMs: 60_000, max: 120 });
const writeLimit = rateLimit({ windowMs: 60_000, max: 20 });

/**
 * GET /list?limit=&after=
 *
 * `after` = أحدث id لدى العميل. حين يُمرَّر نُعيد الأحدث منه فقط — وهو غالباً
 * لا شيء، فيهبط حجم الردّ من ~12KB إلى عشرات البايتات في كل استطلاع.
 *
 * `total` يسمح للعميل بكشف ما لا يظهر في الفروق: لو فرّغ زائر آخر السجل أو
 * حُذف صفّ، يختلف العدد عمّا لديه فيُعيد تحميلاً كاملاً من تلقاء نفسه.
 */
router.get('/list', readLimit, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const after = parseInt(req.query.after, 10);
  const incremental = Number.isInteger(after) && after > 0;

  const rows = incremental
    ? db.prepare('SELECT id, code, created_at FROM otp_codes WHERE id > ? ORDER BY id DESC LIMIT ?').all(after, limit)
    : db.prepare('SELECT id, code, created_at FROM otp_codes ORDER BY id DESC LIMIT ?').all(limit);

  const total = db.prepare('SELECT COUNT(*) AS n FROM otp_codes').get().n;
  res.json({ rows, total });
});

router.delete('/clear', writeLimit, (req, res) => {
  const info = db.prepare('DELETE FROM otp_codes').run();
  res.json({ success: true, deleted: info.changes });
});

router.delete('/:id', writeLimit, (req, res) => {
  const info = db.prepare('DELETE FROM otp_codes WHERE id = ?').run(req.params.id);
  res.json({ success: true, deleted: info.changes });
});

// حالة مصدر الرسائل — تعرضها الصفحة العامّة كمؤشّر "متصل / غير متصل" فقط.
// لا تكشف أي تفاصيل جلسة (بلا selectors أو مسارات ملفات).
router.get('/status', readLimit, async (req, res) => {
  // نفس السكرابر المقترن الذي يقرأ رسائل البنك — لا نسخة ثانية ولا إقران آخر.
  const url = process.env.GMSG_SCRAPER_URL || 'http://127.0.0.1:3101';
  try {
    const r = await fetch(`${url}/status`, {
      headers: { 'X-Internal-Api-Key': process.env.INTERNAL_API_KEY || '' },
    });
    const data = await r.json().catch(() => ({}));
    res.json({
      reachable: true,
      state: data?.state || 'unknown',
      last_seen_at: data?.last_seen_at || null,
      last_message_at: data?.last_message_at || null,
    });
  } catch (e) {
    res.json({ reachable: false, error: e.code || e.message });
  }
});

export default router;
