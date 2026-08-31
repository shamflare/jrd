/**
 * اختبار اعتماديات جهة: دخول كامل (هاتف + سر + PIN) ثم خروج فوري.
 * يُستخدم من زر "تجربة الدخول" في نافذة رموز الآلة الحاسبة، ليعرف المستخدم
 * أن البيانات صحيحة قبل أن ينتظر مقارنة كاملة تفشل في نهايتها.
 *
 * المخرَج: RESULT_JSON={"ok":true,"url":"..."}
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { ensureLoggedIn } from './login.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOGIN_URL = process.env.BAYI_LOGIN_URL || '';
const TARGET_URL = new URL('/Kontor/kontor_takip.php', LOGIN_URL).toString();
const PHONE = process.env.BAYI_PHONE;
const PASSWORD = process.env.BAYI_PASSWORD;
const PIN = process.env.BAYI_PIN || '';
const NAV_TIMEOUT = parseInt(process.env.NAV_TIMEOUT_MS || '30000', 10);
const USER_DATA_DIR = process.env.BROWSER_DATA_DIR || path.join(__dirname, '..', 'browser-data', 'login-test');

async function main() {
  if (!PHONE || !PASSWORD || !LOGIN_URL) {
    console.error('[error] Missing BAYI_LOGIN_URL / BAYI_PHONE / BAYI_PASSWORD');
    process.exit(1);
  }
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: String(process.env.HEADLESS || 'true').toLowerCase() === 'true',
    viewport: { width: 1280, height: 800 },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(NAV_TIMEOUT);

  let exitCode = 0;
  try {
    await ensureLoggedIn(page, {
      phone: PHONE, password: PASSWORD, pin: PIN,
      targetUrl: TARGET_URL, navTimeout: NAV_TIMEOUT, log: console.log,
    });
    // وجود نموذج الفلترة يؤكّد أننا داخل صفحة الحركات فعلاً لا صفحة أخرى
    const hasFilter = await page.locator('#filitre_durum').count();
    console.log('RESULT_JSON=' + JSON.stringify({ ok: true, url: page.url(), hasFilter: hasFilter > 0 }));
  } catch (err) {
    console.error('[error]', (err && err.message) ? err.message.split('\n')[0] : String(err));
    exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
  process.exit(exitCode);
}

main();
