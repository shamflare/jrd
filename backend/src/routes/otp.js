import { Router } from 'express';
import db from '../database.js';
import { parseOtpCode, looksLikeAkbank } from '../otpParser.js';

/**
 * سجلّ أكواد OTP لأكبنك — مستقلّ تماماً عن نظام المستأجرين.
 *
 * - الاستقبال: POST /api/internal/otp-message/ingest  (محمي بـ INTERNAL_API_KEY)
 *   يُستدعى من نسخة messages-scraper الثانية (GMSG_MODE=otp) المقترنة
 *   بحساب Google Messages الخاص بـ AKBANK.
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

  // نقبل فقط رسائل أكبنك — النسخة الثانية من السكرابر تفتح محادثة AKBANK
  // فقط، لكن نُكرّر الفحص هنا كي لا تتسرّب رسالة من مصدر آخر لو أُعيد ضبطه.
  if (!looksLikeAkbank({ contactName: contact_name, text })) {
    return res.status(422).json({ ok: false, error: 'not_akbank' });
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

// ─── الراوتر العام (بلا auth) ───────────────────────────────────────────────
const router = Router();

// لا نسمح بأي تخزين وسيط — الصفحة تستطلع كل بضع ثوانٍ وتحتاج أحدث كود.
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.get('/list', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const rows = db.prepare(`
    SELECT id, code, created_at
    FROM otp_codes
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);
  res.json(rows);
});

router.delete('/clear', (req, res) => {
  const info = db.prepare('DELETE FROM otp_codes').run();
  res.json({ success: true, deleted: info.changes });
});

router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM otp_codes WHERE id = ?').run(req.params.id);
  res.json({ success: true, deleted: info.changes });
});

// حالة مصدر الرسائل — تعرضها الصفحة العامّة كمؤشّر "متصل / غير متصل" فقط.
// لا تكشف أي تفاصيل جلسة (بلا selectors أو مسارات ملفات).
router.get('/status', async (req, res) => {
  const url = process.env.GMSG2_SCRAPER_URL || 'http://127.0.0.1:3102';
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
