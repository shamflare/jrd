/**
 * قسم "مقارنة الأرقام".
 *
 * الفكرة: نسحب حركات الكونتور من موقعنا ومن موقع الجهة لنفس مدى التاريخ،
 * ثم نقارنها لنكشف عملية موجودة عند طرف وغائبة عن الآخر.
 *
 * ملاحظتان في التصميم:
 *  - التشغيلة تستغرق دقائق (روبوت متصفح + عشرات الصفحات)، فلا نُبقي طلب
 *    HTTP معلّقاً. ننشئ صفّاً بحالة running ونعيد رقمه فوراً، والواجهة تستعلم.
 *  - نسحب موقعنا مرّة واحدة لكل الجهات ثم نجمّع حسب عمود Apisi. هذا يجعل
 *    الفروق قابلة للتفسير: عملية فشلت عند جهة وأُعيد توجيهها لأخرى نعرفها.
 */
import { Router } from 'express';
import db from '../database.js';
import { tid } from '../tenantHelpers.js';
import { runKontorScraper, testKontorLogin } from '../kontorScraper.js';
import { compareRows } from '../kontorCompare.js';

const router = Router();

// نوع بند موقعنا نحن، مقابل الجهات الخارجية التي تعمل بنفس اللوحة.
const OUR_SITE_TYPE = 'bayi_alayatl';
const PROVIDER_TYPES = new Set(['znet']);

const MAX_RANGE_DAYS = 31;

const getConfig = (t, itemId) =>
  db.prepare('SELECT * FROM api_configs WHERE item_id = ? AND tenant_id = ?').get(itemId, t);

const ourSiteConfig = (t) => db.prepare(`
  SELECT ac.* FROM api_configs ac
  JOIN items i ON i.id = ac.item_id AND i.tenant_id = ac.tenant_id
  WHERE ac.tenant_id = ? AND ac.provider_type = ? AND i.is_active = 1
  ORDER BY ac.item_id LIMIT 1
`).get(t, OUR_SITE_TYPE);

/**
 * تخمين اسم الجهة في عمود Apisi من الرابط — مجرّد قيمة أوّلية.
 *
 * التخمين غير موثوق: اللوحة تكتب في Apisi الاسم المُعرَّف داخلها، وقد يكون
 * عربياً ("تويتي"، "فيكس"، "كرما") فلا علاقة له بالنطاق. صادف أن
 * bayi.codelinkpins.com اسمها في اللوحة "codelinkpins" فنجح التخمين معها
 * وحدها. لذلك القيمة الصحيحة تُحفَظ في api_configs.apisi_key ويضبطها
 * المستخدم من نافذة الرموز، مستعيناً بقائمة الأسماء الفعلية من آخر تشغيلة.
 */
export function guessApisiKey(baseUrl, itemName) {
  try {
    const host = new URL(baseUrl).hostname;              // bayi.codelinkpins.com
    const parts = host.replace(/^bayi\./i, '').split('.'); // codelinkpins.com
    if (parts[0]) return parts[0].toLowerCase();
  } catch { /* رابط غير صالح — نرجع للاسم */ }
  return String(itemName || '').trim().toLowerCase();
}

const effectiveApisiKey = (cfg, itemName) =>
  (cfg?.apisi_key || '').trim() || guessApisiKey(cfg?.base_url, itemName);

/** أسماء Apisi الحقيقية التي رآها آخر سحب ناجح — لتغذية قائمة الاختيار */
function knownApiNames(t) {
  const row = db.prepare(`
    SELECT summary_json FROM kontor_runs
     WHERE tenant_id = ? AND status = 'done' AND summary_json <> ''
     ORDER BY id DESC LIMIT 1
  `).get(t);
  if (!row) return [];
  try {
    return Object.keys(JSON.parse(row.summary_json).byApi || {});
  } catch {
    return [];
  }
}

