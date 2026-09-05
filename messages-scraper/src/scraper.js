import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { config } from './config.js';
import { log } from './logger.js';
import { sendToBackend } from './backendClient.js';
import {
  LIST_SHELL_CANDIDATES,
  LIST_ITEM_CANDIDATES,
  ITEM_NAME_CANDIDATES,
  MESSAGE_WRAPPER_CANDIDATES,
  MESSAGE_TEXT_CANDIDATES,
} from './selectors.js';

const MESSAGES_URL = 'https://messages.google.com/web/conversations';

/**
 * State machine بسيطة:
 *  idle             — لم نبدأ بعد
 *  starting         — يفتح المتصفّح
 *  pairing          — على صفحة QR، ننتظر المسح
 *  opening_chat     — مقترن، يفتح محادثة الهدف
 *  running          — يستطلع دورياً
 *  session_expired  — كانت running ثم وقعنا على صفحة QR (الجلسة انتهت)
 *  error            — خطأ غير قابل للاستئناف بدون إعادة تشغيل
 *  stopped          — متوقّف يدوياً
 */
export class Scraper {
  constructor() {
    this.state = 'idle';
    this.lastError = null;
    this.lastSeenAt = null;            // آخر مرّة استطلعنا فيها بنجاح
    this.lastMessageAt = null;         // آخر رسالة جديدة عُولجت
    this.messagesProcessedTotal = 0;
    this.wrappersCountLastTick = 0;    // تشخيصي: عدد wrappers الرسائل المدروسة في آخر tick
    this.paused = false;               // وضع إيقاف مؤقّت (الواجهة تستخدمه للسماح بتسجيل دخول Google)
    this.context = null;
    this.page = null;
    this.pollTimer = null;
    this.watchdogTimer = null;        // حارس ذاتي الاستشفاء (يعمل دائماً)
    this.restartAttempts = 0;         // لتأخير أسي/exponential backoff
    this.seen = new Set();             // hashes للرسائل المُعالَجة
    this._loadSeen();
    this._activeSelectors = {
      list_shell: null,
      list_item: null,
      message_wrapper: null,
    };
  }

