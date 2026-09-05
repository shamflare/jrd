import { useState, useEffect, useCallback } from 'react';
import { toast } from 'react-toastify';
import api from '../api.js';
import GmsgSourceCard from '../components/GmsgSourceCard.jsx';

const BASE = '/otp-source';

/**
 * إدارة نسخة السكرابر الثانية (AKBANK) التي تُغذّي صفحة /islam العامّة.
 * هنا يتمّ إقران Google Messages بحساب أكبنك — منفصل تماماً عن إقران
 * كويت ترك في صفحة /bank.
 */
export default function IslamSource() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [peek, setPeek] = useState(null);
  const [peekBusy, setPeekBusy] = useState(false);
  const [replay, setReplay] = useState(null);
  const [replayBusy, setReplayBusy] = useState(false);
  const [codes, setCodes] = useState([]);

  const loadStatus = useCallback(async () => {
    try {
      const r = await api.get(`${BASE}/status`);
      setStatus(r.data);
    } catch {
      setStatus({ reachable: false, error: 'load_failed' });
    }
  }, []);

  const loadCodes = useCallback(async () => {
    try {
      const r = await api.get('/public/otp/list', { params: { limit: 20 } });
      setCodes(Array.isArray(r.data) ? r.data : []);
    } catch { /* غير حرِج */ }
  }, []);

  useEffect(() => {
    loadStatus();
    loadCodes();
    const id = setInterval(() => { loadStatus(); loadCodes(); }, 15000);
    return () => clearInterval(id);
  }, [loadStatus, loadCodes]);

  const recheck = useCallback(async () => {
    try {
      const r = await api.post(`${BASE}/recheck`);
      if (r.data?.recovered) toast.success('تمّ كشف اكتمال الإقران — يعمل الآن');
    } catch { /* نُكمل بجلب الحالة */ }
    await loadStatus();
  }, [loadStatus]);

  const start = async () => {
    setBusy(true);
    try {
      await api.post(`${BASE}/start`);
      toast.success('تم إرسال أمر التشغيل');
      setTimeout(loadStatus, 2000);
    } catch (e) {
      toast.error('فشل: ' + (e.response?.data?.error || e.message));
    } finally { setBusy(false); }
  };

  const runPeek = useCallback(async () => {
    setPeekBusy(true);
    try {
      const r = await api.get(`${BASE}/peek`);
      setPeek(r.data);
    } catch (e) {
      setPeek({ ok: false, error: e.response?.data?.error || e.message });
    } finally { setPeekBusy(false); }
  }, []);

  const pause = useCallback(async () => {
    setBusy(true);
    try {
      await api.post(`${BASE}/pause`);
      toast.info('تمّ الإيقاف مؤقّتاً — أكمِل تسجيل دخول Google');
      setTimeout(loadStatus, 1000);
    } catch (e) {
      toast.error('فشل: ' + (e.response?.data?.error || e.message));
    } finally { setBusy(false); }
  }, [loadStatus]);

  const resume = useCallback(async () => {
    setBusy(true);
    try {
      const r = await api.post(`${BASE}/resume`);
      if (r.data?.recovered) toast.success('تمّ الاستئناف — يعمل الآن');
      else toast.info('تمّ الاستئناف');
      setTimeout(loadStatus, 2000);
    } catch (e) {
      toast.error('فشل: ' + (e.response?.data?.error || e.message));
    } finally { setBusy(false); }
  }, [loadStatus]);

  const doReplay = useCallback(async () => {
    setReplayBusy(true);
    try {
      const r = await api.post(`${BASE}/replay`);
      setReplay(r.data);
      setTimeout(loadCodes, 500);
    } catch (e) {
      setReplay({ ok: false, error: e.response?.data?.error || e.message });
    } finally { setReplayBusy(false); }
  }, [loadCodes]);

  return (
    <div className="max-w-3xl mx-auto" dir="rtl">
      <h1 className="text-2xl font-bold text-gray-800 mb-2">🔐 مصدر أكواد أكبنك</h1>
      <p className="text-sm text-gray-500 mb-6">
        هذه النسخة تفتح محادثة <strong>AKBANK</strong> فقط وتستخرج كود CepSifre،
        وتُغذّي الصفحة العامّة{' '}
        <a href="/islam" target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">/islam</a>.
        إقرانها مستقلّ عن إقران كويت ترك — استخدم حساب Google الخاص بأكبنك عند الإقران.
      </p>

      <GmsgSourceCard
        base={BASE}
        title="مصدر رسائل أكبنك: Google Messages Web"
        status={status}
        busy={busy}
        onStart={start}
        onReload={recheck}
        onPeek={runPeek}
        onPause={pause}
        onResume={resume}
        onReplay={doReplay}
        peek={peek}
        peekBusy={peekBusy}
        replay={replay}
        replayBusy={replayBusy}
      />

      {/* آخر الأكواد — تأكيد سريع أن الجلب يعمل */}
      <div className="bg-white rounded-2xl shadow border border-gray-100 p-4">
        <h3 className="font-bold text-gray-700 mb-3">آخر الأكواد المُستخرَجة</h3>
        {codes.length === 0 ? (
          <p className="text-sm text-gray-400">لا أكواد بعد.</p>
        ) : (
          <ul className="text-sm divide-y divide-gray-100">
            {codes.map((c) => (
              <li key={c.id} className="flex justify-between py-2">
                <span className="font-mono font-bold tracking-widest text-gray-800" dir="ltr">{c.code}</span>
                <span className="text-gray-400 text-xs" dir="ltr">{c.created_at}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