// ─── الجهات المرشّحة للمقارنة ────────────────────────────────────────────────
router.get('/providers', (req, res) => {
  const t = tid(req);
  const rows = db.prepare(`
    SELECT i.id AS item_id, i.name, ac.provider_type, ac.base_url, ac.kod,
           CASE WHEN ifnull(ac.sifre,'') <> '' THEN 1 ELSE 0 END AS has_password,
           ifnull(ac.pin,'') AS pin, ifnull(ac.apisi_key,'') AS apisi_key
    FROM items i
    JOIN api_configs ac ON ac.item_id = i.id AND ac.tenant_id = i.tenant_id
    WHERE i.tenant_id = ? AND i.is_active = 1
    ORDER BY i.sort_order, i.id
  `).all(t);

  const ours = ourSiteConfig(t);
  res.json({
    ourSite: ours
      ? { item_id: ours.item_id, base_url: ours.base_url, ready: !!(ours.kod && ours.sifre && ours.pin) }
      : null,
    knownApiNames: knownApiNames(t),
    providers: rows
      .filter((r) => PROVIDER_TYPES.has(r.provider_type))
      .map((r) => ({
        item_id: r.item_id,
        name: r.name,
        base_url: r.base_url,
        kod: r.kod,
        has_password: !!r.has_password,
        has_pin: !!r.pin,
        pin: r.pin,
        apisi_key: effectiveApisiKey(r, r.name),
        apisi_key_is_guess: !r.apisi_key,
        // جهة بلا PIN لا تدخل المقارنة — وهذه هي طريقة الاستثناء المقصودة
        ready: !!(r.kod && r.has_password && r.pin),
      })),
  });
});

// ─── حفظ رموز الآلة الحاسبة وأسماء Apisi دفعة واحدة ─────────────────────────
router.put('/pins', (req, res) => {
  const t = tid(req);
  const { pins, apisiKeys } = req.body || {};
  if (!pins && !apisiKeys) return res.status(400).json({ error: 'pins_or_apisiKeys_required' });

  const updPin = db.prepare('UPDATE api_configs SET pin = ? WHERE item_id = ? AND tenant_id = ?');
  const updKey = db.prepare('UPDATE api_configs SET apisi_key = ? WHERE item_id = ? AND tenant_id = ?');

  const saveAll = db.transaction(() => {
    let n = 0;
    for (const [itemId, pin] of Object.entries(pins || {})) {
      const clean = String(pin ?? '').replace(/\D/g, '');   // اللوحة تقبل أرقاماً فقط
      n += updPin.run(clean, Number(itemId), t).changes;
    }
    for (const [itemId, key] of Object.entries(apisiKeys || {})) {
      n += updKey.run(String(key ?? '').trim(), Number(itemId), t).changes;
    }
    return n;
  });

  res.json({ success: true, updated: saveAll() });
});

// ─── تجربة دخول جهة واحدة ────────────────────────────────────────────────────
router.post('/providers/:itemId/test', async (req, res) => {
  const t = tid(req);
  const cfg = getConfig(t, req.params.itemId);
  if (!cfg) return res.status(404).json({ error: 'config_not_found' });
  res.json(await testKontorLogin(cfg, { itemId: cfg.item_id, tenantId: t }));
});

// ─── سجلّ التشغيلات ──────────────────────────────────────────────────────────
router.get('/runs', (req, res) => {
  const t = tid(req);
  const rows = db.prepare(`
    SELECT id, item_id, provider_name, start_date, end_date, status, stage,
           ours_count, theirs_count, summary_json, error, created_at, finished_at
    FROM kontor_runs WHERE tenant_id = ?
    ORDER BY id DESC LIMIT 50
  `).all(t);
  res.json(rows.map((r) => ({ ...r, summary: r.summary_json ? JSON.parse(r.summary_json) : null })));
});

router.get('/runs/:id', (req, res) => {
  const t = tid(req);
  const r = db.prepare('SELECT * FROM kontor_runs WHERE id = ? AND tenant_id = ?').get(req.params.id, t);
  if (!r) return res.status(404).json({ error: 'not_found' });
  res.json({
    ...r,
    summary: r.summary_json ? JSON.parse(r.summary_json) : null,
    result: r.result_json ? JSON.parse(r.result_json) : null,
    summary_json: undefined,
    result_json: undefined,
  });
});

