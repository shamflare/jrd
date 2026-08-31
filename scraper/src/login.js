/**
 * تسجيل الدخول إلى لوحة البايي (نفس البرنامج يعمل على موقعنا وعلى مواقع الجهات).
 *
 * الدخول من خطوتين تتكرّران حتى تختفيا:
 *   1. الهاتف + كلمة السر  →  #kullanici_adi / #password / #girisbutton
 *   2. لوحة أرقام عشوائية  →  input[name=number][value=X] ثم #_G
 *
 * لماذا حلقة لا خطوات متتابعة؟ عند أول دخول من ملف متصفح جديد تكون قيمة
 * #device_id هي "TANIMSIZ" لأن بصمة الجهاز تُحسب بـ JS بعد تحميل الصفحة.
 * الموقع يرفض الإرسال الأول بصمت ويعيد الصفحة مع fprint=... و device_id
 * مملوء — فالإرسال الثاني هو الذي ينجح. والحلقة تتعامل مع هذا وغيره
 * (إعادة عرض لوحة الـ PIN مثلاً) دون افتراضات عن عدد الخطوات.
 */

const MAX_STEPS = 8;
const MAX_LOGIN_SUBMITS = 3;
const MAX_PIN_SUBMITS = 3;

export async function ensureLoggedIn(page, opts) {
  const { phone, password, pin, targetUrl, navTimeout = 30000, log = () => {} } = opts;

  // انتظار التنقّل بالتوازي مع النقر: النقر يُطلق تنقّلاً فورياً، ولو فحصنا
  // الصفحة قبل استقراره لرأينا صفحة فارغة وظنَنّا الدخول نجح.
  const clickAndWait = async (selector) => {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: navTimeout }).catch(() => {}),
      page.click(selector, { timeout: navTimeout }),
    ]);
    await page.waitForTimeout(800);
  };

  log('[nav] opening ' + targetUrl);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: navTimeout });

  let loginSubmits = 0;
  let pinSubmits = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    await page.waitForLoadState('domcontentloaded', { timeout: navTimeout }).catch(() => {});
    await page.waitForTimeout(500);

    if (await page.locator('#parola').count()) {
      if (++pinSubmits > MAX_PIN_SUBMITS) throw new Error('PIN page keeps returning — wrong PIN?');
      log('[login] entering PIN on randomized keypad (try ' + pinSubmits + ')');
      await page.waitForSelector('input[name="number"]', { timeout: navTimeout });
      for (const digit of String(pin).split('')) {
        await page.click('input[name="number"][value="' + digit + '"]', { timeout: 8000 });
        await page.waitForTimeout(120);
      }
      await clickAndWait('#_G');
      continue;
    }

    if (await page.locator('#kullanici_adi').count()) {
      if (++loginSubmits > MAX_LOGIN_SUBMITS) throw new Error('Login page keeps returning — wrong phone/password?');
      const deviceId = await page.locator('#device_id').inputValue().catch(() => '');
      log('[login] submit (try ' + loginSubmits + ', device_id=' + (deviceId || 'empty') + ')');
      await page.fill('#kullanici_adi', phone);
      await page.fill('#password', password);
      await clickAndWait('#girisbutton');
      continue;
    }

    break; // لا نموذج دخول ولا لوحة PIN → داخل الموقع
  }

  const targetPath = new URL(targetUrl).pathname;
  if (!page.url().includes(targetPath)) {
    log('[nav] re-navigating to target after login');
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: navTimeout });
    await page.waitForTimeout(500);
  }

  if (await page.locator('#kullanici_adi').count()) throw new Error('Still on login page — wrong phone/password?');
  if (await page.locator('#parola').count()) throw new Error('Still on PIN page — wrong PIN?');
  log('[login] OK — ' + page.url());
}
