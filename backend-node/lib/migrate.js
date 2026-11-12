
"use strict";

const bcrypt = require("bcryptjs");
const pool = require("../config/db");
const DEFAULTS = require("./defaults");
const { PERMISSIONS } = require("./permissions");
const { als, tableName, newQrToken } = require("./tenantSql");

const q = async (sql, p) => (await pool.query(sql, p))[0];

async function hasColumn(table, col) {
  const r = await q(
    "SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1",
    [tableName(table), col]
  );
  return r.length > 0;
}

async function addColumn(table, col, def) {
  if (!(await hasColumn(table, col))) {
    await q(`ALTER TABLE \`${table}\` ADD COLUMN \`${col}\` ${def}`);
  }
}

const DDL = [
  // UPLOADED FILES (images / PDFs) - kept in the database so they survive redeploys
  `CREATE TABLE IF NOT EXISTS bb_files (
    name VARCHAR(160) NOT NULL,
    mime VARCHAR(80) NOT NULL,
    data LONGBLOB NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // CATEGORIES TABLE
  `CREATE TABLE IF NOT EXISTS categories (
    id INT NOT NULL AUTO_INCREMENT,
    name VARCHAR(100) COLLATE utf8mb4_unicode_ci NOT NULL,
    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    display_order INT NOT NULL DEFAULT 0,
    icon VARCHAR(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    description VARCHAR(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    show_in_pos TINYINT NOT NULL DEFAULT 1,
    image_url VARCHAR(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    tax_rate_id INT DEFAULT NULL,
    is_archived TINYINT NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    UNIQUE KEY name (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // PRODUCTS TABLE
  `CREATE TABLE IF NOT EXISTS products (
    id INT NOT NULL AUTO_INCREMENT,
    category_id INT NOT NULL,
    name VARCHAR(150) COLLATE utf8mb4_unicode_ci NOT NULL,
    mrp DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    image_url VARCHAR(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    sku VARCHAR(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    cost_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    item_type VARCHAR(10) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'veg',
    description VARCHAR(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    show_in_pos TINYINT NOT NULL DEFAULT 1,
    is_featured TINYINT NOT NULL DEFAULT 0,
    tax_rate_id INT DEFAULT NULL,
    track_stock TINYINT NOT NULL DEFAULT 0,
    stock_qty INT NOT NULL DEFAULT 0,
    low_stock_level INT NOT NULL DEFAULT 5,
    is_archived TINYINT NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    KEY category_id (category_id),
    FOREIGN KEY (category_id) REFERENCES categories (id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS bb_roles (
    name VARCHAR(50) PRIMARY KEY,
    permissions TEXT NOT NULL,
    is_system TINYINT NOT NULL DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS bb_users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(150) NOT NULL UNIQUE,
    phone VARCHAR(30) NULL,
    password_hash VARCHAR(100) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'cashier',
    is_active TINYINT NOT NULL DEFAULT 1,
    last_login DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS bb_settings (
    k VARCHAR(100) PRIMARY KEY,
    v TEXT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS bb_tax_rates (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(60) NOT NULL,
    rate DECIMAL(5,2) NOT NULL,
    description VARCHAR(200) NULL,
    is_active TINYINT NOT NULL DEFAULT 1
  )`,

  `CREATE TABLE IF NOT EXISTS bb_tables (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,
    capacity INT NOT NULL DEFAULT 4,
    status VARCHAR(20) NOT NULL DEFAULT 'available',
    status_since DATETIME NULL,
    reserved_for VARCHAR(100) NULL,
    reserved_phone VARCHAR(30) NULL,
    reserved_at DATETIME NULL,
    sort_order INT NOT NULL DEFAULT 0,
    is_active TINYINT NOT NULL DEFAULT 1
  )`,

  `CREATE TABLE IF NOT EXISTS bb_customers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(20) NULL UNIQUE,
    email VARCHAR(150) NULL,
    address VARCHAR(255) NULL,
    birthday DATE NULL,
    notes VARCHAR(500) NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'active',
    loyalty_points INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS bb_loyalty_tx (
    id INT AUTO_INCREMENT PRIMARY KEY,
    customer_id INT NOT NULL,
    order_id INT NULL,
    points INT NOT NULL,
    type VARCHAR(20) NOT NULL,
    note VARCHAR(200) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (customer_id)
  )`,

  `CREATE TABLE IF NOT EXISTS bb_sequences (
    name VARCHAR(50) PRIMARY KEY,
    value BIGINT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS bb_orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    bill_no VARCHAR(30) NOT NULL UNIQUE,
    order_type VARCHAR(20) NOT NULL DEFAULT 'dine_in',
    table_id INT NULL,
    table_name VARCHAR(50) NULL,
    customer_id INT NULL,
    customer_name VARCHAR(100) NOT NULL DEFAULT 'Walk-in',
    customer_phone VARCHAR(30) NULL,
    delivery_address VARCHAR(255) NULL,
    guests INT NOT NULL DEFAULT 1,
    notes VARCHAR(255) NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    payment_status VARCHAR(20) NOT NULL DEFAULT 'unpaid',
    subtotal DECIMAL(10,2) NOT NULL DEFAULT 0,
    discount_type VARCHAR(10) NULL,
    discount_value DECIMAL(10,2) NOT NULL DEFAULT 0,
    discount_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
    discount_by INT NULL,
    taxable_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
    tax_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
    round_off DECIMAL(10,2) NOT NULL DEFAULT 0,
    total DECIMAL(10,2) NOT NULL DEFAULT 0,
    tax_mode VARCHAR(12) NOT NULL DEFAULT 'exclusive',
    created_by INT NULL,
    idempotency_key VARCHAR(64) NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    paid_at DATETIME NULL,
    completed_at DATETIME NULL,
    cancel_reason VARCHAR(255) NULL,
    cancelled_by INT NULL,
    cancelled_at DATETIME NULL,
    INDEX idx_status (status, payment_status),
    INDEX idx_paid (paid_at),
    INDEX idx_created (created_at),
    INDEX idx_table (table_id)
  )`,

  `CREATE TABLE IF NOT EXISTS bb_order_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    order_id INT NOT NULL,
    product_id INT NULL,
    product_name VARCHAR(150) NOT NULL,
    category_name VARCHAR(100) NULL,
    unit_price DECIMAL(10,2) NOT NULL,
    qty INT NOT NULL,
    line_subtotal DECIMAL(10,2) NOT NULL,
    discount_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
    taxable DECIMAL(10,2) NOT NULL DEFAULT 0,
    tax_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
    tax_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
    line_total DECIMAL(10,2) NOT NULL,
    INDEX (order_id),
    INDEX (product_id)
  )`,

  `CREATE TABLE IF NOT EXISTS bb_payments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    order_id INT NOT NULL,
    method VARCHAR(20) NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    reference VARCHAR(100) NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'paid',
    created_by INT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (order_id)
  )`,

  `CREATE TABLE IF NOT EXISTS bb_expense_categories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(80) NOT NULL UNIQUE
  )`,

  `CREATE TABLE IF NOT EXISTS bb_expenses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    expense_date DATE NOT NULL,
    category_id INT NOT NULL,
    name VARCHAR(150) NOT NULL,
    supplier VARCHAR(150) NULL,
    amount DECIMAL(10,2) NOT NULL,
    payment_mode VARCHAR(30) NOT NULL,
    notes VARCHAR(500) NULL,
    attachment VARCHAR(255) NULL,
    added_by INT NULL,
    is_deleted TINYINT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (expense_date)
  )`,

  `CREATE TABLE IF NOT EXISTS bb_notifications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    type VARCHAR(20) NOT NULL,
    title VARCHAR(150) NOT NULL,
    message VARCHAR(500) NULL,
    priority VARCHAR(10) NOT NULL DEFAULT 'normal',
    link_type VARCHAR(20) NULL,
    link_id VARCHAR(30) NULL,
    is_read TINYINT NOT NULL DEFAULT 0,
    is_archived TINYINT NOT NULL DEFAULT 0,
    dedupe_key VARCHAR(80) NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (is_read, is_archived)
  )`,

  `CREATE TABLE IF NOT EXISTS bb_audit (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NULL,
    user_name VARCHAR(100) NULL,
    action VARCHAR(30) NOT NULL,
    module VARCHAR(40) NOT NULL,
    details VARCHAR(500) NULL,
    record_id VARCHAR(40) NULL,
    old_values TEXT NULL,
    new_values TEXT NULL,
    ip VARCHAR(60) NULL,
    user_agent VARCHAR(255) NULL,
    level VARCHAR(10) NOT NULL DEFAULT 'info',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (created_at),
    INDEX (module)
  )`,

  `CREATE TABLE IF NOT EXISTS bb_backups (
    id INT AUTO_INCREMENT PRIMARY KEY,
    filename VARCHAR(120) NOT NULL,
    size INT NOT NULL DEFAULT 0,
    created_by VARCHAR(100) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`
];

const ROLE_PERMS = {
  admin: PERMISSIONS.map((p) => p[0]),
  manager: PERMISSIONS.map((p) => p[0]).filter((p) => !["staff", "backup"].includes(p)),
  waiter: ["waiter"],
  cashier: ["pos", "orders", "tables", "menu", "customers", "customers.manage", "reports", "discount"]
};

async function provisionTenant(tid, opts = {}) {
  return als.run({ tid: Number(tid) }, async () => {
    // Create all required tables first
    for (const sql of DDL) {
      await q(sql);
    }
  
    await addColumn("bb_tables", "qr_token", "CHAR(36) NULL");
  
    const qrTables = await q(
      'SELECT id FROM bb_tables WHERE qr_token IS NULL OR qr_token = ""'
    );
  
    for (const t of qrTables) {
      await q("UPDATE bb_tables SET qr_token = ? WHERE id = ?", [
        newQrToken(),
        t.id
      ]);
    }
  
    // Existing categories: add missing columns without deleting data
    const cat = [
      ["icon", "VARCHAR(20) NULL"],
      ["description", "VARCHAR(255) NULL"],
      ["display_order", "INT NOT NULL DEFAULT 0"],
      ["show_in_pos", "TINYINT NOT NULL DEFAULT 1"],
      ["is_active", "TINYINT NOT NULL DEFAULT 1"],
      ["image_url", "VARCHAR(255) NULL"],
      ["tax_rate_id", "INT NULL"],
      ["is_archived", "TINYINT NOT NULL DEFAULT 0"]
    ];
  
    for (const [c, d] of cat) {
      await addColumn("categories", c, d);
    }
  
    const prod = [
      ["image_url", "VARCHAR(255) NULL"],
      ["is_active", "TINYINT NOT NULL DEFAULT 1"],
      ["sku", "VARCHAR(50) NULL"],
      ["cost_price", "DECIMAL(10,2) NOT NULL DEFAULT 0"],
      ["item_type", "VARCHAR(10) NOT NULL DEFAULT 'veg'"],
      ["description", "VARCHAR(255) NULL"],
      ["show_in_pos", "TINYINT NOT NULL DEFAULT 1"],
      ["is_featured", "TINYINT NOT NULL DEFAULT 0"],
      ["tax_rate_id", "INT NULL"],
      ["track_stock", "TINYINT NOT NULL DEFAULT 0"],
      ["stock_qty", "INT NOT NULL DEFAULT 0"],
      ["low_stock_level", "INT NOT NULL DEFAULT 5"],
      ["is_archived", "TINYINT NOT NULL DEFAULT 0"]
    ];
  
    for (const [c, d] of prod) {
      await addColumn("products", c, d);
    }
  
    const userColumns = [
      ["aadhaar_no", "VARCHAR(12) NULL"],
      ["aadhaar_image", "VARCHAR(255) NULL"],
      ["bank_name", "VARCHAR(100) NULL"],
      ["bank_account_no", "VARCHAR(20) NULL"],
      ["ifsc_code", "VARCHAR(15) NULL"],
      ["branch_name", "VARCHAR(100) NULL"],
      ["passbook_image", "VARCHAR(255) NULL"],
      ["joining_date", "DATE NULL"],
      ["photo_image", "VARCHAR(255) NULL"]
    ];
  
    for (const [c, d] of userColumns) {
      await addColumn("bb_users", c, d);
    }
  
    await q(`CREATE TABLE IF NOT EXISTS bb_online_orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      platform VARCHAR(20) NOT NULL,
      external_id VARCHAR(60) NOT NULL,
      customer_name VARCHAR(100) NOT NULL DEFAULT 'Customer',
      customer_phone VARCHAR(30) NULL,
      address VARCHAR(255) NULL,
      items MEDIUMTEXT NOT NULL,
      total DECIMAL(10,2) NOT NULL DEFAULT 0,
      payment_mode VARCHAR(10) NOT NULL DEFAULT 'prepaid',
      status VARCHAR(15) NOT NULL DEFAULT 'new',
      reject_reason VARCHAR(200) NULL,
      raw MEDIUMTEXT NULL,
      received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_online (platform, external_id),
      INDEX (status, platform)
    )`);
  
    await q(`CREATE TABLE IF NOT EXISTS bb_kots (
      id INT AUTO_INCREMENT PRIMARY KEY,
      kot_no VARCHAR(20) NOT NULL DEFAULT '',
      order_id INT NOT NULL,
      table_id INT NULL,
      table_name VARCHAR(50) NULL,
      waiter_id INT NULL,
      waiter_name VARCHAR(100) NULL,
      items TEXT NOT NULL,
      instructions VARCHAR(500) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX (waiter_id),
      INDEX (order_id)
    )`);
  
    await addColumn("bb_orders", "source", "VARCHAR(20) NOT NULL DEFAULT 'direct'");
  
    await q("UPDATE categories SET display_order = id WHERE display_order = 0");
  
    // Seed default roles
    for (const [name, perms] of Object.entries(ROLE_PERMS)) {
      await q(
        "INSERT IGNORE INTO bb_roles (name, permissions, is_system) VALUES (?,?,1)",
        [name, JSON.stringify(perms)]
      );
    }
  
    await q("UPDATE bb_roles SET permissions = ? WHERE name = 'admin'", [
      JSON.stringify(ROLE_PERMS.admin)
    ]);
  
    await q("UPDATE bb_roles SET permissions = ? WHERE name = 'waiter'", [
      JSON.stringify(ROLE_PERMS.waiter)
    ]);
  
    const [{ n: taxCount }] = await q("SELECT COUNT(*) n FROM bb_tax_rates");
  
    if (!taxCount) {
      await q(
        "INSERT INTO bb_tax_rates (name, rate, description) VALUES ?",
        [[
          ["GST 0%", 0, "Nil rated (no tax)"],
          ["GST 5%", 5, "For essential food items"],
          ["GST 12%", 12, "For processed food items"],
          ["GST 18%", 18, "For beverages & others"],
          ["GST 28%", 28, "For premium / luxury items"]
        ]]
      );
    }
  
    const [{ n: ecount }] = await q("SELECT COUNT(*) n FROM bb_expense_categories");
  
    if (!ecount) {
      await q(
        "INSERT INTO bb_expense_categories (name) VALUES ?",
        [[
          "Food Ingredients",
          "Staff Salary",
          "Utilities",
          "Rent",
          "Packaging",
          "Cleaning",
          "Maintenance",
          "Marketing",
          "Miscellaneous"
        ].map((x) => [x])]
      );
    }
  
    const [{ n: tcount }] = await q("SELECT COUNT(*) n FROM bb_tables");
  
    if (!tcount) {
      await q(
        "INSERT INTO bb_tables (name, capacity, sort_order, status_since) VALUES ?",
        [Array.from({ length: Math.max(1, Number(opts.tables) || 24) }, (_, i) => [
          `T${i + 1}`,
          4,
          i + 1,
          new Date()
        ])]
      );
    }
  
    const tablesWithoutQr = await q(
      'SELECT id FROM bb_tables WHERE qr_token IS NULL OR qr_token = ""'
    );
  
    for (const t of tablesWithoutQr) {
      await q("UPDATE bb_tables SET qr_token = ? WHERE id = ?", [
        newQrToken(),
        t.id
      ]);
    }
  
    const [{ n: scount }] = await q("SELECT COUNT(*) n FROM bb_settings");
  
    if (!scount) {
      const gst5 = (
        await q("SELECT id FROM bb_tax_rates WHERE rate = 5 ORDER BY id LIMIT 1")
      )[0];
  
      const s = {
        ...DEFAULTS,
        default_tax_rate_id: gst5 ? gst5.id : 0,
        ...(opts.settings || {})
      };
  
      await q("INSERT INTO bb_settings (k, v) VALUES ?", [
        Object.entries(s).map(([k, v]) => [k, JSON.stringify(v)])
      ]);
    }
  
    await q("INSERT IGNORE INTO bb_sequences (name, value) VALUES ('bill', ?)", [
      DEFAULTS.bill_start - 1
    ]);
  });
}

const PLATFORM_DDL = [
  // Every cafe / restaurant that uses the system
  `CREATE TABLE IF NOT EXISTS platform_tenants (
    id INT AUTO_INCREMENT PRIMARY KEY,
    slug VARCHAR(60) NOT NULL UNIQUE,
    name VARCHAR(150) NOT NULL,
    owner_name VARCHAR(100) NOT NULL,
    owner_email VARCHAR(150) NOT NULL,
    owner_phone VARCHAR(30) NULL,
    status VARCHAR(12) NOT NULL DEFAULT 'active',
    plan VARCHAR(40) NOT NULL DEFAULT 'free',
    subscription_ends_at DATE NULL,
    notes VARCHAR(500) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Website owner (super admin) accounts
  `CREATE TABLE IF NOT EXISTS platform_admins (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(150) NOT NULL UNIQUE,
    password_hash VARCHAR(100) NOT NULL,
    is_active TINYINT NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // email / waiter mobile -> which cafe this login belongs to
  `CREATE TABLE IF NOT EXISTS platform_logins (
    login_key VARCHAR(190) NOT NULL PRIMARY KEY,
    tenant_id INT NOT NULL,
    user_id INT NOT NULL,
    INDEX (tenant_id, user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

const PLATFORM_DDL_2 = [
  // Subscription plans (limits: empty = unlimited, duration 0 = no expiry)
  `CREATE TABLE IF NOT EXISTS platform_plans (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(40) NOT NULL UNIQUE,
    name VARCHAR(80) NOT NULL,
    price DECIMAL(10,2) NOT NULL DEFAULT 0,
    duration_days INT NOT NULL DEFAULT 30,
    max_staff INT NULL,
    max_tables INT NULL,
    max_items INT NULL,
    is_trial TINYINT NOT NULL DEFAULT 0,
    is_active TINYINT NOT NULL DEFAULT 1,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Payments you record by hand (cash / UPI / bank)
  `CREATE TABLE IF NOT EXISTS platform_payments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    tenant_name VARCHAR(150) NOT NULL,
    amount DECIMAL(10,2) NOT NULL DEFAULT 0,
    paid_on DATE NOT NULL,
    method VARCHAR(20) NOT NULL DEFAULT 'cash',
    reference VARCHAR(100) NULL,
    note VARCHAR(255) NULL,
    plan VARCHAR(40) NULL,
    days_added INT NOT NULL DEFAULT 0,
    created_by VARCHAR(100) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (tenant_id), INDEX (paid_on)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // What the owner / support team did
  `CREATE TABLE IF NOT EXISTS platform_activity (
    id INT AUTO_INCREMENT PRIMARY KEY,
    admin_id INT NULL,
    admin_name VARCHAR(100) NULL,
    action VARCHAR(40) NOT NULL,
    tenant_id INT NULL,
    tenant_name VARCHAR(150) NULL,
    details VARCHAR(500) NULL,
    ip VARCHAR(60) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (tenant_id), INDEX (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS platform_settings (
    k VARCHAR(60) NOT NULL PRIMARY KEY,
    v VARCHAR(500) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Remembers every email / mobile / GST that already used a free trial (even after a cafe is deleted)
  `CREATE TABLE IF NOT EXISTS platform_trials (
    key_type CHAR(1) NOT NULL,
    key_value VARCHAR(190) NOT NULL,
    tenant_id INT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (key_type, key_value)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

async function addGlobalColumn(table, col, def) {
  const r = await q(
    "SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1",
    [table, col]
  );
  if (!r.length) await q(`ALTER TABLE \`${table}\` ADD COLUMN \`${col}\` ${def}`);
}

const SEED_PLANS = [
  // code, name, price, days, staff, tables, items, trial, order
  ["trial", "Free Trial", 0, 14, 3, 12, 40, 1, 1],
  ["free", "Free (no expiry)", 0, 0, null, null, null, 0, 2],
  ["basic", "Basic", 499, 30, 5, 20, 100, 0, 3],
  ["standard", "Standard", 999, 30, 15, 50, 300, 0, 4],
  ["premium", "Premium", 1999, 30, null, null, null, 0, 5]
];

// Shared tables + the website owner account (ADMIN_EMAIL / ADMIN_PASSWORD in .env)
async function migrateGlobal() {
  await q(DDL[0]); // bb_files is shared by all cafes
  for (const sql of PLATFORM_DDL) await q(sql);
  for (const sql of PLATFORM_DDL_2) await q(sql);

  await addGlobalColumn("platform_admins", "role", "VARCHAR(12) NOT NULL DEFAULT 'owner'");
  await addGlobalColumn("platform_tenants", "owner_email_key", "VARCHAR(150) NULL");
  await addGlobalColumn("platform_tenants", "owner_phone_key", "VARCHAR(10) NULL");
  await addGlobalColumn("platform_tenants", "gst_no", "VARCHAR(20) NULL");
  await addGlobalColumn("platform_tenants", "pending_password_hash", "VARCHAR(100) NULL");
  await addGlobalColumn("platform_tenants", "approved_at", "TIMESTAMP NULL");
  await q("UPDATE platform_tenants SET owner_email_key = LOWER(owner_email) WHERE owner_email_key IS NULL");

  const [{ pn }] = await q("SELECT COUNT(*) pn FROM platform_plans");
  if (!pn) {
    await q(
      "INSERT INTO platform_plans (code, name, price, duration_days, max_staff, max_tables, max_items, is_trial, sort_order) VALUES ?",
      [SEED_PLANS]
    );
  }

  const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();

  if (email && process.env.ADMIN_PASSWORD) {
    const ex = await q("SELECT id FROM platform_admins WHERE email = ?", [email]);
    if (!ex.length) {
      const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
      await q(
        "INSERT INTO platform_admins (name, email, password_hash) VALUES ('Owner', ?, ?)",
        [email, hash]
      );
      console.log("Website owner account created for " + email);
    }
  } else {
    const [{ n }] = await q("SELECT COUNT(*) n FROM platform_admins");
    if (!n) {
      console.warn(
        "No website owner account yet. Set ADMIN_EMAIL and ADMIN_PASSWORD in environment variables, then restart."
      );
    }
  }
}

module.exports = { migrateGlobal, provisionTenant };
