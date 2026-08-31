/**
 * تشغيل روبوت حركات الكونتور (scraper/src/kontor.js) كعملية منفصلة.
 * نفس فلسفة scrapers.js: عملية ابن، مهلة، والتقاط RESULT_JSON من stdout.
 *
 * الفارق أن هذا الروبوت يُشغَّل مرّتين لكل مقارنة — على موقعنا وعلى موقع
 * الجهة — ولذلك يأخذ الاعتماديات وسيطاً بدل قراءتها من البيئة.
 */
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRAPER_DIR = process.env.SCRAPER_DIR
  ? path.resolve(process.env.SCRAPER_DIR)
  : path.join(__dirname, '..', '..', 'scraper');
const KONTOR_ENTRY = path.join(SCRAPER_DIR, 'src', 'kontor.js');
const LOGIN_TEST_ENTRY = path.join(SCRAPER_DIR, 'src', 'login-test.js');
const BROWSER_DATA_ROOT = process.env.DATA_DIR
  ? path.join(path.resolve(process.env.DATA_DIR), 'browser-data')
  : path.join(SCRAPER_DIR, 'browser-data');

// أطول من مهلة الأرصدة: شهر كامل قد يبلغ عشرات الصفحات.
const TIMEOUT_MS = parseInt(process.env.KONTOR_TIMEOUT_MS || '600000', 10);

/** يحوّل YYYY-MM-DD (صيغة <input type=date>) إلى dd.MM.yyyy التي تفهمها اللوحة */
export function toPanelDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso || '');
}

/** يتحقّق من الاعتماديات ويبني بيئة التشغيل المشتركة بين الروبوتين */
function buildEnv(cfg, { itemId, tenantId = 1, requirePin = true }) {
  const phone = (cfg?.kod || '').trim();
  const password = (cfg?.sifre || '').trim();
  const pin = (cfg?.pin || '').trim();
  const baseUrl = (cfg?.base_url || '').trim();

  if (!baseUrl) throw new Error('رابط الموقع (Base URL) غير محدَّد');
  if (!phone || !password) throw new Error('بيانات الدخول ناقصة (رقم الجوال أو كلمة السر)');
  if (requirePin && !pin) throw new Error('رمز الآلة الحاسبة (PIN) غير محدَّد لهذه الجهة');

  // عزل ملف المتصفح لكل مستأجر+بند: الجلسة وبصمة الجهاز تخصّ حساباً واحداً،
  // وخلطها بين الجهات يُخرج أحدها من جلسته باستمرار.
  const browserDir = path.join(BROWSER_DATA_ROOT, `t${tenantId}`, `kontor-${itemId}`);
  fs.mkdirSync(browserDir, { recursive: true });

  return {
    BAYI_LOGIN_URL: baseUrl,
    BAYI_PHONE: phone,
    BAYI_PASSWORD: password,
    BAYI_PIN: pin,
    HEADLESS: 'true',
    BROWSER_DATA_DIR: browserDir,
  };
}

/**
 * @param {object} cfg   { base_url, kod, sifre, pin }
 * @param {object} opts  { startDate, endDate, itemId, tenantId, label }
 * @returns {Promise<{rows:object[], expected:number, scraped:number, pages:number, complete:boolean}>}
 */
export function runKontorScraper(cfg, opts = {}) {
  const { startDate, endDate, itemId, tenantId = 1, label = 'kontor' } = opts;

  return new Promise((resolve, reject) => {
    let baseEnv;
    try {
      baseEnv = buildEnv(cfg, { itemId, tenantId });
    } catch (err) {
      return reject(err);
    }

    const child = spawn(process.execPath, [KONTOR_ENTRY], {
      cwd: SCRAPER_DIR,
      env: {
        ...process.env,
        ...baseEnv,
        KONTOR_START: toPanelDate(startDate),
        KONTOR_END: toPanelDate(endDate),
      },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      // لا نطبع RESULT_JSON — قد يبلغ ميغابايت
      for (const line of s.split('\n')) {
        if (line.trim() && !line.startsWith('RESULT_JSON=')) console.log(`[${label}] ${line.trim()}`);
      }
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      process.stderr.write(`[${label}:err] ${s}`);
    });

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`انتهت مهلة الروبوت بعد ${Math.round(TIMEOUT_MS / 1000)} ثانية`));
    }, TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error('تعذّر تشغيل الروبوت: ' + err.message));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const match = stdout.match(/RESULT_JSON=(\{.*)/);
      if (match) {
        let parsed;
        try {
          parsed = JSON.parse(match[1]);
        } catch (err) {
          return reject(new Error('مخرَج الروبوت غير صالح: ' + err.message));
        }
        // exit code 3 = عدد الصفوف لا يطابق Toplam Kayıt. لا نقبل نتيجة ناقصة:
        // مقارنة مبنيّة على بيانات ناقصة تُظهر فروقات وهمية وتضيّع وقت المستخدم.
        if (!parsed.complete) {
          return reject(new Error(
            `سحب ناقص: الموقع يقول ${parsed.expected} عملية والمسحوب ${parsed.scraped}`));
        }
        return resolve(parsed);
      }
      const lines = (stdout + '\n' + stderr).split('\n').map((l) => l.trim()).filter(Boolean);
      const errLine = lines.find((l) => l.startsWith('[error]'));
      const meaningful = errLine ? errLine.replace(/^\[error\]\s*/, '') : lines.slice(-5).join(' | ');
      reject(new Error(`فشل الروبوت (رمز ${code}): ${meaningful.slice(0, 400)}`));
    });
  });
}

/**
 * اختبار دخول سريع — يُستخدم من زر "تجربة" في نافذة الرموز، ليكتشف المستخدم
 * الاعتمادية الخاطئة في ثوانٍ بدل أن ينتظر مقارنة كاملة تفشل في نهايتها.
 * @returns {Promise<{ok:boolean, error?:string}>} لا يرمي — يعيد الخطأ كنص.
 */
export function testKontorLogin(cfg, opts = {}) {
  const { itemId, tenantId = 1 } = opts;
  const TEST_TIMEOUT_MS = parseInt(process.env.KONTOR_LOGIN_TIMEOUT_MS || '120000', 10);

  return new Promise((resolve) => {
    let baseEnv;
    try {
      baseEnv = buildEnv(cfg, { itemId, tenantId });
    } catch (err) {
      return resolve({ ok: false, error: err.message });
    }

    const child = spawn(process.execPath, [LOGIN_TEST_ENTRY], {
      cwd: SCRAPER_DIR,
      env: { ...process.env, ...baseEnv },
      windowsHide: true,
    });

    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve({ ok: false, error: 'انتهت مهلة اختبار الدخول' });
    }, TEST_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: 'تعذّر تشغيل الاختبار: ' + err.message });
    });

    child.on('close', () => {
      clearTimeout(timer);
      if (/RESULT_JSON=\{"ok":true/.test(out)) return resolve({ ok: true });
      const errLine = out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('[error]'));
      resolve({ ok: false, error: (errLine || 'فشل الدخول').replace(/^\[error\]\s*/, '').slice(0, 200) });
    });
  });
}