// ─── بدء تشغيلة جديدة ────────────────────────────────────────────────────────
router.post('/runs', (req, res) => {
  const t = tid(req);
  const { itemId, start, end } = req.body || {};

  if (!itemId || !start || !end) return res.status(400).json({ error: 'itemId_start_end_required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return res.status(400).json({ error: 'bad_date_format' });
  }
  if (start > end) return res.status(400).json({ error: 'start_after_end' });

  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
  if (days > MAX_RANGE_DAYS) {
    return res.status(400).json({ error: 'range_too_long', maxDays: MAX_RANGE_DAYS });
  }

  const providerCfg = getConfig(t, itemId);
  if (!providerCfg) return res.status(404).json({ error: 'provider_config_not_found' });
  if (!providerCfg.pin) return res.status(400).json({ error: 'provider_pin_missing' });

  const ours = ourSiteConfig(t);
  if (!ours) return res.status(400).json({ error: 'our_site_not_configured' });
  if (!ours.pin) return res.status(400).json({ error: 'our_site_pin_missing' });

  const item = db.prepare('SELECT name FROM items WHERE id = ? AND tenant_id = ?').get(itemId, t);
  const apisiKey = effectiveApisiKey(providerCfg, item?.name);

  const runId = db.prepare(`
    INSERT INTO kontor_runs (tenant_id, item_id, provider_name, apisi_key, start_date, end_date, status, stage)
    VALUES (?, ?, ?, ?, ?, ?, 'running', 'بدء التشغيل')
  `).run(t, itemId, item?.name || '', apisiKey, start, end).lastInsertRowid;

  // لا ننتظرها: الطلب يعود فوراً والواجهة تستعلم عن التقدّم
  executeRun({ runId, tenantId: t, ours, providerCfg, apisiKey, start, end });

  res.status(202).json({ runId });
});

// ─── تنفيذ التشغيلة في الخلفية ───────────────────────────────────────────────
const setStage = (runId, stage) =>
  db.prepare('UPDATE kontor_runs SET stage = ? WHERE id = ?').run(stage, runId);

async function executeRun({ runId, tenantId, ours, providerCfg, apisiKey, start, end }) {
  try {
    setStage(runId, 'جارٍ سحب البيانات من الموقعين…');

    // بالتوازي: كل روبوت في متصفّح مستقل، فلا سبب لانتظار أحدهما الآخر.
    const [ourResult, theirResult] = await Promise.all([
      runKontorScraper(ours, {
        startDate: start, endDate: end, itemId: ours.item_id, tenantId, label: 'ours',
      }),
      runKontorScraper(providerCfg, {
        startDate: start, endDate: end, itemId: providerCfg.item_id, tenantId, label: apisiKey,
      }),
    ]);

    setStage(runId, 'جارٍ المقارنة…');

    const oursForProvider = ourResult.rows.filter(
      (r) => (r.apisi || '').toLowerCase() === apisiKey.toLowerCase());

    const cmp = compareRows(oursForProvider, theirResult.rows, { allOurRows: ourResult.rows });

    // توزيع صفوفنا على الجهات — يفيد المستخدم في التحقّق من صحّة apisi_key
    const byApi = {};
    for (const r of ourResult.rows) {
      const k = r.apisi || '(فارغ)';
      byApi[k] = (byApi[k] || 0) + 1;
    }

    db.prepare(`
      UPDATE kontor_runs
         SET status = 'done', stage = '', ours_count = ?, theirs_count = ?,
             summary_json = ?, result_json = ?, finished_at = datetime('now')
       WHERE id = ?
    `).run(
      oursForProvider.length,
      theirResult.rows.length,
      JSON.stringify({
        ...cmp.summary,
        oursAllProviders: ourResult.rows.length,
        byApi,
        apisiKey,
        // صفر صفوف عندنا مع وجود صفوف لجهات أخرى = اسم Apisi خاطئ على الأرجح،
        // لا "كل العمليات مفقودة". نُخبر المستخدم بذلك بدل إغراقه بفروق وهمية.
        apisiKeyLikelyWrong: oursForProvider.length === 0 && ourResult.rows.length > 0,
      }),
      JSON.stringify({
        matched: cmp.matched.length,     // لا نخزّن المطابقات — قد تبلغ آلافاً بلا فائدة
        statusMismatch: cmp.statusMismatch,
        onlyOurs: cmp.onlyOurs,
        onlyTheirs: cmp.onlyTheirs,
      }),
      runId,
    );
  } catch (err) {
    db.prepare(`
      UPDATE kontor_runs SET status = 'error', stage = '', error = ?, finished_at = datetime('now')
       WHERE id = ?
    `).run(String(err?.message || err).slice(0, 500), runId);
  }
}

export default router;
