/**
 * سحب حركات الكونتور (Kontör İşlemleri / Transfer Takip) من لوحة بايي،
 * مفلترة بمدى تاريخ، مع المرور على كل الصفحات.
 *
 * يعمل على موقعنا وعلى مواقع الجهات معاً — نفس البرنامج، والاستخراج
 * يعتمد على أسماء الأعمدة لا على ترتيبها، فاختلاف الأعمدة بين اللوحتين
 * لا يكسره.
 *
 * المتغيّرات:
 *   BAYI_LOGIN_URL   رابط الموقع (مثال: https://bayi.codelinkpins.com/)
 *   BAYI_PHONE       رقم الجوال
 *   BAYI_PASSWORD    كلمة السر
 *   BAYI_PIN         رمز الآلة الحاسبة
 *   KONTOR_START     تاريخ البداية  dd.MM.yyyy
 *   KONTOR_END       تاريخ النهاية  dd.MM.yyyy
 *   BROWSER_DATA_DIR مجلد ملف المتصفح (عزل لكل جهة)
 *   HEADLESS         true/false
 *
 * المخرَج: سطر  RESULT_JSON={...}  على stdout.
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { ensureLoggedIn } from './login.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOGIN_URL = process.env.BAYI_LOGIN_URL || 'https://bayi.codelinkpins.com/';
const TARGET_URL = new URL('/Kontor/kontor_takip.php', LOGIN_URL).toString();
const PHONE = process.env.BAYI_PHONE;
const PASSWORD = process.env.BAYI_PASSWORD;
const PIN = process.env.BAYI_PIN || '111111';
const START = process.env.KONTOR_START || '';
const END = process.env.KONTOR_END || '';
const HEADLESS = String(process.env.HEADLESS || 'true').toLowerCase() === 'true';
const NAV_TIMEOUT = parseInt(process.env.NAV_TIMEOUT_MS || '30000', 10);
const MAX_PAGES = parseInt(process.env.KONTOR_MAX_PAGES || '400', 10);
const USER_DATA_DIR = process.env.BROWSER_DATA_DIR || path.join(__dirname, '..', 'browser-data', 'kontor');

const log = (...a) => console.log(...a);

// ─────────────────────────────────────────────────────────────────────────────
// استخراج صفحة واحدة — يُنفَّذ داخل المتصفح
// ─────────────────────────────────────────────────────────────────────────────
function extractPage() {
  // "1.234,56" بالتركي → 1234.56
  const num = (s) => {
    if (s == null) return null;
    const c = String(s).trim().replace(/[^\d.,-]/g, '').replace(/\./g, '').replace(',', '.');
    const n = parseFloat(c);
    return Number.isFinite(n) ? n : null;
  };
  const norm = (s) => String(s || '').replace(/ /g, ' ').trim().replace(/\s+/g, ' ');

  // جدول النتائج: نعرفه من رؤوسه (Telefon No + Alış) لا من حجمه — لوحة
  // الفلترة عندنا تحوي قوائم بمئات أسماء المحلات فتكون أكبر جدول في الصفحة.
  let table = null;
  for (const t of document.querySelectorAll('table')) {
    const head = norm(t.querySelector('tr') ? t.querySelector('tr').innerText : '');
    if (/telefon/i.test(head) && /(alış|alis)/i.test(head)) { table = t; break; }
  }
  if (!table) table = document.getElementById('knt_takip');
  if (!table) return { headers: [], rows: [], totals: {}, note: 'results table not found' };

  const allTr = [...table.querySelectorAll('tr')];
  const headerTr = allTr.find((tr) => tr.querySelectorAll('th').length) || allTr[0];

  // رأس "Kurum / Tutar" فيه colspan=2 (شعار المشغّل + اسم الباقة)، فعدد
  // الرؤوس أقل من عدد خلايا الصف. نحسب المدى الحقيقي لكل رأس بالـ colspan
  // وإلا انزاحت كل الأعمدة بواحد.
  const headers = [];
  const starts = [];
  const spans = [];
  let ci = 0;
  for (const c of headerTr.children) {
    const span = parseInt(c.getAttribute('colspan') || '1', 10) || 1;
    headers.push(norm(c.innerText));
    starts.push(ci);
    spans.push(span);
    ci += span;
  }

  // ترتيب الأعمدة يختلف بين اللوحتين → نطابق بالاسم لا بالفهرس
  const findCol = (re) => headers.findIndex((h) => re.test(h));
  const col = {
    telefon: findCol(/telefon/i),
    alis: findCol(/^(alış|alis)$/i),
    satis: findCol(/^(satış|satis)$/i),
    kazanc: findCol(/kazan/i),
    durum: findCol(/^(durum|drm)$/i),
    apisi: findCol(/apisi/i),
    yukleyen: findCol(/yükleyen|yukleyen/i),
    paket: findCol(/kurum|miktar|tutar/i),
    tarih: findCol(/işlem\s*t|islem\s*t|onay\s*t|sipariş|siparis/i),
  };

  // صفوف البيانات: لها id="acan_detay_<ref>". الجدول يحوي أيضاً صفوف تفاصيل
  // مخفية وصف الإجماليات — لو أخذنا كل <tr> لتضاعفت الأرقام.
  let dataRows = [...table.querySelectorAll('tr[id^="acan_detay_"]')];
  if (!dataRows.length) {
    // احتياط: صفوف عدد خلاياها = عدد رؤوس الأعمدة
    dataRows = allTr.filter((tr) => tr !== headerTr && tr.children.length === ci);
  }

  const rows = dataRows.map((tr) => {
    const tds = [...tr.children];
    // خلايا الرأس رقم j — قد تكون أكثر من واحدة عند colspan
    const cellsAt = (j) => (j >= 0 ? tds.slice(starts[j], starts[j] + spans[j]).filter(Boolean) : []);
    const text = (j) => norm(cellsAt(j).map((c) => c.innerText).join(' '));

    // الحالة: <img src="images/durum_3.png" title="İptal Edildi">
    let durumCode = null, durumText = '';
    for (const c of cellsAt(col.durum)) {
      const img = c.querySelector('img');
      if (!img) continue;
      const m = (img.getAttribute('src') || '').match(/durum[_-]?(\d+)/i);
      if (m) durumCode = parseInt(m[1], 10);
      durumText = img.getAttribute('title') || '';
      break;
    }

    // عمود التاريخ يحوي سطرين: İşlem T. و Onay T.
    const dates = text(col.tarih).split(/\n|(?<=\d{2}:\d{2}:\d{2})\s+(?=\d{2}\.)/)
      .map((s) => s.trim()).filter(Boolean);

    // شعار المشغّل في أول خلية: Kontor/logo/Avea_3gCep.jpg
    const logo = tr.querySelector('img[src*="logo/"]');
    const operator = logo ? (logo.getAttribute('src').split('/').pop() || '').replace(/\.\w+$/, '') : '';

    return {
      ref: (tr.id || '').replace('acan_detay_', ''),
      telefon: text(col.telefon).replace(/\D/g, ''),
      alis: num(text(col.alis)),
      satis: num(text(col.satis)),
      kazanc: num(text(col.kazanc)),
      durum: durumCode,
      durumText,
      apisi: col.apisi >= 0 ? text(col.apisi) : '',
      yukleyen: col.yukleyen >= 0 ? text(col.yukleyen) : '',
      paket: col.paket >= 0 ? text(col.paket) : '',
      dates,
      operator,
    };
  });

  // "Toplam Kayıt :160 ... Toplam Sayfa :4"
  const body = document.body.innerText.replace(/ /g, ' ');
  const grabInt = (label) => {
    const m = body.match(new RegExp(label + '\\s*:\\s*([\\d.]+)'));
    return m ? parseInt(m[1].replace(/\./g, ''), 10) : null;
  };
  const maxSayfaEl = document.getElementById('max_sayfa');

  return {
    headers,
    col,
    rows,
    totals: {
      kayit: grabInt('Toplam Kayıt'),
      sayfa: grabInt('Toplam Sayfa'),
      maxSayfa: maxSayfaEl ? parseInt(maxSayfaEl.value, 10) || null : null,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
async function applyDateFilter(page, start, end) {
  log('[filter] ' + (start || '—') + ' → ' + (end || '—') + ' (all statuses)');
  // لا بدّ من click() على زر الإرسال (لا form.submit) لأن PHP يفحص وجود
  // filitrele في الـ POST. والنقر يُطلق التنقّل فوراً ويُدمّر سياق evaluate،
  // لذا نؤجّله بـ setTimeout وننتظر التنقّل بالتوازي.
  const [, applied] = await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }),
    page.evaluate(({ s, e }) => {
      const f = document.filitre_form;
      if (!f) throw new Error('filitre_form not found on page');

      // قيمة "كل الحالات" تختلف بين اللوحتين: 'tumu' عند بعض الجهات و ''
      // عندنا. لا نخمّنها — نقرأها من زر "Tümünü Göster" نفسه.
      let allValue = '';
      for (const b of document.querySelectorAll('input[type=button],input[type=submit]')) {
        if (!/tümünü\s*göster|tumunu\s*goster/i.test(b.value || '')) continue;
        const m = (b.getAttribute('onclick') || '').match(/filitre_durum'\)\.value\s*=\s*'([^']*)'/);
        if (m) allValue = m[1];
        break;
      }
      const durum = document.getElementById('filitre_durum');
      if (durum) durum.value = allValue;

      // فلاتر إضافية قد تبقى من جلسة سابقة فتُخفي نتائج بلا سبب ظاهر
      for (const id of ['filitre_top_api_durum', 'zararina_satis_filtre']) {
        const el = document.getElementById(id);
        if (el) el.value = '';
      }

      if (f.filitre_sipbasi) f.filitre_sipbasi.value = s;
      if (f.filitre_sipsoni) f.filitre_sipsoni.value = e;
      setTimeout(() => f.filitrele.click(), 0);
      return { allValue };
    }, { s: start, e: end }),
  ]);
  log('[filter] durum=' + JSON.stringify(applied.allValue) + ' (read from "Tümünü Göster")');
  await page.waitForTimeout(700);
}

async function main() {
  if (!PHONE || !PASSWORD) {
    console.error('[error] Missing BAYI_PHONE / BAYI_PASSWORD');
    process.exit(1);
  }
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: HEADLESS,
    viewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(NAV_TIMEOUT);

  let exitCode = 0;
  try {
    await ensureLoggedIn(page, {
      phone: PHONE, password: PASSWORD, pin: PIN,
      targetUrl: TARGET_URL, navTimeout: NAV_TIMEOUT, log,
    });

    await applyDateFilter(page, START, END);

    const first = await page.evaluate(extractPage);
    log('[page 1] headers: ' + JSON.stringify(first.headers));
    log('[page 1] column map: ' + JSON.stringify(first.col));
    log('[page 1] totals: ' + JSON.stringify(first.totals) + '  rows=' + first.rows.length);

    const totalPages = first.totals.maxSayfa || first.totals.sayfa || 1;
    const rows = [...first.rows];

    for (let p = 2; p <= Math.min(totalPages, MAX_PAGES); p++) {
      await page.goto(TARGET_URL + '?sayfa=' + p, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      const data = await page.evaluate(extractPage);
      log('[page ' + p + '/' + totalPages + '] rows=' + data.rows.length);
      rows.push(...data.rows);
    }

    // رقم تحقّق: لو نقص صف واحد فالمقارنة كلها كاذبة — نُعلِن الفشل بدل الصمت
    const expected = first.totals.kayit;
    const complete = expected == null || rows.length === expected;
    if (!complete) {
      log('[warn] expected ' + expected + ' rows but scraped ' + rows.length);
    }

    const result = {
      site: new URL(LOGIN_URL).host,
      start: START, end: END,
      expected, scraped: rows.length, pages: totalPages, complete,
      rows,
    };
    console.log('\nRESULT_JSON=' + JSON.stringify(result));
    if (!complete) exitCode = 3;
  } catch (err) {
    console.error('[error]', (err && err.message) ? err.message.split('\n')[0] : String(err));
    try {
      await page.screenshot({ path: path.join(__dirname, '..', 'debug-kontor.png'), fullPage: true });
      console.error('[error] screenshot saved to debug-kontor.png');
    } catch {}
    exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
  process.exit(exitCode);
}

main();
