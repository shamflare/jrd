import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function str(name, def = '') {
  const v = process.env[name];
  return v == null || v === '' ? def : String(v);
}
function int(name, def) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) ? v : def;
}
function bool(name, def) {
  const v = String(process.env[name] || '').toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return def;
}

export const config = {
  port: int('GMSG_PORT', 3101),
  host: str('GMSG_HOST', '0.0.0.0'),

  internalApiKey: str('INTERNAL_API_KEY', ''),
  backendUrl: str('BACKEND_URL', 'http://127.0.0.1:3001'),

  // معرّف المستأجر — يُرسَل مع كل ingest إلى backend لعزل البيانات.
  // افتراضي 1 للتوافق الرجعي (instance قديم بدون env).
  tenantId: int('GMSG_TENANT_ID', 1),

  browserDataDir: str('GMSG_BROWSER_DATA', '') || path.join(__dirname, '..', 'browser-data'),
  headless: bool('GMSG_HEADLESS', true),
  // محادثات البنك (الرصيد). تقبل عدّة أسماء مفصولة بفاصلة.
  targetContact: str('GMSG_TARGET_CONTACT', 'KUVEYT TURK'),

  // محادثات أكواد OTP (صفحة /islam). مُرسِل أكواد أكبنك اسمه CEPSIFRE لا AKBANK.
  //
  // منفصلة عن GMSG_TARGET_CONTACT عمداً: خوادم الإنتاج تضبط الأخيرة في ملف
  // .env على "KUVEYT TURK"، فلو أضفنا CEPSIFRE إلى قيمتها الافتراضية لتجاهلها
  // .env ولما عمل شيء دون تعديل يدوي على السيرفر. اجعلها فارغة لتعطيل الأكواد.
  // ملاحظة: لا نستخدم str() هنا لأنه يُعيد القيمة الافتراضية عند القيمة
  // الفارغة، فتصبح `GMSG_OTP_CONTACTS=` عديمة الأثر. نُميّز "غير مضبوطة"
  // (⇒ الافتراضي) عن "مضبوطة فارغة" (⇒ تعطيل الأكواد).
  otpContact: process.env.GMSG_OTP_CONTACTS === undefined
    ? 'CEPSIFRE'
    : String(process.env.GMSG_OTP_CONTACTS),

  get bankContacts() {
    return this.targetContact.split(',').map((s) => s.trim()).filter(Boolean);
  },
  get otpContacts() {
    return this.otpContact.split(',').map((s) => s.trim()).filter(Boolean);
  },
  /** كل المحادثات التي نتناوب عليها في نفس الجلسة المقترنة. */
  get targetContacts() {
    return [...this.bankContacts, ...this.otpContacts];
  },

  pollIntervalMs: int('GMSG_POLL_INTERVAL_MS', 12000),
  navTimeoutMs: int('GMSG_NAV_TIMEOUT_MS', 45000),
  pairingTimeoutSec: int('GMSG_PAIRING_TIMEOUT_SEC', 1800),

  // عدد آخر الرسائل التي نقرأها كل دورة بحثاً عن الجديد
  scanLastN: int('GMSG_SCAN_LAST_N', 20),

  // التشغيل التلقائي عند الإقلاع (true في الإنتاج، false محلياً لو أردت ضبط يدوي)
  autoStart: bool('GMSG_AUTOSTART', true),

  // مسار ملف seen.json (داخل browserDataDir افتراضياً)
  seenFile: '', // يُحسب لاحقاً
};

config.seenFile = path.join(config.browserDataDir, 'seen.json');
