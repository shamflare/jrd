import { useState, useEffect, useRef, useCallback } from 'react';
import {
  GitCompareArrows, KeyRound, Play, Loader2, AlertTriangle, CheckCircle2,
  ChevronDown, ChevronLeft, X, RefreshCw, History,
} from 'lucide-react';
import api from '../api.js';

const fmt = (n) => Number(n || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

const DURUM_LABEL = { 2: 'نجحت', 3: 'ألغيت' };
const durumChip = (d) => (
  <span className={`px-2 py-0.5 rounded text-xs font-bold ${
    d === 2 ? 'bg-emerald-100 text-emerald-800' : d === 3 ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-700'
  }`}>{DURUM_LABEL[d] || 'معلّقة'}</span>
);

// ═══ نافذة رموز الآلة الحاسبة ═══════════════════════════════════════════════
function PinModal({ providers, knownApiNames, onClose, onSaved }) {
  const [pins, setPins] = useState(() =>
    Object.fromEntries(providers.map((p) => [p.item_id, p.pin || ''])));
  const [keys, setKeys] = useState(() =>
    Object.fromEntries(providers.map((p) => [p.item_id, p.apisi_key || ''])));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState({});
  const [testResult, setTestResult] = useState({});

  const save = async () => {
    setSaving(true);
    try {
      await api.put('/kontor/pins', { pins, apisiKeys: keys });
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const test = async (itemId) => {
    setTesting((s) => ({ ...s, [itemId]: true }));
    setTestResult((s) => ({ ...s, [itemId]: null }));
    try {
      // نحفظ أولاً — الاختبار يقرأ الرمز من قاعدة البيانات لا من الحقل
      await api.put('/kontor/pins', { pins: { [itemId]: pins[itemId] } });
      const { data } = await api.post(`/kontor/providers/${itemId}/test`);
      setTestResult((s) => ({ ...s, [itemId]: data }));
    } catch (err) {
      setTestResult((s) => ({ ...s, [itemId]: { ok: false, error: err?.response?.data?.error || 'فشل الاتصال' } }));
    } finally {
      setTesting((s) => ({ ...s, [itemId]: false }));
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b">
          <h3 className="text-lg font-bold flex items-center gap-2">
            <KeyRound size={20} className="text-emerald-700" /> رموز الآلة الحاسبة
          </h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded"><X size={20} /></button>
        </div>

        <p className="px-5 pt-4 text-sm text-gray-600">
          الرمز الذي تضغطه على لوحة الأرقام عند الدخول لموقع الجهة.
          <span className="font-bold text-gray-800"> الجهة بلا رمز لا تدخل المقارنة</span> — اتركه فارغاً لاستثنائها.
          <br />
          واسم الجهة في عمود <span className="font-mono">Apisi</span> هو ما يربط صفوف موقعنا بها،
          وهو الاسم المكتوب داخل لوحتنا لا اسم النطاق.
        </p>
        <datalist id="known-apisi-names">
          {(knownApiNames || []).map((n) => <option key={n} value={n} />)}
        </datalist>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {providers.length === 0 && (
            <p className="text-center text-gray-500 py-8">لا توجد جهات من نوع znet في إعدادات API.</p>
          )}
          {providers.map((p) => {
            const r = testResult[p.item_id];
            return (
              <div key={p.item_id} className="border rounded-lg p-3">
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex-1 min-w-[140px]">
                    <div className="font-bold">{p.name}</div>
                    <div className="text-xs text-gray-500 font-mono" dir="ltr">{p.base_url}</div>
                  </div>
                  <input
                    type="text"
                    inputMode="numeric"
                    dir="ltr"
                    placeholder="مثال 111111"
                    value={pins[p.item_id] ?? ''}
                    onChange={(e) => setPins((s) => ({ ...s, [p.item_id]: e.target.value.replace(/\D/g, '') }))}
                    className="w-32 border rounded-lg px-3 py-2 text-center font-mono tracking-widest"
                  />
                  <button
                    onClick={() => test(p.item_id)}
                    disabled={testing[p.item_id] || !pins[p.item_id]}
                    className="px-3 py-2 text-sm rounded-lg bg-gray-100 hover:bg-gray-200 disabled:opacity-40 flex items-center gap-1"
                  >
                    {testing[p.item_id] ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
                    تجربة
                  </button>
                </div>
                <div className="mt-3 flex items-center gap-2 flex-wrap">
                  <label className="text-xs text-gray-600 whitespace-nowrap">
                    اسمها في عمود <span className="font-mono">Apisi</span>
                  </label>
                  <input
                    type="text"
                    list="known-apisi-names"
                    placeholder="مثال: codelinkpins أو تويتي"
                    value={keys[p.item_id] ?? ''}
                    onChange={(e) => setKeys((s) => ({ ...s, [p.item_id]: e.target.value }))}
                    className={`flex-1 min-w-[160px] border rounded-lg px-3 py-1.5 text-sm ${
                      p.apisi_key_is_guess ? 'border-amber-400 bg-amber-50' : ''}`}
                  />
                  {p.apisi_key_is_guess && (
                    <span className="text-xs text-amber-700">مُخمَّن — تأكّد منه</span>
                  )}
                </div>
                {!p.has_password && (
                  <p className="mt-2 text-xs text-amber-700">⚠ لا توجد كلمة سر محفوظة لهذه الجهة في إعدادات API.</p>
                )}
                {r && (
                  <p className={`mt-2 text-xs ${r.ok ? 'text-emerald-700' : 'text-red-600'}`}>
                    {r.ok ? '✅ الدخول نجح' : `❌ ${r.error}`}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <div className="p-5 border-t flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border">إلغاء</button>
          <button onClick={save} disabled={saving}
            className="px-5 py-2 rounded-lg bg-emerald-700 text-white font-bold disabled:opacity-50 flex items-center gap-2">
            {saving && <Loader2 size={16} className="animate-spin" />} حفظ
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══ جدول صفوف ═══════════════════════════════════════════════════════════════
function RowsTable({ entries, pick, showVia }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-gray-600">
          <tr>
            <th className="px-3 py-2 text-right">رقم الخط</th>
            <th className="px-3 py-2 text-right">الباقة</th>
            <th className="px-3 py-2 text-left">سعر الشراء</th>
            <th className="px-3 py-2 text-center">الحالة</th>
            {showVia && <th className="px-3 py-2 text-right">موجودة عندنا عبر</th>}
            <th className="px-3 py-2 text-left">المرجع</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {entries.map((e, i) => {
            const r = pick(e);
            return (
              <tr key={i} className="hover:bg-gray-50">
                <td className="px-3 py-2 font-mono font-bold" dir="ltr">{r.telefon}</td>
                <td className="px-3 py-2">{r.paket}</td>
                <td className="px-3 py-2 text-left font-mono">{fmt(r.alis)} ₺</td>
                <td className="px-3 py-2 text-center">{durumChip(r.durum)}</td>
                {showVia && <td className="px-3 py-2 text-xs text-gray-600">{(e.foundVia || []).join('، ') || '—'}</td>}
                <td className="px-3 py-2 text-left font-mono text-xs text-gray-500" dir="ltr">{r.ref}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Section({ tone, title, count, amount, children, defaultOpen = false, hint }) {
  const [open, setOpen] = useState(defaultOpen);
  const tones = {
    red: 'border-red-300 bg-red-50 text-red-900',
    amber: 'border-amber-300 bg-amber-50 text-amber-900',
    gray: 'border-gray-200 bg-gray-50 text-gray-700',
  };
  if (!count) return null;
  return (
    <div className={`border rounded-xl overflow-hidden ${tones[tone]}`}>
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-3 px-4 py-3 text-right">
        {open ? <ChevronDown size={18} /> : <ChevronLeft size={18} />}
        <span className="font-bold flex-1">{title}</span>
        {amount != null && <span className="font-mono text-sm">{fmt(amount)} ₺</span>}
        <span className="bg-white/70 rounded-full px-2.5 py-0.5 text-sm font-bold">{count}</span>
      </button>
      {open && (
        <div className="bg-white border-t">
          {hint && <p className="px-4 py-2 text-xs text-gray-600 bg-gray-50 border-b">{hint}</p>}
          {children}
        </div>
      )}
    </div>
  );
}

// ═══ الصفحة ══════════════════════════════════════════════════════════════════
export default function KontorCompare() {
  const [providers, setProviders] = useState([]);
  const [ourSite, setOurSite] = useState(null);
  const [knownApiNames, setKnownApiNames] = useState([]);
  const [itemId, setItemId] = useState('');
  const [start, setStart] = useState(daysAgo(6));
  const [end, setEnd] = useState(today());
  const [showPins, setShowPins] = useState(false);
  const [run, setRun] = useState(null);
  const [runs, setRuns] = useState([]);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const pollRef = useRef(null);

  const loadProviders = useCallback(async () => {
    const { data } = await api.get('/kontor/providers');
    setProviders(data.providers);
    setOurSite(data.ourSite);
    setKnownApiNames(data.knownApiNames || []);
    setItemId((cur) => cur || data.providers.find((p) => p.ready)?.item_id || '');
  }, []);

  const loadRuns = useCallback(async () => {
    const { data } = await api.get('/kontor/runs');
    setRuns(data);
  }, []);

  useEffect(() => { loadProviders(); loadRuns(); }, [loadProviders, loadRuns]);

  // استعلام دوري أثناء التشغيل — الروبوت يستغرق دقائق
  useEffect(() => {
    clearInterval(pollRef.current);
    if (run?.status !== 'running') { loadRuns(); return; }
    pollRef.current = setInterval(async () => {
      const { data } = await api.get(`/kontor/runs/${run.id}`);
      setRun(data);
    }, 3000);
    return () => clearInterval(pollRef.current);
  }, [run?.status, run?.id, loadRuns]);

  const startRun = async () => {
    setError('');
    setStarting(true);
    try {
      const { data } = await api.post('/kontor/runs', { itemId, start, end });
      const { data: fresh } = await api.get(`/kontor/runs/${data.runId}`);
      setRun(fresh);
    } catch (err) {
      const code = err?.response?.data?.error;
      setError({
        provider_pin_missing: 'هذه الجهة بلا رمز آلة حاسبة — أضِفه من زر «رموز الآلة الحاسبة».',
        our_site_pin_missing: 'موقعنا بلا رمز آلة حاسبة — أضِفه من إعدادات API.',
        our_site_not_configured: 'لم يُضبط بند «روبوت موقع Bayi Alayatl» في إعدادات API.',
        range_too_long: `المدى أطول من ${err?.response?.data?.maxDays} يوماً.`,
        start_after_end: 'تاريخ البداية بعد تاريخ النهاية.',
      }[code] || code || 'تعذّر بدء المقارنة');
    } finally {
      setStarting(false);
    }
  };

  const openRun = async (id) => {
    const { data } = await api.get(`/kontor/runs/${id}`);
    setRun(data);
  };

  const s = run?.summary;
  const res = run?.result;
  const criticalTheirs = res?.onlyTheirs?.filter((e) => e.severity === 'critical') || [];
  const criticalOurs = res?.onlyOurs?.filter((e) => e.severity === 'critical') || [];
  const explained = res?.onlyTheirs?.filter((e) => e.severity === 'explained') || [];
  const minor = [...(res?.onlyTheirs || []), ...(res?.onlyOurs || [])].filter((e) => e.severity === 'minor');
  const totalCritical = criticalTheirs.length + criticalOurs.length + (res?.statusMismatch?.length || 0);

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-6">
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <GitCompareArrows size={26} className="text-emerald-700" /> مقارنة الأرقام
        </h2>
        <button onClick={() => setShowPins(true)}
          className="px-4 py-2 rounded-lg border bg-white hover:bg-gray-50 flex items-center gap-2">
          <KeyRound size={18} /> رموز الآلة الحاسبة
        </button>
      </div>

      {ourSite && !ourSite.ready && (
        <div className="mb-4 p-3 rounded-lg bg-amber-50 border border-amber-300 text-amber-900 text-sm">
          ⚠ بيانات دخول موقعنا ناقصة (رقم الجوال / كلمة السر / رمز الآلة الحاسبة). أكمِلها من <b>إعدادات API</b>.
        </div>
      )}

      {/* شريط التحكّم */}
      <div className="bg-white rounded-xl shadow p-4 mb-6 flex flex-wrap items-end gap-4">
        <div className="flex-1 min-w-[200px]">
          <label className="block text-sm text-gray-600 mb-1">الجهة</label>
          <select value={itemId} onChange={(e) => setItemId(e.target.value)}
            className="w-full border rounded-lg px-3 py-2">
            <option value="">— اختر جهة —</option>
            {providers.map((p) => (
              <option key={p.item_id} value={p.item_id} disabled={!p.ready}>
                {p.name}{p.ready ? '' : ' (بلا رمز)'}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm text-gray-600 mb-1">من تاريخ</label>
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)}
            className="border rounded-lg px-3 py-2" />
        </div>
        <div>
          <label className="block text-sm text-gray-600 mb-1">إلى تاريخ</label>
          <input type="date" value={end} onChange={(e) => setEnd(e.target.value)}
            className="border rounded-lg px-3 py-2" />
        </div>
        <button onClick={startRun} disabled={!itemId || starting || run?.status === 'running'}
          className="px-6 py-2 rounded-lg bg-emerald-700 text-white font-bold disabled:opacity-50 flex items-center gap-2">
          {starting || run?.status === 'running'
            ? <Loader2 size={18} className="animate-spin" /> : <Play size={18} />}
          بدء المقارنة
        </button>
      </div>

      {error && <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-300 text-red-800 text-sm">{error}</div>}

      {run?.status === 'running' && (
        <div className="bg-white rounded-xl shadow p-6 mb-6 text-center">
          <Loader2 size={28} className="animate-spin mx-auto text-emerald-700 mb-3" />
          <p className="font-bold">{run.stage || 'جارٍ العمل…'}</p>
          <p className="text-sm text-gray-500 mt-1">
            الروبوت يفتح الموقعين ويمرّ على كل الصفحات — قد يستغرق عدة دقائق.
          </p>
        </div>
      )}

      {run?.status === 'error' && (
        <div className="mb-6 p-4 rounded-xl bg-red-50 border border-red-300 text-red-800">
          <p className="font-bold flex items-center gap-2"><AlertTriangle size={18} /> فشلت المقارنة</p>
          <p className="text-sm mt-1">{run.error}</p>
        </div>
      )}

      {run?.status === 'done' && s && (
        <div className="space-y-4 mb-8">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: 'عندنا', value: run.ours_count, tone: 'bg-white' },
              { label: 'عند الجهة', value: run.theirs_count, tone: 'bg-white' },
              { label: 'مطابقة', value: s.matched, tone: 'bg-emerald-50 text-emerald-800' },
              { label: 'تحتاج انتباهك', value: totalCritical, tone: totalCritical ? 'bg-red-50 text-red-800' : 'bg-emerald-50 text-emerald-800' },
            ].map((c) => (
              <div key={c.label} className={`rounded-xl shadow p-4 text-center ${c.tone}`}>
                <div className="text-2xl font-bold">{c.value}</div>
                <div className="text-sm mt-1">{c.label}</div>
              </div>
            ))}
          </div>

          {s.apisiKeyLikelyWrong && (
            <div className="p-4 rounded-xl bg-amber-50 border border-amber-400 text-amber-900">
              <p className="font-bold flex items-center gap-2">
                <AlertTriangle size={18} /> لم نجد أي صفّ لهذه الجهة في موقعنا
              </p>
              <p className="text-sm mt-1">
                بحثنا عن <span className="font-mono font-bold">{s.apisiKey}</span> في عمود
                <span className="font-mono"> Apisi</span> فلم نجده، مع أن موقعنا يحوي {s.oursAllProviders} صفاً.
                الاسم غالباً مكتوب بشكل مختلف — صحّحه من زر «رموز الآلة الحاسبة» واختر الاسم الصحيح
                من القائمة أدناه، ثم أعِد المقارنة.
              </p>
            </div>
          )}

          {totalCritical === 0 && !s.apisiKeyLikelyWrong && (
            <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-300 text-emerald-900 flex items-center gap-3">
              <CheckCircle2 size={22} />
              <span className="font-bold">لا توجد فروقات تستحق الانتباه في هذه المدّة.</span>
            </div>
          )}

          <Section tone="red" defaultOpen title="نجحت عند الجهة وغائبة عندنا"
            count={criticalTheirs.length} amount={s.criticalTheirsAmount}
            hint="الجهة نفّذت شحنة ولا يوجد لها أثر في موقعنا — يُحتمل أنها خُصمت علينا بلا مقابل.">
            <RowsTable entries={criticalTheirs} pick={(e) => e.theirs} />
          </Section>

          <Section tone="amber" defaultOpen title="نجحت عندنا وغائبة عند الجهة"
            count={criticalOurs.length} amount={s.criticalOursAmount}
            hint="خصمنا على المحل ولا يوجد لها أثر عند الجهة.">
            <RowsTable entries={criticalOurs} pick={(e) => e.ours} />
          </Section>

          <Section tone="red" defaultOpen title="اختلاف الحالة بين الطرفين"
            count={res?.statusMismatch?.length || 0} amount={s.statusMismatchAmount}
            hint="نفس العملية بحالتين مختلفتين — مثلاً نجحت عندنا وألغيت عندهم.">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="px-3 py-2 text-right">رقم الخط</th>
                    <th className="px-3 py-2 text-right">الباقة</th>
                    <th className="px-3 py-2 text-left">سعر الشراء</th>
                    <th className="px-3 py-2 text-center">عندنا</th>
                    <th className="px-3 py-2 text-center">عندهم</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {(res?.statusMismatch || []).map((e, i) => (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="px-3 py-2 font-mono font-bold" dir="ltr">{e.ours.telefon}</td>
                      <td className="px-3 py-2">{e.ours.paket}</td>
                      <td className="px-3 py-2 text-left font-mono">{fmt(e.ours.alis)} ₺</td>
                      <td className="px-3 py-2 text-center">{durumChip(e.ours.durum)}</td>
                      <td className="px-3 py-2 text-center">{durumChip(e.theirs.durum)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section tone="gray" title="مفسَّرة تلقائياً — ألغيت عند هذه الجهة ونُفِّذت عندنا عبر جهة أخرى"
            count={explained.length}
            hint="الطلب فشل عند هذه الجهة فأعاد نظامنا توجيهه لجهة أخرى فنجح. ليست فروقاً.">
            <RowsTable entries={explained} pick={(e) => e.theirs} showVia />
          </Section>

          <Section tone="gray" title="ثانوية — ملغاة بلا أثر مالي" count={minor.length}
            hint="عمليات ملغاة عند طرف ولا مقابل لها عند الآخر. لم يتحرّك فيها مال.">
            <RowsTable entries={minor} pick={(e) => e.theirs || e.ours} />
          </Section>

          {s.byApi && (
            <details open={!!s.apisiKeyLikelyWrong} className="bg-white rounded-xl shadow p-4">
              <summary className="cursor-pointer font-bold text-sm text-gray-700">
                توزيع صفوف موقعنا حسب عمود Apisi ({s.oursAllProviders} صفاً)
              </summary>
              <div className="mt-3 flex flex-wrap gap-2">
                {Object.entries(s.byApi).map(([k, v]) => (
                  <span key={k} className="px-3 py-1 rounded-full bg-gray-100 text-sm">{k}: <b>{v}</b></span>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {/* سجلّ التشغيلات */}
      <div className="bg-white rounded-xl shadow overflow-hidden">
        <div className="px-4 py-3 border-b font-bold flex items-center gap-2 text-gray-700">
          <History size={18} /> التشغيلات السابقة
        </div>
        {runs.length === 0 ? (
          <p className="p-6 text-center text-gray-500 text-sm">لا توجد تشغيلات بعد.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="px-3 py-2 text-right">الجهة</th>
                <th className="px-3 py-2 text-right">المدّة</th>
                <th className="px-3 py-2 text-center">الحالة</th>
                <th className="px-3 py-2 text-center">تحتاج انتباهك</th>
                <th className="px-3 py-2 text-left">التاريخ</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {runs.map((r) => {
                const crit = r.summary
                  ? (r.summary.criticalOurs || 0) + (r.summary.criticalTheirs || 0) + (r.summary.statusMismatch || 0)
                  : null;
                return (
                  <tr key={r.id} onClick={() => openRun(r.id)} className="hover:bg-gray-50 cursor-pointer">
                    <td className="px-3 py-2 font-bold">{r.provider_name}</td>
                    <td className="px-3 py-2 text-xs" dir="ltr">{r.start_date} → {r.end_date}</td>
                    <td className="px-3 py-2 text-center">
                      {r.status === 'running' && <span className="text-amber-700">جارية…</span>}
                      {r.status === 'done' && <span className="text-emerald-700">تمّت</span>}
                      {r.status === 'error' && <span className="text-red-600" title={r.error}>فشلت</span>}
                    </td>
                    <td className="px-3 py-2 text-center font-bold">
                      {crit == null ? '—' : <span className={crit ? 'text-red-600' : 'text-emerald-700'}>{crit}</span>}
                    </td>
                    <td className="px-3 py-2 text-left text-xs text-gray-500" dir="ltr">{r.created_at}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {showPins && (
        <PinModal providers={providers} knownApiNames={knownApiNames}
          onClose={() => setShowPins(false)} onSaved={loadProviders} />
      )}
    </div>
  );
}
