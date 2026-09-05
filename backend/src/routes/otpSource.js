import { Router } from 'express';

/**
 * otpSource — proxy إلى نسخة messages-scraper الثانية (AKBANK / OTP).
 *
 * النسخة الثانية تعمل على 3102 بمجلّد بروفايل مستقلّ، مقترنة بحساب
 * Google Messages الخاص بأكبنك — معزولة تماماً عن سكرابر كويت ترك (3101)
 * حتى لا يؤثّر إقران أحدهما على الآخر.
 *
 * ⚠ يُركَّب في index.js بعد requireAuth: شاشة الإقران تعرض متصفّح السيرفر
 * وتسمح بالنقر/الكتابة فيه، فلا يجوز أن تكون عامّة (بخلاف صفحة /islam
 * التي تعرض الأكواد فقط).
 */

const router = Router();

function scraperUrl() {
  return process.env.GMSG2_SCRAPER_URL || 'http://127.0.0.1:3102';
}

async function proxy(req, res, subpath, method) {
  const m = method || req.method;
  try {
    const r = await fetch(`${scraperUrl()}${subpath}`, {
      method: m,
      headers: {
        'X-Internal-Api-Key': process.env.INTERNAL_API_KEY || '',
        'Content-Type': 'application/json',
      },
      body: m === 'GET' ? undefined : JSON.stringify(req.body || {}),
    });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.code || e.message });
  }
}

router.get('/status', async (req, res) => {
  try {
    const r = await fetch(`${scraperUrl()}/status`, {
      headers: { 'X-Internal-Api-Key': process.env.INTERNAL_API_KEY || '' },
    });
    const data = await r.json().catch(() => ({}));
    res.json({ reachable: true, ...data });
  } catch (e) {
    res.json({ reachable: false, error: e.code || e.message });
  }
});

router.post('/start',   (req, res) => proxy(req, res, '/start'));
router.post('/recheck', (req, res) => proxy(req, res, '/recheck'));
router.post('/pause',   (req, res) => proxy(req, res, '/pause'));
router.post('/resume',  (req, res) => proxy(req, res, '/resume'));
router.post('/replay',  (req, res) => proxy(req, res, '/replay'));
router.get('/peek',     (req, res) => proxy(req, res, '/peek'));

router.post('/interact/click',  (req, res) => proxy(req, res, '/interact/click'));
router.post('/interact/type',   (req, res) => proxy(req, res, '/interact/type'));
router.post('/interact/key',    (req, res) => proxy(req, res, '/interact/key'));
router.post('/interact/scroll', (req, res) => proxy(req, res, '/interact/scroll'));
router.post('/interact/goto',   (req, res) => proxy(req, res, '/interact/goto'));
router.get('/interact/url',     (req, res) => proxy(req, res, '/interact/url'));

// لقطة شاشة متصفّح السيرفر (لإتمام الإقران من الواجهة) — تُعاد كصورة خام.
router.get('/screenshot', async (req, res) => {
  try {
    const r = await fetch(`${scraperUrl()}/screenshot`, {
      headers: { 'X-Internal-Api-Key': process.env.INTERNAL_API_KEY || '' },
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      return res.status(r.status).json(data);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.code || e.message });
  }
});

export default router;
