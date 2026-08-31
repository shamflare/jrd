/**
 * أداة تشخيص — تسجّل الدخول إلى لوحة البايي ثم تطبع بنية صفحة
 * Kontör İşlemleri: أزرار الحالة، حقول الفلترة، رؤوس الجدول، والترقيم،
 * وتحفظ HTML + لقطة شاشة في probe-out/.
 *
 * بها كُتبت محدّدات kontor.js. شغّلها حين تتغيّر لوحة جهة ويتوقّف السحب،
 * فتُظهر لك الفرق بدل التخمين — هكذا اكتُشف أن قيمة "كل الحالات" هي
 * 'tumu' عند جهة و '' عند أخرى.
 *
 *   BAYI_PHONE=... BAYI_PASSWORD=... BAYI_PIN=111111 \
 *   BAYI_LOGIN_URL=https://bayi.codelinkpins.com/ node src/kontor-probe.js
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { ensureLoggedIn } from './login.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.PROBE_OUT_DIR || path.join(__dirname, '..', 'probe-out');
const USER_DATA_DIR = process.env.BROWSER_DATA_DIR || path.join(__dirname, '..', 'browser-data', 'probe');

const LOGIN_URL = process.env.BAYI_LOGIN_URL || 'https://bayi.codelinkpins.com/';
const TARGET_URL = new URL('/Kontor/kontor_takip.php', LOGIN_URL).toString();
const PHONE = process.env.BAYI_PHONE;
const PASSWORD = process.env.BAYI_PASSWORD;
const PIN = process.env.BAYI_PIN || '111111';
const HEADLESS = String(process.env.HEADLESS || 'true').toLowerCase() === 'true';
const NAV_TIMEOUT = parseInt(process.env.NAV_TIMEOUT_MS || '30000', 10);

if (!PHONE || !PASSWORD) {
  console.error('[error] Missing BAYI_PHONE / BAYI_PASSWORD');
  process.exit(1);
}

async function describe(page) {
  return page.evaluate(() => {
    const txt = (el) => (el && (el.innerText || el.value) || '').trim().replace(/\s+/g, ' ').slice(0, 60);

    const clickables = [...document.querySelectorAll('a,button,input[type=button],input[type=submit],img,span[onclick],div[onclick]')]
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: txt(el),
        id: el.id || '',
        cls: String(el.className || '').slice(0, 60),
        href: el.getAttribute('href') || '',
        onclick: (el.getAttribute('onclick') || '').slice(0, 140),
        src: (el.getAttribute('src') || '').split('/').pop() || '',
        title: el.getAttribute('title') || '',
      }))
      .filter((e) => e.text || e.onclick || e.href || e.src || e.title);

    const fields = [...document.querySelectorAll('input,select,textarea')].map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.type || '',
      name: el.name || '',
      id: el.id || '',
      value: String(el.value || '').slice(0, 30),
      placeholder: el.getAttribute('placeholder') || '',
    }));

    // الجدول ذو أكبر عدد صفوف = جدول النتائج
    const tables = [...document.querySelectorAll('table')];
    let best = null;
    let bestRows = -1;
    for (const t of tables) {
      const n = t.querySelectorAll('tr').length;
      if (n > bestRows) { bestRows = n; best = t; }
    }
    const rows = best ? [...best.querySelectorAll('tr')] : [];
    const headers = rows[0] ? rows[0].innerText.trim().split(/\t|\n/).map((s) => s.trim()) : [];
    const firstDataRowHtml = rows[1] ? rows[1].outerHTML.slice(0, 3000) : '';

    const totals = (document.body.innerText.match(/Toplam[^\n]*/g) || []);

    return {
      url: location.href,
      tableId: (best && best.id) || '',
      tableCls: String((best && best.className) || ''),
      tableRowCount: bestRows,
      headers,
      firstDataRowHtml,
      totals,
      forms: [...document.querySelectorAll('form')].map((f) => ({ id: f.id, name: f.name, action: f.action, method: f.method })),
      fields,
      clickables,
    };
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: HEADLESS,
    viewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(NAV_TIMEOUT);

  try {
    await ensureLoggedIn(page, { phone: PHONE, password: PASSWORD, pin: PIN, targetUrl: TARGET_URL, navTimeout: NAV_TIMEOUT, log: console.log });

    // 1) الحالة الأولية
    let info = await describe(page);
    fs.writeFileSync(path.join(OUT_DIR, '1-initial.json'), JSON.stringify(info, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, '1-initial.html'), await page.content());
    await page.screenshot({ path: path.join(OUT_DIR, '1-initial.png'), fullPage: true });
    console.log('\n=== INITIAL ===');
    console.log('totals:', info.totals);
    console.log('headers:', info.headers);
    console.log('rowCount:', info.tableRowCount, 'tableId:', info.tableId, 'cls:', info.tableCls);
    console.log('fields:', JSON.stringify(info.fields));
    const interesting = info.clickables.filter((c) =>
      /göster|goster|filtre|kapat|sayfa|tümü|tumu|renk|durum/i.test(c.text + c.onclick + c.title + c.src));
    console.log('clickables(filtered):', JSON.stringify(interesting, null, 1));

    // 2) بعد فتح لوحة الفلترة
    for (const label of ['Filtre Göster', 'Filtre Goster', 'Tümünü Göster']) {
      const el = page.locator('text="' + label + '"').first();
      if (await el.count()) {
        console.log('\n[click] "' + label + '"');
        await el.click().catch(() => {});
        await page.waitForTimeout(1500);
        break;
      }
    }
    info = await describe(page);
    fs.writeFileSync(path.join(OUT_DIR, '2-filter-open.json'), JSON.stringify(info, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, '2-filter-open.html'), await page.content());
    await page.screenshot({ path: path.join(OUT_DIR, '2-filter-open.png'), fullPage: true });
    console.log('\n=== AFTER OPENING FILTER ===');
    console.log('fields:', JSON.stringify(info.fields, null, 1));
    console.log('\nfirst data row HTML:\n', info.firstDataRowHtml);

    console.log('\n[done] artifacts written to ' + OUT_DIR);
  } catch (err) {
    console.error('[error]', (err && err.message) || String(err));
    try { await page.screenshot({ path: path.join(OUT_DIR, 'error.png'), fullPage: true }); } catch {}
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
}

main();
