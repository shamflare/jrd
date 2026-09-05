import { useState, useEffect, useRef } from 'react';
import { RefreshCw, Activity, Play, Pause, AlertTriangle, CheckCircle2, MessageSquare, WifiOff } from 'lucide-react';
import { toast } from 'react-toastify';
import api from '../api.js';

/**
 * بطاقة مصدر رسائل Google Messages + متصفّح الإقران التفاعلي.
 *
 * مشتركة بين نسختَي السكرابر — تُميّزهما عبر prop اسمه base:
 *   '/internal/bank-message' → كويت ترك (يُحدّث الرصيد)
 *   '/otp-source'            → أكبنك   (أكواد OTP لصفحة /islam)
 */

// ─── بطاقة مصدر رسائل البنك (Google Messages Web scraper) ─────────────────
const GMSG_STATE_LABELS = {
  idle:            { label: 'جاهز — اضغط بدء',           color: 'bg-gray-100 text-gray-700 border-gray-200',     icon: WifiOff },
  starting:        { label: 'يبدأ التشغيل ...',           color: 'bg-blue-50 text-blue-700 border-blue-200',      icon: RefreshCw },
  pairing:         { label: 'بحاجة إقران (امسح QR محلياً)', color: 'bg-orange-50 text-orange-700 border-orange-200', icon: AlertTriangle },
  opening_chat:    { label: 'يفتح المحادثة ...', color: 'bg-blue-50 text-blue-700 border-blue-200',      icon: RefreshCw },
  running:         { label: 'يعمل — يستطلع كل بضع ثوانٍ', color: 'bg-green-50 text-green-700 border-green-200',   icon: CheckCircle2 },
  session_expired: { label: 'انتهت الجلسة — أعد الإقران',  color: 'bg-orange-50 text-orange-700 border-orange-200', icon: AlertTriangle },
  error:           { label: 'خطأ',                        color: 'bg-red-50 text-red-700 border-red-200',         icon: AlertTriangle },
  stopped:         { label: 'متوقّف',                      color: 'bg-gray-100 text-gray-700 border-gray-200',     icon: WifiOff },
  paused:          { label: 'إيقاف مؤقّت (أكمِل تسجيل الدخول يدوياً)', color: 'bg-indigo-50 text-indigo-700 border-indigo-200', icon: Pause },
};

function minutesAgo(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.round(ms / 60000);
}

