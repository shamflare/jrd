import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const dbPath = path.join(DATA_DIR, 'jrd.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ════════════════════════════════════════════════════════════════════════════
// SCHEMA — الإنشاء الأوّلي (يعمل لقاعدة فارغة وقاعدة قائمة معاً)
// كل CREATE هنا فيه `tenant_id` منذ البداية. إذا كان الجدول موجوداً مسبقاً
// بدون `tenant_id` (= قاعدة Railway القديمة)، فإنّ كتلة Migrations أدناه
// تضيف العمود لاحقاً عبر ALTER TABLE.
// ════════════════════════════════════════════════════════════════════════════
db.exec(`
  -- ─── Multi-tenant: جداول جديدة ──────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS tenants (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    slug       TEXT UNIQUE NOT NULL,
    is_active  INTEGER NOT NULL DEFAULT 1,
    notes      TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id     INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
    email         TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'owner' CHECK(role IN ('admin','owner')),
    is_active     INTEGER NOT NULL DEFAULT 1,
    last_login_at TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    UNIQUE(email)
  );

  -- ملاحظة: نخزّن hash للـ token (SHA-256) لا الـ token الخام،
  -- بحيث لا يستطيع أحد سرقة الجلسات من DB.
  CREATE TABLE IF NOT EXISTS auth_sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    user_agent  TEXT DEFAULT '',
    ip          TEXT DEFAULT '',
    expires_at  TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  -- ─── الجداول الموجودة — بعمود tenant_id من البداية ─────────────────────
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'manual',
    provider_type TEXT,
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS current_values (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL UNIQUE REFERENCES items(id) ON DELETE CASCADE,
    try_amount REAL DEFAULT 0,
    usd_amount REAL DEFAULT 0,
    notes TEXT DEFAULT '',
    provider_balance REAL,
    provider_debt REAL
  );

  CREATE TABLE IF NOT EXISTS api_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL UNIQUE REFERENCES items(id) ON DELETE CASCADE,
    provider_type TEXT NOT NULL,
    base_url TEXT DEFAULT '',
    api_token TEXT DEFAULT '',
    kod TEXT DEFAULT '',
    sifre TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS inventories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    exchange_rate REAL NOT NULL,
    total_try REAL NOT NULL DEFAULT 0,
    total_usd REAL NOT NULL DEFAULT 0,
    total_converted_usd REAL NOT NULL DEFAULT 0,
    previous_total_usd REAL DEFAULT 0,
    profit REAL NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS inventory_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
    inventory_id INTEGER NOT NULL REFERENCES inventories(id) ON DELETE CASCADE,
    item_id INTEGER,
    item_name TEXT NOT NULL,
    try_amount REAL DEFAULT 0,
    usd_amount REAL DEFAULT 0,
    notes TEXT DEFAULT ''
  );

  -- item_change_log: سجل تغييرات البنود اليدوية (₺/$) — القيمة السابقة/الجديدة/الفرق.
  -- لا يُسجَّل هنا أي تغيير تلقائي (مزوّدو API / البنك / واتساب) — فقط التعديل اليدوي.
  CREATE TABLE IF NOT EXISTS item_change_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
    item_id INTEGER,
    item_name TEXT NOT NULL,
    field TEXT NOT NULL,                 -- 'try_amount' | 'usd_amount'
    old_value REAL NOT NULL DEFAULT 0,
    new_value REAL NOT NULL DEFAULT 0,
    delta REAL NOT NULL DEFAULT 0,
    changed_by TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    notes TEXT DEFAULT '',
    uploaded_at TEXT DEFAULT (datetime('now'))
  );

  -- settings: PK مركّب (tenant_id, key) — كل مستأجر له إعداداته
  CREATE TABLE IF NOT EXISTS settings (
    tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (tenant_id, key)
  );

  CREATE TABLE IF NOT EXISTS bank_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
    item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
    direction TEXT NOT NULL CHECK(direction IN ('in', 'out')),
    amount REAL NOT NULL,
    sender_receiver TEXT DEFAULT '',
    description TEXT DEFAULT '',
    transaction_time TEXT DEFAULT '',
    raw_sms TEXT DEFAULT '',
    balance_after REAL DEFAULT 0,
    source TEXT DEFAULT 'sms',
    external_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
    group_id TEXT NOT NULL,
    group_name TEXT DEFAULT '',
    sender TEXT DEFAULT '',
    sender_name TEXT DEFAULT '',
    message_id TEXT UNIQUE,
    text TEXT NOT NULL,
    is_group INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS whatsapp_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
    item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES whatsapp_messages(id) ON DELETE SET NULL,
    source TEXT NOT NULL CHECK(source IN ('us','them')),
    direction TEXT NOT NULL CHECK(direction IN ('lana','lakum')),
    currency TEXT NOT NULL CHECK(currency IN ('TRY','USD')),
    amount REAL NOT NULL,
    delta REAL NOT NULL,
    balance_after REAL DEFAULT 0,
    raw_text TEXT DEFAULT '',
    sender_name TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS monthly_inventories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    exchange_rate REAL NOT NULL,
    total_try REAL NOT NULL DEFAULT 0,
    total_usd REAL NOT NULL DEFAULT 0,
    total_converted_usd REAL NOT NULL DEFAULT 0,
    previous_monthly_id INTEGER REFERENCES monthly_inventories(id) ON DELETE SET NULL,
    previous_total_usd REAL DEFAULT 0,
    period_from TEXT DEFAULT '',
    period_to TEXT DEFAULT '',
    period_profit REAL NOT NULL DEFAULT 0,
    daily_count INTEGER NOT NULL DEFAULT 0,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS monthly_inventory_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
    monthly_inventory_id INTEGER NOT NULL REFERENCES monthly_inventories(id) ON DELETE CASCADE,
    item_id INTEGER,
    item_name TEXT NOT NULL,
    try_amount REAL DEFAULT 0,
    usd_amount REAL DEFAULT 0,
    notes TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS bank_sms_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
    created_at TEXT DEFAULT (datetime('now')),
    ip TEXT DEFAULT '',
    secret_ok INTEGER DEFAULT 1,
    parse_status TEXT DEFAULT '',
    error_message TEXT DEFAULT '',
    sender TEXT DEFAULT '',
    raw_body TEXT DEFAULT '',
    item_id INTEGER,
    direction TEXT DEFAULT '',
    amount REAL,
    transaction_id INTEGER
  );

  -- price_packages: لقطة كتالوق الباقات لكل مصدر أسعار (قسم "أسعار الباقات").
  -- تُستبدل صفوف المصدر+التبويب بالكامل عند كل تحديث.
  CREATE TABLE IF NOT EXISTS price_packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
    source_item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    source_name TEXT DEFAULT '',
    provider_type TEXT NOT NULL,
    tab TEXT NOT NULL DEFAULT 'games',
    external_ref TEXT DEFAULT '',
    name TEXT NOT NULL,
    category TEXT DEFAULT '',
    denomination TEXT DEFAULT '',
    match_key TEXT DEFAULT '',
    price REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'TRY',
    is_available INTEGER DEFAULT 1,
    fetched_at TEXT DEFAULT (datetime('now'))
  );

  -- price_links: مطابقة يدوية — تربط صفّ المقارنة (match_key) بباقة مصدر معيّن.
  -- تُستخدم حين تختلف أسماء الباقات بين المصادر (مثلاً znet مقابل zdk).
  CREATE TABLE IF NOT EXISTS price_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
    tab TEXT NOT NULL DEFAULT 'games',
    match_key TEXT NOT NULL,
    source_item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    external_ref TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(tenant_id, tab, match_key, source_item_id)
  );

  -- kontor_runs: تشغيلة مقارنة أرقام واحدة (قسم "مقارنة الأرقام").
  -- الروبوت بطيء (دقائق)، لذا نحفظ النتيجة كاملة لتُراجَع لاحقاً بلا إعادة تشغيل.
  -- result_json يحوي الصفوف المصنّفة؛ summary_json يحوي الأعداد والمبالغ فقط
  -- ليُقرأ في قائمة السجلّ دون تحميل النتيجة الضخمة.
  CREATE TABLE IF NOT EXISTS kontor_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id     INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
    item_id       INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    provider_name TEXT NOT NULL DEFAULT '',
    apisi_key     TEXT NOT NULL DEFAULT '',
    start_date    TEXT NOT NULL,
    end_date      TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'running'
                  CHECK(status IN ('running','done','error')),
    stage         TEXT DEFAULT '',
    ours_count    INTEGER,
    theirs_count  INTEGER,
    summary_json  TEXT DEFAULT '',
    result_json   TEXT DEFAULT '',
    error         TEXT DEFAULT '',
    created_at    TEXT DEFAULT (datetime('now')),
    finished_at   TEXT
  );
`);

// ════════════════════════════════════════════════════════════════════════════
// Helpers للـ migrations
// ════════════════════════════════════════════════════════════════════════════
function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function colInfo(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all();
}
function hasColumn(table, col) {
  return colInfo(table).some(c => c.name === col);
}
function columnType(table, col) {
  const c = colInfo(table).find(x => x.name === col);
  return c ? String(c.type || '').toUpperCase() : null;
}
function addColumn(table, col, def) {
  if (tableExists(table) && !hasColumn(table, col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 1) ضمان وجود المستأجر الافتراضي (id=1) — قبل أي backfill حتى تعمل FKs
// ════════════════════════════════════════════════════════════════════════════
const defaultTenant = db.prepare('SELECT id FROM tenants WHERE id = 1').get();
if (!defaultTenant) {
  db.prepare(`
    INSERT INTO tenants (id, name, slug, is_active, notes)
    VALUES (1, 'Default', 'default', 1, 'المستأجر الافتراضي (البيانات السابقة قبل multi-tenant)')
  `).run();
}

// ════════════════════════════════════════════════════════════════════════════
// 2) Migrations على قواعد ما قبل multi-tenant
// ════════════════════════════════════════════════════════════════════════════

// 2.1) إضافة tenant_id لكل جدول إن لم يوجد + backfill = 1
const TABLES_NEEDING_TENANT = [
  'items', 'current_values', 'api_configs',
  'inventories', 'inventory_items',
  'photos',
  'bank_transactions', 'bank_sms_log',
  'whatsapp_transactions',
  'monthly_inventories', 'monthly_inventory_items',
];

// ملاحظة SQLite: ALTER TABLE ADD COLUMN لا يقبل REFERENCES + non-NULL DEFAULT معاً
// (لأنّ المحرّك لا يستطيع التحقّق من FK على الصفوف الموجودة لحظة الإضافة).
// لذا في الجداول القديمة نضيف العمود بدون REFERENCES. الـ FK يبقى مُعرَّفاً في
// CREATE TABLE للقواعد الجديدة، وفي قواعد Railway القديمة نعتمد على
// middleware الـ tenant scope (المرحلة 6) للحماية.
for (const tbl of TABLES_NEEDING_TENANT) {
  if (!tableExists(tbl)) continue;
  if (!hasColumn(tbl, 'tenant_id')) {
    db.exec(`ALTER TABLE ${tbl} ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1`);
  } else {
    db.prepare(`UPDATE ${tbl} SET tenant_id = 1 WHERE tenant_id IS NULL`).run();
  }
}

// 2.2) Migration: api_configs.whatsapp_group_name (موجود من قبل)
addColumn('api_configs', 'whatsapp_group_name', `TEXT DEFAULT ''`);

// 2.2.0) Migration: api_configs.pin — رمز الـ PIN (الآلة الحاسبة) لروبوت bayi_alayatl
// يختلف لكل عميل. فارغ = يستخدم الافتراضي في السكرابر.
addColumn('api_configs', 'pin', `TEXT DEFAULT ''`);

// 2.2.0.1) Migration: api_configs.apisi_key — اسم الجهة كما يكتبه عمود Apisi
// في لوحة موقعنا (قسم "مقارنة الأرقام"). لا يمكن اشتقاقه من الرابط: اللوحة
// تكتب الاسم المُعرَّف داخلها (مثل "تويتي" أو "فيكس") لا اسم النطاق.
// فارغ = نخمّنه من الرابط، والمستخدم يصحّحه من نافذة الرموز.
addColumn('api_configs', 'apisi_key', `TEXT DEFAULT ''`);

// 2.2.1) Migration: current_values.provider_balance / provider_debt
// لعرض المتاح والدين لمزوّدي znet / murat_temiz في عمود الملاحظات (لا تدخل الحسابات)
addColumn('current_values', 'provider_balance', `REAL`);
addColumn('current_values', 'provider_debt', `REAL`);

// 2.3) Migration: bank_transactions.source + external_id (موجود من قبل)
addColumn('bank_transactions', 'source', `TEXT DEFAULT 'sms'`);
addColumn('bank_transactions', 'external_id', `TEXT`);
// dedup per-tenant: لو كان UNIQUE قديم على (external_id) فقط، نُسقطه ونُنشئ unique مركّب
db.exec(`DROP INDEX IF EXISTS idx_bank_tx_external_id`);
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_tx_tenant_external_id
    ON bank_transactions(tenant_id, external_id)
    WHERE external_id IS NOT NULL
`);

// 2.4) Migration: إعادة إنشاء settings لو كان PK = key فقط (قاعدة قديمة)
{
  const info = colInfo('settings');
  if (info.length > 0) {
    const pkCols = info.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
    const hasTenantId = info.some(c => c.name === 'tenant_id');
    const isOldShape = !hasTenantId || pkCols.length !== 2 || pkCols[0] !== 'tenant_id' || pkCols[1] !== 'key';

    if (isOldShape) {
      db.exec('PRAGMA foreign_keys = OFF');
      const migrate = db.transaction(() => {
        db.exec(`
          CREATE TABLE settings_new (
            tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            updated_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (tenant_id, key)
          )
        `);
        if (hasTenantId) {
          db.exec(`INSERT OR IGNORE INTO settings_new (tenant_id, key, value) SELECT COALESCE(tenant_id, 1), key, value FROM settings`);
        } else {
          db.exec(`INSERT OR IGNORE INTO settings_new (tenant_id, key, value) SELECT 1, key, value FROM settings`);
        }
        db.exec(`DROP TABLE settings`);
        db.exec(`ALTER TABLE settings_new RENAME TO settings`);
      });
      migrate();
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

// 2.4.1) Migration: أضف updated_at إن لم يكن موجوداً (قواعد ما قبل المرحلة 10)
// SQLite يرفض ALTER TABLE ADD COLUMN مع DEFAULT غير ثابت مثل datetime('now').
// لذا نضيف العمود بدون DEFAULT ثم نملأ القيم الحالية، ونعتمد على CREATE TABLE
// الجديد (أعلاه) أو على trigger للقيم المستقبلية. التطبيق نفسه يكتب updated_at
// صراحةً في rotate-webhook-secret عبر datetime('now').
if (tableExists('settings') && !hasColumn('settings', 'updated_at')) {
  db.exec(`ALTER TABLE settings ADD COLUMN updated_at TEXT`);
  db.exec(`UPDATE settings SET updated_at = datetime('now') WHERE updated_at IS NULL`);
}

// 2.5) Migration: whatsapp_messages.tenant_id من TEXT إلى INTEGER
{
  if (tableExists('whatsapp_messages')) {
    const tidType = columnType('whatsapp_messages', 'tenant_id');
    if (tidType !== 'INTEGER') {
      db.exec('PRAGMA foreign_keys = OFF');
      const migrate = db.transaction(() => {
        db.exec(`
          CREATE TABLE whatsapp_messages_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
            group_id TEXT NOT NULL,
            group_name TEXT DEFAULT '',
            sender TEXT DEFAULT '',
            sender_name TEXT DEFAULT '',
            message_id TEXT UNIQUE,
            text TEXT NOT NULL,
            is_group INTEGER DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now'))
          )
        `);
        // CAST: '1' → 1، أي غير صالح → 1
        db.exec(`
          INSERT INTO whatsapp_messages_new
            (id, tenant_id, group_id, group_name, sender, sender_name, message_id, text, is_group, created_at)
          SELECT
            id,
            COALESCE(CAST(NULLIF(tenant_id, '') AS INTEGER), 1),
            group_id,
            COALESCE(group_name, ''),
            COALESCE(sender, ''),
            COALESCE(sender_name, ''),
            message_id,
            text,
            COALESCE(is_group, 1),
            COALESCE(created_at, datetime('now'))
          FROM whatsapp_messages
        `);
        db.exec(`DROP TABLE whatsapp_messages`);
        db.exec(`ALTER TABLE whatsapp_messages_new RENAME TO whatsapp_messages`);
      });
      migrate();
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 3) Indexes
// ════════════════════════════════════════════════════════════════════════════
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_items_tenant                  ON items(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_current_values_tenant         ON current_values(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_api_configs_tenant            ON api_configs(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_inventories_tenant            ON inventories(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_inventory_items_tenant        ON inventory_items(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_photos_tenant                 ON photos(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_bank_transactions_tenant      ON bank_transactions(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_bank_sms_log_tenant           ON bank_sms_log(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_tenant      ON whatsapp_messages(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_whatsapp_transactions_tenant  ON whatsapp_transactions(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_monthly_inventories_tenant    ON monthly_inventories(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_monthly_inventory_items_tenant ON monthly_inventory_items(tenant_id);

  CREATE INDEX IF NOT EXISTS idx_item_change_log_tenant_created ON item_change_log(tenant_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_item_change_log_item          ON item_change_log(tenant_id, item_id);

  CREATE INDEX IF NOT EXISTS idx_bank_sms_log_created          ON bank_sms_log(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_inventories_tenant_created    ON inventories(tenant_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_bank_tx_tenant_created        ON bank_transactions(tenant_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_wa_msgs_tenant_created        ON whatsapp_messages(tenant_id, id DESC);

  CREATE INDEX IF NOT EXISTS idx_users_tenant                  ON users(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_auth_sessions_user            ON auth_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires         ON auth_sessions(expires_at);

  CREATE INDEX IF NOT EXISTS idx_price_packages_tenant_tab     ON price_packages(tenant_id, tab);
  CREATE INDEX IF NOT EXISTS idx_price_packages_source         ON price_packages(source_item_id);
  CREATE INDEX IF NOT EXISTS idx_price_packages_match          ON price_packages(tenant_id, tab, match_key);
  CREATE INDEX IF NOT EXISTS idx_price_links_tenant_tab        ON price_links(tenant_id, tab);

  CREATE INDEX IF NOT EXISTS idx_kontor_runs_tenant_created    ON kontor_runs(tenant_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_kontor_runs_item              ON kontor_runs(item_id);
`);

// ════════════════════════════════════════════════════════════════════════════
// 4) إعدادات افتراضية للمستأجر الافتراضي (id=1)
// PK الآن (tenant_id, key) — نحدّد tenant_id=1 صراحةً.
// ════════════════════════════════════════════════════════════════════════════
const seedSetting = (tenantId, key, val) => {
  const exists = db.prepare('SELECT 1 FROM settings WHERE tenant_id = ? AND key = ?').get(tenantId, key);
  if (!exists) {
    db.prepare('INSERT INTO settings (tenant_id, key, value) VALUES (?, ?, ?)').run(tenantId, key, val);
  }
};

seedSetting(1, 'exchange_rate', '44.75');
seedSetting(1, 'whatsapp_kw_us',     JSON.stringify(['لنا', 'النا', 'لينا', 'علينا']));
seedSetting(1, 'whatsapp_kw_them',   JSON.stringify(['لكم', 'لكن', 'عليكم', 'عليك']));
seedSetting(1, 'whatsapp_kw_try',    JSON.stringify(['تركي', 'تركى', 'تركية', 'ليرة', 'لير', 'تل', 'tl', 'try', 'lira', '₺']));
seedSetting(1, 'whatsapp_kw_usd',    JSON.stringify(['دولار', 'دولر', 'دلار', 'usd', 'usdt', 'dolar', 'dollar', 'doler', '$']));
seedSetting(1, 'whatsapp_kw_ignore', JSON.stringify(['مطابقة', 'مطابق', 'تطابق', 'match']));
seedSetting(1, 'whatsapp_admin_token', 'admin');

export default db;

// المستأجر الافتراضي — يُستخدم fallback في المرحلتَين 3 و 4
// (قبل تفعيل middleware الـ Auth الكامل في المرحلة 6).
export const DEFAULT_TENANT_ID = 1;