  // ─── persistence (seen.json) ────────────────────────────────────────────
  _loadSeen() {
    try {
      if (fs.existsSync(config.seenFile)) {
        const raw = fs.readFileSync(config.seenFile, 'utf8');
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) this.seen = new Set(arr);
      }
    } catch (e) {
      log.warn('seen', 'load failed', e.message);
    }
  }
  _saveSeen() {
    try {
      fs.mkdirSync(path.dirname(config.seenFile), { recursive: true });
      // نحتفظ بآخر 2000 hash فقط حتى لا ينمو الملف بلا حدود
      const arr = Array.from(this.seen).slice(-2000);
      fs.writeFileSync(config.seenFile, JSON.stringify(arr));
    } catch (e) {
      log.warn('seen', 'save failed', e.message);
    }
  }

  // ─── public API ─────────────────────────────────────────────────────────
  status() {
    return {
      state: this.state,
      last_error: this.lastError,
      last_seen_at: this.lastSeenAt,
      last_message_at: this.lastMessageAt,
      messages_processed_total: this.messagesProcessedTotal,
      wrappers_count_last_tick: this.wrappersCountLastTick,
      seen_count: this.seen.size,
      paused: this.paused,
      active_selectors: this._activeSelectors,
      target_contact: config.targetContact,
      mode: config.mode,
      poll_interval_ms: config.pollIntervalMs,
      headless: config.headless,
      browser_data_dir: config.browserDataDir,
    };
  }

  /**
   * peek() — تشخيص: يقرأ آخر الرسائل دون إرسال للباكئند ودون تعديل seen.
   * مفيد للتحقّق ممّا يراه السكرابر فعلاً حين تظهر رسائل جديدة لكن لا تُجلَب.
   */
  async peek() {
    if (!this.page) return { ok: false, error: 'no_page', state: this.state };
    let messages = [];
    try {
      messages = await this._readLastMessages();
    } catch (e) {
      return { ok: false, error: e.message, state: this.state };
    }
    const sample = messages.slice(-10).map((m) => ({
      direction: m.direction,
      timestamp: m.timestamp,
      hash: m.hash,
      in_seen: this.seen.has(m.hash),
      text_preview: (m.text || '').slice(0, 200),
    }));
    return {
      ok: true,
      state: this.state,
      wrappers_count: this.wrappersCountLastTick,
      readable_count: messages.length,
      seen_count: this.seen.size,
      active_selectors: this._activeSelectors,
      sample,
    };
  }

  async start() {
    if (['starting', 'opening_chat', 'running', 'pairing'].includes(this.state)) {
      return { already: true, state: this.state };
    }
    this.lastError = null;
    this.state = 'starting';
    log.info('start', 'launching persistent context', { dir: config.browserDataDir });
    fs.mkdirSync(config.browserDataDir, { recursive: true });

    // إزالة ملفات قفل Chromium المتبقّية من جلسة سابقة (تتعطّل launchPersistentContext معها)
    for (const lockName of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      const p = path.join(config.browserDataDir, lockName);
      try { fs.rmSync(p, { force: true }); } catch (_) { /* ignore */ }
    }

    try {
      this.context = await chromium.launchPersistentContext(config.browserDataDir, {
        headless: config.headless,
        channel: process.env.GMSG_CHROME_CHANNEL || 'chrome', // استخدم Chrome الحقيقي (يقبله Google)
        viewport: { width: 1024, height: 768 },
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-software-rasterizer',
          // ملاحظة: لا نعطّل IsolateOrigins/site-per-process لأنّها تكسر
          // Service Worker و IndexedDB التي يحفظ فيها Google Messages
          // بيانات الإقران (وإلا يدخل دوامة welcome ↔ pair ↔ welcome).
          '--disable-features=TranslateUI',
          '--memory-pressure-off',
          '--lang=en-US,en',
        ],
      });

      // stealth: إخفاء علامات الأتمتة قبل أيّ تنقّل
      await this.context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5].map(() => ({ name: 'Chrome PDF Plugin' })),
        });
        // ضمن window.chrome (موجود في Chrome الحقيقي)
        if (!window.chrome) window.chrome = { runtime: {} };
        // permissions query بشكل طبيعي
        const orig = window.navigator.permissions?.query?.bind(window.navigator.permissions);
        if (orig) {
          window.navigator.permissions.query = (p) =>
            p.name === 'notifications'
              ? Promise.resolve({ state: Notification.permission, onchange: null })
              : orig(p);
        }
      });
      this.page = this.context.pages()[0] || (await this.context.newPage());
      this.page.setDefaultTimeout(config.navTimeoutMs);

      await this.page.goto(MESSAGES_URL, {
        waitUntil: 'domcontentloaded',
        timeout: config.navTimeoutMs,
      });

      // قد نهبط على /web/welcome — نحاول تجاوزها بالضغط على زر "Get started" / "Continue"
      this.state = 'pairing';
      await this._dismissWelcomeIfPresent();

      // ننتظر "قشرة" قائمة المحادثات (= مقترن) — مهلة طويلة (30 د) لإتاحة مسح QR من الواجهة
      const shell = await this._waitForAnySelector(
        LIST_SHELL_CANDIDATES,
        config.pairingTimeoutSec * 1000,
        'shell',
      );
      if (!shell) {
        // لا نرمي خطأ — نُبقي المتصفّح مفتوحاً ليرى المستخدم QR عبر /screenshot
        // ونُشغّل الـ watchdog ليلتقط لحظة اكتمال الإقران تلقائياً.
        this.state = 'session_expired';
        this.lastError = 'pairing_timeout';
        log.warn('start', 'pairing_timeout — browser kept open for manual QR via UI');
        this._startWatchdog();
        return { ok: false, state: this.state, hint: 'open /screenshot to scan QR' };
      }
      this._activeSelectors.list_shell = shell.selector;

      // ننتظر عناصر المحادثات
      const item = await this._waitForAnySelector(LIST_ITEM_CANDIDATES, 60_000, 'items');
      if (!item) {
        this.lastError = 'list_items_not_found';
        this.state = 'error';
        throw new Error('list_items_not_found');
      }
      this._activeSelectors.list_item = item.selector;

      // افتح المحادثة الهدف
      this.state = 'opening_chat';
      await this._openTargetConversation();

      // أوّل scan: نُعلِّم كل الرسائل الموجودة كـ "مرئية" بدون إرسالها (Bootstrap).
      // فقط الرسائل التي تظهر بعد هذه اللحظة تُرسَل.
      await this._bootstrap();

      this.state = 'running';
      this.restartAttempts = 0;
      this._scheduleNextPoll();
      this._startWatchdog();
      log.info('start', 'running');
      return { ok: true, state: this.state, selectors: this._activeSelectors };
    } catch (err) {
      this.lastError = err.message;
      if (this.state !== 'session_expired') this.state = 'error';
      log.error('start', 'failed', err.message);
      // لا نُغلق المتصفّح كي يتمكّن المستخدم من رؤية الحالة (مفيد محلياً).
      // بدلاً من ترك الحالة ميّتة تشغّل الـ watchdog ليحاول الاسترداد.
      this._startWatchdog();
      throw err;
    }
  }

  async stop() {
    log.info('stop', 'stopping');
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = null;
    try {
      if (this.context) await this.context.close();
    } catch (e) {
      log.warn('stop', 'context close error', e.message);
    }
    this.context = null;
    this.page = null;
    this.state = 'stopped';
    this.paused = false;
    return { ok: true };
  }

  /**
   * pause() — يوقف polling + watchdog دون إغلاق المتصفّح.
   * مفيد حين يريد المستخدم تسجيل دخول Google يدوياً من الواجهة
   * دون أن يقاطعه السكرابر بمحاولات فتح المحادثة.
   */
  pause() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = null;
    this.paused = true;
    this.lastError = null;
    log.info('pause', 'paused — browser kept open');
    return { ok: true, state: this.state, paused: true };
  }

  /**
   * resume() — يعيد تشغيل watchdog ويحاول الاسترداد فوراً.
   */
  async resume() {
    this.paused = false;
    log.info('resume', 'resumed');
    this._startWatchdog();
    // جرّب الاسترداد الفوري (في حال اكتمل تسجيل الدخول والمحادثة جاهزة)
    let recovered = false;
    try {
      recovered = await this._tryRecoverPairing();
    } catch (e) {
      log.warn('resume', 'recover failed', e.message);
    }
    return { ok: true, state: this.state, recovered };
  }

  // ─── watchdog ذاتي الاستشفاء ────────────────────────────────
  /**
   * يعمل دائماً في الخلفية ليحلّ ثلاث حالات:
   *  1) المستخدم أكمل الإقران من الواجهة والـ state مازال session_expired/pairing.
   *  2) المتصفّح/الصفحة ماتوا (Target crashed, OOM, جلسة انتهت ليلاً).
   *  3) Google عرض صفحة اعادة تحقّق دورية — لا نفعل شيئاً سوى الاستمرار بالاستطلاع.
   */
  _startWatchdog() {
    if (this.watchdogTimer) return; // كائن بالفعل
    const TICK = 8000;
    const fire = async () => {
      try {
        if (!this.paused) await this._watchdogTick();
      } catch (e) {
        log.warn('watchdog', 'tick error', e.message);
      } finally {
        // أعد الجدولة دائماً بشرط ألا تكون في stopped
        if (this.state !== 'stopped') {
          this.watchdogTimer = setTimeout(fire, TICK);
        } else {
          this.watchdogTimer = null;
        }
      }
    };
    this.watchdogTimer = setTimeout(fire, TICK);
    log.info('watchdog', 'started');
  }

  async _watchdogTick() {
    // 1) السياق أو الصفحة ماتا → إعادة تشغيل كاملة
    const dead = !this.context || !this.page || this.page.isClosed?.();
    if (dead && !['idle', 'starting', 'stopped'].includes(this.state)) {
      this.restartAttempts = Math.min(this.restartAttempts + 1, 6);
      const delaySec = Math.min(60, 5 * 2 ** (this.restartAttempts - 1)); // 5,10,20,40,60,60s
      log.warn('watchdog', `page/context dead — scheduling restart in ${delaySec}s (attempt ${this.restartAttempts})`);
      this.state = 'error';
      this.lastError = 'page_or_context_dead';
      setTimeout(() => {
        // جرّب إعادة التشغيل بنفس مجلد البروفايل (الجلسة محفوظة)
        this.context = null; this.page = null;
        this.state = 'idle';
        this.start().catch((e) => log.warn('watchdog', 'restart failed', e.message));
      }, delaySec * 1000);
      return;
    }
    if (dead) return;

    // 2) لو كنّا في session_expired أو pairing أو error… تحقّق إن كان الإقران اكتمل
    if (['session_expired', 'pairing', 'error'].includes(this.state)) {
      const recovered = await this._tryRecoverPairing();
      if (recovered) {
        log.info('watchdog', 'pairing detected as completed — transitioning to running');
        this.restartAttempts = 0;
      }
    }
  }

  /**
   * يتحقّق إن كانت قائمة المحادثات (shell) ظاهرة. إن نعم— يفتح المحادثة
   * ويعيد الحالة إلى running دون إعادة تشغيل المتصفّح.
   * تُستخدم من الـ watchdog ومن endpoint /recheck.
   */
  async recheckPairing() {
    return await this._tryRecoverPairing();
  }

  async _tryRecoverPairing() {
    if (!this.page || this.page.isClosed?.()) return false;
    // إن كنّا في صفحة welcome/qr/auth — لا نحاول (المستخدم لم يكمل بعد)
    const url = this.page.url();
    if (/\/(welcome|authentication)|qr/i.test(url)) {
      // جرّب تجاوز welcome
      await this._dismissWelcomeIfPresent().catch(() => {});
    }
    // ابحث عن أي مرشّح لـ shell
    let shellSel = null;
    for (const sel of LIST_SHELL_CANDIDATES) {
      const c = await this.page.locator(sel).count().catch(() => 0);
      if (c > 0) { shellSel = sel; break; }
    }
    if (!shellSel) return false;

    log.info('recover', `shell selector found: ${shellSel} — entering opening_chat`);
    this._activeSelectors.list_shell = shellSel;
    this.state = 'opening_chat';
    this.lastError = null;
    try {
      // ابحث عن list_item
      const item = await this._waitForAnySelector(LIST_ITEM_CANDIDATES, 30_000, 'recover-items');
      if (!item) throw new Error('list_items_not_found_on_recover');
      this._activeSelectors.list_item = item.selector;
      await this._openTargetConversation();
      await this._bootstrap();
      this.state = 'running';
      this._scheduleNextPoll();
      log.info('recover', 'transitioned to running');
      return true;
    } catch (e) {
      log.warn('recover', 'failed to open chat after pairing', e.message);
      this.state = 'session_expired';
      this.lastError = `recover_failed:${e.message}`;
      return false;
    }
  }

  /** يلتقط لقطة شاشة لصفحة Chromium الحالية. يُستخدم لعرض QR في الواجهة. */
  async screenshot() {
    if (!this.page) {
      log.warn('screenshot', 'no page object available');
      return null;
    }
    try {
      // JPEG + clip + low quality لتجنّب OOM في renderer على Railway
      const buf = await this.page.screenshot({
        type: 'jpeg',
        quality: 60,
        timeout: 8000,
        animations: 'disabled',
        caret: 'hide',
        clip: { x: 0, y: 0, width: 1024, height: 768 },
      });
      log.info('screenshot', `captured ${buf.length} bytes (jpeg)`);
      return buf;
    } catch (e) {
      log.warn('screenshot', `error: ${e.message}`);
      // إن انهار Target → أعد التشغيل التلقائي (في الخلفية)
      if (/Target crashed|browser has been closed|context or browser/i.test(e.message)) {
        log.info('screenshot', 'target crashed — scheduling restart');
        setImmediate(() => {
          this.stop().catch(() => {}).then(() => {
            setTimeout(() => this.start().catch(() => {}), 2000);
          });
        });
      }
      return null;
    }
  }

  // ─── تفاعل عن بُعد (نقر/كتابة/تنقّل) لإتمام الإقران من الواجهة ─────────────
  async remoteClick(x, y) {
    if (!this.page) throw new Error('no_page');
    await this.page.mouse.click(x, y, { delay: 50 });
    return { ok: true, x, y };
  }

  async remoteType(text) {
    if (!this.page) throw new Error('no_page');
    await this.page.keyboard.type(text, { delay: 20 });
    return { ok: true, length: text.length };
  }

  async remoteKey(key) {
    if (!this.page) throw new Error('no_page');
    await this.page.keyboard.press(key);
    return { ok: true, key };
  }

  async remoteScroll(dy) {
    if (!this.page) throw new Error('no_page');
    await this.page.mouse.wheel(0, dy);
    return { ok: true, dy };
  }

  async remoteGoto(url) {
    if (!this.page) throw new Error('no_page');
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return { ok: true, url: this.page.url() };
  }

  async remoteUrl() {
    if (!this.page) return null;
    return this.page.url();
  }

  /** يحاول تجاوز صفحة /web/welcome بالضغط على أوّل زر "Get started"/"Continue". */
  async _dismissWelcomeIfPresent() {
    try {
      const url = this.page.url();
      if (!/\/welcome/.test(url)) return;
      log.info('welcome', `on welcome page: ${url} — attempting to advance`);
      const candidates = [
        'button:has-text("Get started")',
        'button:has-text("Continue")',
        'button:has-text("Next")',
        'button:has-text("ابدأ")',
        'button:has-text("متابعة")',
        'button[type="submit"]',
        'mw-welcome button',
        'a[href*="/conversations"]',
      ];
      for (const sel of candidates) {
        const loc = this.page.locator(sel).first();
        if ((await loc.count().catch(() => 0)) > 0) {
          try {
            await loc.click({ timeout: 3000 });
            log.info('welcome', `clicked: ${sel}`);
            await this.page.waitForTimeout(2000);
            return;
          } catch (_) { /* try next */ }
        }
      }
      log.info('welcome', 'no welcome button found — proceeding');
    } catch (e) {
      log.warn('welcome', e.message);
    }
  }

  // ─── internals ──────────────────────────────────────────────────────────
  async _waitForAnySelector(selectors, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const sel of selectors) {
        const count = await this.page.locator(sel).count().catch(() => 0);
        if (count > 0) {
          log.info(label, `selector="${sel}" count=${count}`);
          return { selector: sel, count };
        }
      }
      await this.page.waitForTimeout(800);
    }
    return null;
  }

  async _getItemName(itemLocator) {
    for (const sel of ITEM_NAME_CANDIDATES) {
      const loc = itemLocator.locator(sel).first();
      if ((await loc.count()) > 0) {
        const t = (await loc.innerText().catch(() => '')).trim();
        if (t) return t;
      }
    }
    const full = (await itemLocator.innerText().catch(() => '')).trim();
    return full.split('\n')[0] || '';
  }

  async _openTargetConversation() {
    // إن وُجد cdk-overlay-backdrop (تلميح/نافذة CDK) فاضغط Escape ثم انقر عليه ليختفي.
    await this._dismissCdkOverlay();
    const items = this.page.locator(this._activeSelectors.list_item);
    const total = await items.count();
    log.info('list', `conversations count=${total}`);
    for (let i = 0; i < total; i++) {
      const item = items.nth(i);
      const name = await this._getItemName(item);
      if (name && name.toLowerCase().includes(config.targetContact.toLowerCase())) {
        log.info('list', `target match index=${i} name="${name}"`);
        await this._dismissCdkOverlay(); // مرّة أخرى مباشرة قبل النقر
        // نقر بالقوّة (يتجاوز أي طبقة شفّافة مثل cdk-overlay-backdrop)
        await item.click({ force: true, timeout: 15000 });
        await this.page.waitForTimeout(1500);
        const wrapperHit = await this._waitForAnySelector(
          MESSAGE_WRAPPER_CANDIDATES,
          config.navTimeoutMs,
          'msg-wait',
        );
        if (!wrapperHit) throw new Error('no_message_wrapper_after_open');
        this._activeSelectors.message_wrapper = wrapperHit.selector;
        return;
      }
    }
    throw new Error(`target_not_found:${config.targetContact}`);
  }

  /** يُغلق طبقات CDK overlay الشفّافة (تلميحات Material) التي تحجب النقر. */
  async _dismissCdkOverlay() {
    try {
      const backdrop = this.page.locator('.cdk-overlay-backdrop').first();
      if (await backdrop.count()) {
        await this.page.keyboard.press('Escape').catch(() => {});
        await this.page.waitForTimeout(150);
        // إن بقيت الطبقة، انقر عليها لإغلاقها
        if (await backdrop.count()) {
          await backdrop.click({ timeout: 2000 }).catch(() => {});
          await this.page.waitForTimeout(150);
        }
      }
    } catch (_) { /* ignore */ }
  }

  /**
   * يقرأ آخر N رسالة ويُعَلِّمها seen دون إرسال (نقطة الصفر للـ polling).
   * يعمل فقط عند البدء التماماً الجديد (seen فارغ) — لمنع بلع الرسائل
   * التي تصل أثناء حلقات الاسترداد (error → recover → bootstrap كان يأكلها).
   */
  async _bootstrap() {
    if (this.seen.size > 0) {
      log.info('bootstrap', `skipped — seen already has ${this.seen.size} entries (recovery, not fresh start)`);
      return;
    }
    const messages = await this._readLastMessages();
    for (const m of messages) {
      this.seen.add(m.hash);
    }
    this._saveSeen();
    log.info('bootstrap', `marked ${messages.length} existing messages as seen (fresh start)`);
  }

  /**
   * replay() — يجبر إعادة معالجة كلّ الرسائل الواردة المرئية حالياً،
   * متجاوزاً seen. مفيد لاستعادة رسالة بُلِعت أثناء حلقة استرداد سابقة
   * (bootstrap قديم وضعها في seen دون إرسالها للباكئند).
   * يُرسلها للباكئند ثم يضيفها إلى seen.
   */
  async replay() {
    if (!this.page) return { ok: false, error: 'no_page', state: this.state };
    let messages = [];
    try {
      messages = await this._readLastMessages();
    } catch (e) {
      return { ok: false, error: e.message, state: this.state };
    }
    const results = [];
    for (const m of messages) {
      if (m.direction === 'outgoing') {
        this.seen.add(m.hash);
        continue;
      }
      try {
        const resp = await sendToBackend({
          text: m.text,
          occurredAt: m.timestamp,
          externalId: m.hash,
          contactName: config.targetContact,
        });
        this.seen.add(m.hash);
        this.lastMessageAt = new Date().toISOString();
        this.messagesProcessedTotal++;
        results.push({ hash: m.hash.slice(0, 12), applied: !!resp.applied, text_preview: (m.text || '').slice(0, 80) });
        log.info('replay', 'sent', { applied: resp.applied, hash: m.hash.slice(0, 12) });
      } catch (e) {
        results.push({ hash: m.hash.slice(0, 12), error: e.message, text_preview: (m.text || '').slice(0, 80) });
        log.warn('replay', 'failed', e.message);
      }
    }
    this._saveSeen();
    return { ok: true, state: this.state, scanned: messages.length, results };
  }

  _scheduleNextPoll() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => this._tick().catch((e) => {
      log.error('poll', 'tick error', e.message);
      this.lastError = e.message;
      this._scheduleNextPoll();
    }), config.pollIntervalMs);
  }

  async _tick() {
    if (this.paused) return;
    if (this.state !== 'running') return;
    // فحص انتهاء الجلسة: إن اختفت قائمة المحادثات أو ظهرت صفحة QR.
    const shellExists = await this.page.locator(this._activeSelectors.list_shell).count().catch(() => 0);
    if (!shellExists) {
      // ربما تنقّلنا أو الجلسة انتهت
      const url = this.page.url();
      if (/authentication|qr/i.test(url)) {
        log.warn('session', 'session_expired (qr page) — watchdog will recover automatically');
        this.state = 'session_expired';
        this._startWatchdog(); // في حال ما كان يعمل
        return;
      }
      // نحاول إعادة فتح المحادثة
      try {
        await this._openTargetConversation();
      } catch (e) {
        log.warn('tick', 're-open failed', e.message);
        this._scheduleNextPoll();
        return;
      }
    }

    const messages = await this._readLastMessages();
    this.lastSeenAt = new Date().toISOString();
    let newCount = 0;
    for (const m of messages) {
      if (this.seen.has(m.hash)) continue;
      // فقط الرسائل الواردة (incoming) من البنك تهمّنا.
      if (m.direction === 'outgoing') {
        this.seen.add(m.hash);
        continue;
      }
      try {
        const resp = await sendToBackend({
          text: m.text,
          occurredAt: m.timestamp,
          externalId: m.hash,
          contactName: config.targetContact,
        });
        log.info('ingest', 'sent', { applied: resp.applied, hash: m.hash.slice(0, 12) });
        this.seen.add(m.hash);
        this.lastMessageAt = new Date().toISOString();
        this.messagesProcessedTotal++;
        newCount++;
      } catch (e) {
        log.warn('ingest', 'failed — will retry next tick', e.message);
        // لا نضيفها لـ seen كي نُعيد المحاولة في الدورة التالية.
      }
    }
    if (newCount > 0) this._saveSeen();
    this._scheduleNextPoll();
  }

  /** قراءة آخر scanLastN رسالة من المحادثة المفتوحة. */
  async _readLastMessages() {
    const wrapperSel = this._activeSelectors.message_wrapper;
    if (!wrapperSel) return [];
    const textSels = MESSAGE_TEXT_CANDIDATES;
    const scanLastN = config.scanLastN;

    const raws = await this.page.evaluate(
      ({ wrapperSel, textSels, scanLastN }) => {
        const wrappers = Array.from(document.querySelectorAll(wrapperSel));
        const slice = wrappers.slice(-scanLastN);
        return slice.map((el) => {
          const html = el.outerHTML || '';
          let direction = null;
          if (/\bincoming\b/.test(html)) direction = 'incoming';
          else if (/\boutgoing\b/.test(html)) direction = 'outgoing';

          let text = '';
          for (const sel of textSels) {
            const t = el.querySelector(sel);
            if (t) {
              text = (t.innerText || '').trim();
              if (text) break;
            }
          }
          if (!text) text = (el.innerText || '').trim();

          const tsEl =
            el.querySelector('mws-relative-timestamp') ||
            el.querySelector('mw-relative-timestamp') ||
            el.querySelector('[data-e2e-message-timestamp]') ||
            el.querySelector('time');
          const timestamp = tsEl
            ? tsEl.getAttribute('datetime') || tsEl.getAttribute('title') || (tsEl.innerText || '').trim()
            : null;

          return { direction, text, timestamp };
        });
      },
      { wrapperSel, textSels, scanLastN },
    );

    // hash مستقر: نعتمد على (text + timestamp). text لكويت ترك يحوي Tutar و Islem Zamani
    // وهي فريدة عملياً لكل رسالة.
    this.wrappersCountLastTick = raws.length;
    return raws
      .filter((m) => m.text && m.text.length > 5)
      .map((m) => {
        const h = crypto
          .createHash('sha256')
          .update(`${m.timestamp || ''}|${m.text}`)
          .digest('hex')
          .slice(0, 24);
        return { ...m, hash: h };
      });
  }
}