export default function GmsgSourceCard({
  status, busy, onStart, onReload, onPeek, onPause, onResume, onReplay,
  peek, peekBusy, replay, replayBusy,
  base = '/internal/bank-message',
  title = 'مصدر الرسائل: Google Messages Web',
}) {
  const reachable = !!status?.reachable;
  const paused = !!status?.paused;
  const rawState = status?.state || 'idle';
  const state = reachable ? (paused ? 'paused' : rawState) : 'offline';
  const cfg = GMSG_STATE_LABELS[state] || { label: state, color: 'bg-gray-100 text-gray-600 border-gray-200', icon: WifiOff };
  const Icon = cfg.icon;

  const lastMsgMin = minutesAgo(status?.last_message_at);
  const lastSeenMin = minutesAgo(status?.last_seen_at);
  const canStart = reachable && ['idle', 'stopped', 'error'].includes(state);
  const wrappersCount = status?.wrappers_count_last_tick;
  const seenCount = status?.seen_count;

  return (
    <div className="bg-white rounded-2xl shadow border border-gray-100 mb-6 p-4" dir="rtl">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <MessageSquare className="text-blue-600" size={20} />
          <h3 className="font-bold text-gray-700">{title}</h3>
        </div>
        <button
          onClick={onReload}
          className="text-gray-400 hover:text-gray-600"
          title="تحديث الحالة"
        >
          <RefreshCw size={16} />
        </button>
      </div>

      {/* شريط الحالة */}
      <div className={`flex items-center gap-2 px-3 py-2 rounded border ${cfg.color} text-sm mb-3`}>
        {reachable
          ? <Icon size={16} className={state === 'starting' || state === 'opening_chat' ? 'animate-spin' : ''} />
          : <WifiOff size={16} />
        }
        <span className="font-bold">
          {reachable ? cfg.label : 'الخدمة غير متاحة'}
        </span>
        {!reachable && status?.error && (
          <span className="text-xs opacity-70 mr-auto">({status.error})</span>
        )}
      </div>

      {/* تفاصيل */}
      {reachable && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs text-gray-600 mb-3">
          <div className="bg-gray-50 rounded p-2">
            <p className="text-gray-400 mb-0.5">جهة الاتصال</p>
            <p className="font-bold text-gray-800">{status.target_contact || '—'}</p>
          </div>
          <div className="bg-gray-50 rounded p-2">
            <p className="text-gray-400 mb-0.5">رسائل معالَجة</p>
            <p className="font-bold text-gray-800">{status.messages_processed_total ?? 0}</p>
          </div>
          <div className="bg-gray-50 rounded p-2">
            <p className="text-gray-400 mb-0.5">آخر استطلاع</p>
            <p className="font-bold text-gray-800">
              {lastSeenMin === null ? '—' : lastSeenMin === 0 ? 'الآن' : `قبل ${lastSeenMin} د`}
            </p>
          </div>
          <div className="bg-gray-50 rounded p-2">
            <p className="text-gray-400 mb-0.5">آخر رسالة جديدة</p>
            <p className="font-bold text-gray-800">
              {lastMsgMin === null ? '—' : lastMsgMin === 0 ? 'الآن' : `قبل ${lastMsgMin} د`}
            </p>
          </div>
          <div className="bg-gray-50 rounded p-2">
            <p className="text-gray-400 mb-0.5">رسائل مرئية الآن</p>
            <p className="font-bold text-gray-800">{wrappersCount ?? '—'}</p>
          </div>
          <div className="bg-gray-50 rounded p-2">
            <p className="text-gray-400 mb-0.5">سجل seen</p>
            <p className="font-bold text-gray-800">{seenCount ?? '—'}</p>
          </div>
        </div>
      )}

      {/* تنبيهات */}
      {reachable && state === 'session_expired' && (
        <div className="bg-orange-50 border border-orange-200 rounded-lg p-3 text-xs text-orange-800 mb-3">
          <AlertTriangle size={14} className="inline ml-1" />
          جلسة Google Messages انتهت. استخدم متصفّح Chromium المُضمّن أدناه لإعادة الإقران.
        </div>
      )}

      {reachable && state === 'running' && wrappersCount === 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-xs text-yellow-800 mb-3">
          <AlertTriangle size={14} className="inline ml-1" />
          الخدمة تعمل لكن لا يَرى أي رسائل (wrappers=0). غالباً <strong>تغيّرت selectors</strong>
          في Google Messages. اضغط <strong>"تشخيص الجلب"</strong> لمعرفة ما يراه السكرابر.
        </div>
      )}

      {reachable && state === 'error' && status?.last_error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-800 mb-3">
          <AlertTriangle size={14} className="inline ml-1" />
          {status.last_error}
        </div>
      )}

      {/* عرض QR Live من شاشة Chromium (للإقران من الواجهة) */}
      {reachable && (['pairing', 'session_expired'].includes(rawState) || paused) && (
        <GmsgPairingQR base={base} onReload={onReload} />
      )}

      {/* أزرار */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button
          onClick={onStart}
          disabled={busy || (!canStart && !paused)}
          className="bg-blue-600 text-white px-3 py-1.5 rounded text-sm hover:bg-blue-700 disabled:opacity-40"
        >
          {busy ? <RefreshCw size={14} className="inline animate-spin ml-1" /> : <Play size={14} className="inline ml-1" />}
          بدء / إعادة تشغيل
        </button>

        {/* Pause/Resume — متاح دائماً ما دام السكرابر حيّاً (للسماح بتسجيل دخول Google يدوياً) */}
        {reachable && !paused && !['idle', 'stopped'].includes(rawState) && (
          <button
            onClick={onPause}
            disabled={busy}
            className="bg-amber-600 text-white px-3 py-1.5 rounded text-sm hover:bg-amber-700 disabled:opacity-40"
            title="أوقف السكرابر لتسجل دخول Google يدوياً، ثم اضغط استئناف"
          >
            <Pause size={14} className="inline ml-1" />
            إيقاف مؤقّت
          </button>
        )}
        {paused && (
          <button
            onClick={onResume}
            disabled={busy}
            className="bg-green-600 text-white px-3 py-1.5 rounded text-sm hover:bg-green-700 disabled:opacity-40"
            title="بعد إتمام تسجيل الدخول وظهور الرسائل اضغط استئناف"
          >
            <Play size={14} className="inline ml-1" />
            استئناف الجلب التلقائي
          </button>
        )}

        {/* Replay — يجبر إعادة معالجة الرسائل المرئية لاستعادة رسالة بُلِعت */}
        {reachable && !paused && (
          <button
            onClick={onReplay}
            disabled={replayBusy || busy}
            className="bg-rose-600 text-white px-3 py-1.5 rounded text-sm hover:bg-rose-700 disabled:opacity-40"
            title="يجبر إرسال كل الرسائل المرئية للباكئند (لاستعادة رسالة بُلِعت)"
          >
            {replayBusy
              ? <><RefreshCw size={14} className="inline animate-spin ml-1" /> جارٍ الإرسال…</>
              : <><RefreshCw size={14} className="inline ml-1" /> إعادة معالجة المرئي</>
            }
          </button>
        )}

        <button
          onClick={onPeek}
          disabled={peekBusy || !reachable}
          className="bg-purple-600 text-white px-3 py-1.5 rounded text-sm hover:bg-purple-700 disabled:opacity-40"
          title="يعرض آخر الرسائل التي يراها السكرابر مع علم seen"
        >
          {peekBusy
            ? <><RefreshCw size={14} className="inline animate-spin ml-1" /> جارٍ القراءة…</>
            : <><Activity size={14} className="inline ml-1" /> تشخيص الجلب</>
          }
        </button>
      </div>

      {/* نتيجة التشخيص */}
      {peek && (
        <div className="text-xs bg-gray-50 border border-gray-200 rounded p-3 mb-2">
          {peek.ok === false ? (
            <div className="text-red-700">
              <AlertTriangle size={14} className="inline ml-1" />
              فشل التشخيص: {peek.error || 'unknown'} {peek.state ? `(state=${peek.state})` : ''}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-3 mb-2 text-gray-700">
                <span>wrappers في الصفحة: <strong>{peek.wrappers_count ?? 0}</strong></span>
                <span>قابل للقراءة (text&gt;5): <strong>{peek.readable_count ?? 0}</strong></span>
                <span>seen: <strong>{peek.seen_count ?? 0}</strong></span>
              </div>
              {peek.active_selectors && (
                <div className="text-gray-500 mb-2" dir="ltr">
                  selectors: list_shell=<code>{peek.active_selectors.list_shell || '—'}</code>{' '}
                  / wrapper=<code>{peek.active_selectors.message_wrapper || '—'}</code>
                </div>
              )}
              {Array.isArray(peek.sample) && peek.sample.length > 0 ? (
                <div className="space-y-1">
                  {peek.sample.map((m, i) => (
                    <div
                      key={i}
                      className={`p-2 rounded border ${m.in_seen ? 'bg-gray-100 border-gray-200 text-gray-500' : 'bg-white border-blue-200'}`}
                    >
                      <div className="flex justify-between items-center mb-1 text-[10px]">
                        <span className="font-bold">
                          {m.direction || '—'} {m.in_seen && '· seen'}
                        </span>
                        <span className="text-gray-400">{m.timestamp || '—'}</span>
                      </div>
                      <div className="text-gray-700 whitespace-pre-wrap break-words leading-relaxed">
                        {m.text_preview || '<empty>'}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-orange-700">
                  لا توجد رسائل مرئية. تحقّق من فتح المحادثة وأن selectors لا تزال صحيحة.
                </div>
              )}
            </>
          )}
        </div>
      )}

      <p className="text-[10px] text-gray-400 leading-relaxed">
        إن انتهت الجلسة (session_expired) ظهر متصفّح Chromium أعلاه — أكمل الإقران مباشرة من الواجهة. لا حاجة لرفع أي ملف.
      </p>

      {/* نتيجة Replay */}
      {replay && (
        <div className="mt-2 text-xs bg-rose-50 border border-rose-200 rounded p-3">
          {replay.ok === false ? (
            <div className="text-red-700">
              <AlertTriangle size={14} className="inline ml-1" />
              فشل: {replay.error || 'unknown'}
            </div>
          ) : (
            <>
              <div className="font-bold mb-1 text-rose-800">
                إعادة معالجة: فُحِصت {replay.scanned ?? 0} رسالة
              </div>
              {Array.isArray(replay.results) && replay.results.length > 0 ? (
                <div className="space-y-1">
                  {replay.results.map((r, i) => (
                    <div
                      key={i}
                      className={`p-1.5 rounded border ${r.applied ? 'bg-green-50 border-green-200' : r.error ? 'bg-red-50 border-red-200' : 'bg-gray-50 border-gray-200'}`}
                    >
                      <div className="flex justify-between text-[10px] mb-1">
                        <span className="font-bold">
                          {r.applied ? '✓ طُبِّقت' : r.error ? '✗ خطأ' : '— تجاهَلها الباكئند'}
                        </span>
                        <span className="text-gray-400" dir="ltr">{r.hash}</span>
                      </div>
                      <div className="text-gray-700 whitespace-pre-wrap break-words text-[11px]">
                        {r.text_preview || '<empty>'}
                      </div>
                      {r.error && <div className="text-red-700 text-[10px] mt-1">{r.error}</div>}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-gray-600">لا رسائل واردة مرئية للمعالجة.</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── مكوّن متصفّح تفاعلي عن بُعد (لإتمام تسجيل دخول Google + الإقران) ──────
function GmsgPairingQR({ base, onReload }) {
  const [tick, setTick] = useState(Date.now());
  const [typing, setTyping] = useState('');
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState('');
  const imgRef = useRef(null);

  // الـ viewport على السيرفر = 1024x768 (نفس clip في scraper.screenshot)
  const SRV_W = 1024;
  const SRV_H = 768;

  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 3000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const r = await api.get(`${base}/interact/url`);
        setUrl(r.data?.url || '');
      } catch { /* ignore */ }
    }, 4000);
    return () => clearInterval(id);
  }, []);

  const handleClick = async (e) => {
    if (busy || !imgRef.current) return;
    const rect = imgRef.current.getBoundingClientRect();
    const xRel = (e.clientX - rect.left) / rect.width;
    const yRel = (e.clientY - rect.top) / rect.height;
    const x = Math.round(xRel * SRV_W);
    const y = Math.round(yRel * SRV_H);
    setBusy(true);
    try {
      await api.post(`${base}/interact/click`, { x, y });
      setTimeout(() => setTick(Date.now()), 600); // تحديث الصورة بعد النقر
    } catch (err) {
      toast.error('فشل النقر: ' + (err.response?.data?.error || err.message));
    } finally { setBusy(false); }
  };

  const sendType = async () => {
    if (!typing) return;
    setBusy(true);
    try {
      await api.post(`${base}/interact/type`, { text: typing });
      setTyping('');
      setTimeout(() => setTick(Date.now()), 400);
    } catch (err) {
      toast.error('فشل: ' + (err.response?.data?.error || err.message));
    } finally { setBusy(false); }
  };

  const sendKey = async (key) => {
    setBusy(true);
    try {
      await api.post(`${base}/interact/key`, { key });
      setTimeout(() => setTick(Date.now()), 600);
    } catch (err) {
      toast.error('فشل: ' + (err.response?.data?.error || err.message));
    } finally { setBusy(false); }
  };

  const sendScroll = async (dy) => {
    setBusy(true);
    try {
      await api.post(`${base}/interact/scroll`, { dy });
      setTimeout(() => setTick(Date.now()), 400);
    } catch (err) {
      toast.error('فشل: ' + (err.response?.data?.error || err.message));
    } finally { setBusy(false); }
  };

  const gotoPairing = async () => {
    setBusy(true);
    try {
      // ينقل المتصفّح مباشرة لصفحة الإقران (تجاوُز welcome + تجنّب Google OAuth الذي يُحجب على Chromium)
      await api.post(`${base}/interact/goto`, {
        url: 'https://messages.google.com/web/authentication',
      });
      setTimeout(() => setTick(Date.now()), 1500);
    } catch (err) {
      toast.error('فشل: ' + (err.response?.data?.error || err.message));
    } finally { setBusy(false); }
  };

  const gotoConversations = async () => {
    setBusy(true);
    try {
      await api.post(`${base}/interact/goto`, {
        url: 'https://messages.google.com/web/conversations',
      });
      setTimeout(() => setTick(Date.now()), 1500);
    } catch (err) {
      toast.error('فشل: ' + (err.response?.data?.error || err.message));
    } finally { setBusy(false); }
  };

  const src = `/api${base}/screenshot?t=${tick}`;

  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-3" dir="rtl">
      <p className="text-sm font-bold text-blue-800 mb-2">
        🖥️ متصفّح Chromium على السيرفر (انقر على الصورة للتفاعل)
      </p>
      <p className="text-xs text-gray-700 mb-2 leading-relaxed">
        سجّل دخول إلى Google ← انتقل لـ Messages ← أكمِل الإقران (مطابقة الرقم).
        كل نقرة/ضغطة مفتاح تُنفَّذ على السيرفر مباشرة.
      </p>

      {url && (
        <div className="text-[10px] text-gray-500 mb-1 font-mono break-all" dir="ltr">{url}</div>
      )}

      <div className="flex flex-wrap gap-2 mb-2">
        <button onClick={gotoPairing} disabled={busy}
          className="bg-purple-600 text-white px-3 py-1.5 rounded text-sm hover:bg-purple-700 disabled:opacity-40">
          🔗 اذهب لشاشة الإقران (QR)
        </button>
        <button onClick={gotoConversations} disabled={busy}
          className="bg-indigo-600 text-white px-3 py-1.5 rounded text-sm hover:bg-indigo-700 disabled:opacity-40">
          💬 افتح المحادثات
        </button>
      </div>

      <div
        className="bg-white border-2 border-blue-300 rounded overflow-hidden cursor-crosshair inline-block"
        style={{ maxWidth: '100%' }}
      >
        <img
          ref={imgRef}
          src={src}
          alt="Chromium remote view"
          onClick={handleClick}
          className="block select-none"
          style={{ maxWidth: '100%', height: 'auto', display: 'block', opacity: busy ? 0.6 : 1 }}
          draggable={false}
        />
      </div>

      <div className="mt-2 flex flex-wrap gap-2 items-center">
        <input
          type="text"
          value={typing}
          onChange={(e) => setTyping(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') sendType(); }}
          placeholder="اكتب نصاً (ثم Enter للإرسال)"
          className="flex-1 min-w-[180px] border border-blue-300 rounded px-2 py-1 text-sm"
          dir="ltr"
          disabled={busy}
        />
        <button onClick={sendType} disabled={busy || !typing}
          className="bg-blue-600 text-white px-3 py-1 rounded text-sm disabled:opacity-40">
          أرسل النصّ
        </button>
        <button onClick={() => sendKey('Enter')} disabled={busy}
          className="bg-gray-600 text-white px-3 py-1 rounded text-sm disabled:opacity-40">
          Enter
        </button>
        <button onClick={() => sendKey('Tab')} disabled={busy}
          className="bg-gray-600 text-white px-3 py-1 rounded text-sm disabled:opacity-40">
          Tab
        </button>
        <button onClick={() => sendKey('Backspace')} disabled={busy}
          className="bg-gray-600 text-white px-3 py-1 rounded text-sm disabled:opacity-40">
          ⌫
        </button>
        <button onClick={() => sendScroll(300)} disabled={busy}
          className="bg-gray-500 text-white px-2 py-1 rounded text-sm disabled:opacity-40">
          ↓ تمرير
        </button>
        <button onClick={() => sendScroll(-300)} disabled={busy}
          className="bg-gray-500 text-white px-2 py-1 rounded text-sm disabled:opacity-40">
          ↑ تمرير
        </button>
        <button onClick={() => setTick(Date.now())}
          className="text-blue-600 hover:underline text-xs mr-auto">
          تحديث الصورة الآن
        </button>
      </div>

      <p className="text-[11px] text-gray-500 mt-2">
        💡 الصورة تتحدّث تلقائياً كل 3 ثوان. بعد إتمام الإقران، الحالة تتحوّل لـ "يعمل".
      </p>
    </div>
  );
}
