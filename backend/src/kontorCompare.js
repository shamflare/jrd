/**
 * محرّك مقارنة حركات الكونتور بين موقعنا وموقع جهة.
 *
 * مفتاح المطابقة: رقم الهاتف + سعر الشراء (Alış).
 *   - اسم الباقة لا يصلح: نفس العملية تُسمّى "✅100 TL" عندنا و
 *     "100₺ Telsiz Borcu" عندهم.
 *   - رقم الهاتف وحده لا يصلح: الرقم قد يُشحن مرّات في اليوم، وربما عبر
 *     جهات مختلفة، فيختلط كل شيء.
 *   - Alış متطابق حرفياً بين الطرفين (سعر شرائنا منهم)، فهو المرساة.
 *
 * والمقارنة بالعدّ لا بالوجود: لو شُحن رقم مرتين عندنا ومرة عندهم، الفرق
 * عملية واحدة لا صفر.
 */

// رموز الحالة في اللوحة: 2 = تمّت، 3 = ألغيت. غيرها = معلّقة/قيد التنفيذ.
export const DURUM_SUCCESS = 2;
export const DURUM_CANCELLED = 3;

/** آخر ١٠ خانات — يوحّد 0532… / 90532… / +90 532 … */
export function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** مفتاح المطابقة: هاتف + سعر شراء بخانتين عشريتين */
export function rowKey(row) {
  const phone = normalizePhone(row.telefon);
  const alis = Number.isFinite(row.alis) ? row.alis.toFixed(2) : '?';
  return phone + '|' + alis;
}

const isSuccess = (row) => row.durum === DURUM_SUCCESS;

/**
 * تصنيف خطورة الفرق.
 *
 * الفرق الخام مضلّل: في أول تشغيلة حقيقية ظهر ١٢ فرقاً، ١١ منها تفسيرها
 * أن الطلب فشل عند هذه الجهة فأعاد نظامنا توجيهه إلى جهة أخرى فنجح —
 * فبقيت المحاولة الفاشلة في سجلّهم وحده. واحد فقط كان فرقاً حقيقياً.
 * عرض الاثني عشر بنفس اللون يُخفي الواحد المهم بينها.
 *
 *   critical  = نجحت عند طرف وغائبة تماماً عن الآخر  → مال تحرّك بلا مقابل
 *   explained = ملغاة عندهم، ونفس الرقم نُفِّذ عندنا عبر جهة أخرى
 *   minor     = ملغاة ولا أثر لها — لا مال تحرّك
 */
function severityOf(row, side, phoneIndex) {
  if (row.durum === DURUM_SUCCESS) return 'critical';
  if (side === 'theirs') {
    const elsewhere = phoneIndex.get(normalizePhone(row.telefon));
    if (elsewhere && elsewhere.size) return 'explained';
  }
  return 'minor';
}

/**
 * @param {object[]} ours    صفوف موقعنا (مفلترة على الجهة عبر apisi)
 * @param {object[]} theirs  صفوف موقع الجهة
 * @param {object}   opts    { allOurRows } كل صفوف موقعنا لكل الجهات —
 *                           تُستخدم لتفسير الفروق الناتجة عن إعادة التوجيه
 * @returns تصنيف كامل + ملخّص
 */
export function compareRows(ours, theirs, opts = {}) {
  // فهرس: رقم الهاتف → مجموعة الجهات التي نُفِّذ عبرها عندنا (ما عدا هذه الجهة)
  const phoneIndex = new Map();
  const thisApi = new Set(ours.map((r) => (r.apisi || '').toLowerCase()));
  for (const r of opts.allOurRows || []) {
    const api = (r.apisi || '').toLowerCase();
    if (thisApi.has(api)) continue;
    const p = normalizePhone(r.telefon);
    if (!phoneIndex.has(p)) phoneIndex.set(p, new Set());
    phoneIndex.get(p).add(r.apisi || '؟');
  }

  /** @type {Map<string,{ours:object[],theirs:object[]}>} */
  const buckets = new Map();
  const bucket = (k) => {
    if (!buckets.has(k)) buckets.set(k, { ours: [], theirs: [] });
    return buckets.get(k);
  };
  for (const r of ours) bucket(rowKey(r)).ours.push(r);
  for (const r of theirs) bucket(rowKey(r)).theirs.push(r);

  const matched = [];         // موجودة عند الطرفين بنفس الحالة
  const statusMismatch = [];  // موجودة عند الطرفين بحالتين مختلفتين
  const onlyOurs = [];        // عندنا وليست عندهم
  const onlyTheirs = [];      // عندهم وليست عندنا

  for (const [key, g] of buckets) {
    // نُرتّب داخل المفتاح ليكون الاقتران ثابتاً بين تشغيلتين
    const a = [...g.ours].sort((x, y) => String(x.ref).localeCompare(String(y.ref)));
    const b = [...g.theirs].sort((x, y) => String(x.ref).localeCompare(String(y.ref)));
    const pairs = Math.min(a.length, b.length);

    for (let i = 0; i < pairs; i++) {
      const entry = { key, ours: a[i], theirs: b[i] };
      if (isSuccess(a[i]) === isSuccess(b[i])) matched.push(entry);
      else statusMismatch.push(entry);
    }
    for (let i = pairs; i < a.length; i++) {
      onlyOurs.push({ key, ours: a[i], severity: severityOf(a[i], 'ours', phoneIndex) });
    }
    for (let i = pairs; i < b.length; i++) {
      const sev = severityOf(b[i], 'theirs', phoneIndex);
      const via = phoneIndex.get(normalizePhone(b[i].telefon));
      onlyTheirs.push({ key, theirs: b[i], severity: sev, foundVia: via ? [...via] : [] });
    }
  }

  // ترتيب حسب الخطورة المالية: الأكبر مبلغاً أولاً
  const byAmount = (get) => (x, y) => (get(y)?.alis || 0) - (get(x)?.alis || 0);
  onlyOurs.sort(byAmount((e) => e.ours));
  onlyTheirs.sort(byAmount((e) => e.theirs));
  statusMismatch.sort(byAmount((e) => e.theirs || e.ours));

  const sum = (list, get) => list.reduce((t, e) => t + (get(e)?.alis || 0), 0);
  const critical = (list) => list.filter((e) => e.severity === 'critical');

  const criticalOurs = critical(onlyOurs);
  const criticalTheirs = critical(onlyTheirs);

  return {
    matched,
    statusMismatch,
    onlyOurs,
    onlyTheirs,
    summary: {
      oursTotal: ours.length,
      theirsTotal: theirs.length,
      matched: matched.length,
      statusMismatch: statusMismatch.length,
      onlyOurs: onlyOurs.length,
      onlyTheirs: onlyTheirs.length,
      // ما يستحق انتباه المستخدم فعلاً — الباقي ضجيج مفسَّر
      criticalOurs: criticalOurs.length,
      criticalTheirs: criticalTheirs.length,
      explained: onlyTheirs.filter((e) => e.severity === 'explained').length,
      minor: [...onlyOurs, ...onlyTheirs].filter((e) => e.severity === 'minor').length,
      // المبالغ تُقاس بسعر الشراء — هو ما ندفعه فعلاً للجهة
      criticalOursAmount: +sum(criticalOurs, (e) => e.ours).toFixed(2),
      criticalTheirsAmount: +sum(criticalTheirs, (e) => e.theirs).toFixed(2),
      statusMismatchAmount: +sum(statusMismatch, (e) => e.theirs).toFixed(2),
    },
  };
}
