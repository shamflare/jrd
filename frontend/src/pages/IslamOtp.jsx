import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

/**
 * صفحة عامّة — بلا تسجيل دخول — لعرض أكواد CepSifre الواردة من AKBANK.
 *
 * تستخدم axios مباشرة لا api.js: ذاك يُرفق withCredentials ويوجّه لـ /login
 * عند 401، وهذه الصفحة يجب أن تعمل لزائر بلا جلسة إطلاقاً.
 */
const http = axios.create({ baseURL: '/api/public/otp' });

const POLL_MS = 5000;

function fmtDate(iso) {
  if (!iso) return { date: '—', time: '—' };
  // created_at يأتي من SQLite بصيغة 'YYYY-MM-DD HH:MM:SS' بتوقيت UTC.
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return { date: iso, time: '' };
  return {
    date: d.toLocaleDateString('tr-TR'),
    time: d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  };
}

export default function IslamOtp() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState(null);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await http.get('/list', { params: { limit: 200 } });
      setRows(Array.isArray(r.data) ? r.data : []);
      setErr(null);
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const copy = async (code) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
      setTimeout(() => setCopied((c) => (c === code ? null : c)), 1500);
    } catch {
      /* المتصفّح منع الحافظة — المستخدم يستطيع التحديد يدوياً */
    }
  };

  const clearAll = async () => {
    if (!confirm('مسح السجل بالكامل؟ لا يمكن التراجع.')) return;
    setClearing(true);
    try {
      await http.delete('/clear');
      setRows([]);
    } catch (e) {
      alert('فشل المسح: ' + (e.response?.data?.error || e.message));
    } finally {
      setClearing(false);
    }
  };

  const latest = rows[0];

  return (
    <div dir="rtl" className="min-h-screen bg-slate-100 py-6 px-3">
      <div className="max-w-2xl mx-auto">
        <header className="flex items-center justify-between gap-3 mb-5">
          <h1 className="text-2xl font-bold text-slate-800">🔐 أكواد أكبنك</h1>
          <span className="text-xs text-slate-500">يتحدّث تلقائياً كل {POLL_MS / 1000} ثوانٍ</span>
        </header>

        {/* آخر كود — بارز ليُقرأ من مسافة */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 mb-5 text-center">
          {loading ? (
            <p className="text-slate-400">جارٍ التحميل…</p>
          ) : latest ? (
            <>
              <p className="text-xs text-slate-400 mb-2">آخر كود وارد</p>
              <button
                onClick={() => copy(latest.code)}
                title="اضغط للنسخ"
                className="text-5xl md:text-6xl font-black tracking-[0.2em] text-emerald-700 hover:text-emerald-800 transition-colors"
                dir="ltr"
              >
                {latest.code}
              </button>
              <p className="text-xs text-slate-500 mt-3">
                {fmtDate(latest.created_at).date} — {fmtDate(latest.created_at).time}
                {copied === latest.code && <span className="text-emerald-600 font-bold"> · تم النسخ ✓</span>}
              </p>
            </>
          ) : (
            <p className="text-slate-400 py-4">لا توجد أكواد بعد — بانتظار رسالة من أكبنك.</p>
          )}
        </div>

        {err && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm mb-4">
            تعذّر جلب السجل: {err}
          </div>
        )}

        {/* السجل */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-100">
            <h2 className="font-bold text-slate-700">
              السجل <span className="text-slate-400 font-normal text-sm">({rows.length})</span>
            </h2>
            <button
              onClick={clearAll}
              disabled={clearing || rows.length === 0}
              className="bg-red-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {clearing ? 'جارٍ المسح…' : 'مسح السجل'}
            </button>
          </div>

          {rows.length === 0 ? (
            <p className="text-center text-slate-400 py-10 text-sm">السجل فارغ.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-xs">
                  <tr>
                    <th className="text-right px-4 py-2 font-medium">الكود</th>
                    <th className="text-right px-4 py-2 font-medium">التاريخ</th>
                    <th className="text-right px-4 py-2 font-medium">الوقت</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const { date, time } = fmtDate(r.created_at);
                    return (
                      <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50">
                        <td className="px-4 py-2.5">
                          <button
                            onClick={() => copy(r.code)}
                            title="اضغط للنسخ"
                            className="font-mono font-bold text-base text-slate-800 tracking-widest hover:text-emerald-700"
                            dir="ltr"
                          >
                            {r.code}
                          </button>
                          {copied === r.code && (
                            <span className="text-emerald-600 text-xs mr-2">تم النسخ ✓</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-slate-600 whitespace-nowrap">{date}</td>
                        <td className="px-4 py-2.5 text-slate-600 whitespace-nowrap" dir="ltr">{time}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
