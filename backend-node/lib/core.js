"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");
const DEFAULTS = require("./defaults");
const { currentTenantId, currentStore, tidFromQrToken } = require("./tenantSql");
const { runInTenant, getTenantBySlug } = require("./tenants");

const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const { HttpError, fail } = require("./errors");

const q = async (sql, params) => (await pool.query(sql, params))[0];
const one = async (sql, params) => (await q(sql, params))[0] || null;

async function tx(fn) {
  const c = await pool.getConnection();

  try {
    await c.beginTransaction();
    const r = await fn(c);
    await c.commit();
    return r;
  } catch (e) {
    await c.rollback();
    throw e;
  } finally {
    c.release();
  }
}

const cq = async (c, sql, params) => (await c.query(sql, params))[0];

/* ---------- SETTINGS ---------- */

// Settings are cached per cafe (never shared between cafes).
const settingsCache = new Map();

async function getSettings(force) {
  const tid = currentTenantId();
  const hit = settingsCache.get(tid);

  if (!force && hit && Date.now() - hit.at < 5000) {
    return hit.s;
  }

  const rows = await q("SELECT k, v FROM bb_settings");
  const s = { ...DEFAULTS };

  for (const r of rows) {
    try {
      s[r.k] = JSON.parse(r.v);
    } catch {
      s[r.k] = r.v;
    }
  }

  settingsCache.set(tid, { s, at: Date.now() });

  return s;
}

const clearSettingsCache = () => {
  settingsCache.delete(currentTenantId());
};

/* ---------- AUTH / PERMISSIONS ---------- */

const { PERMISSIONS } = require("./permissions");

// Safe permission check: null user will never crash.
const can = (user, perm) =>
  !!user &&
  Array.isArray(user.perms) &&
  (user.perms.includes("*") || user.perms.includes(perm));

function readClaims(req, issuer = "chai-order-api") {
  const m = (req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);

  if (!m || !process.env.JWT_SECRET) {
    return null;
  }

  try {
    return jwt.verify(m[1], process.env.JWT_SECRET, { issuer });
  } catch {
    return null;
  }
}

async function authenticate(req) {
  const payload = readClaims(req);

  // The token must belong to the cafe this request is running for.
  if (!payload || !payload.tid || Number(payload.tid) !== currentTenantId()) {
    return null;
  }

  const u = await one(
    `SELECT u.id, u.name, u.email, u.role, u.is_active,
            r.permissions
     FROM bb_users u
     LEFT JOIN bb_roles r ON r.name = u.role
     WHERE u.id = ?`,
    [payload.uid]
  );

  if (!u || !u.is_active) {
    return null;
  }

  let perms = [];

  try {
    perms = JSON.parse(u.permissions || "[]");
  } catch {
    perms = [];
  }

  if (u.role === "admin") {
    perms = ["*"];
  }

  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    perms
  };
}

// Multi-cafe mode: there is no anonymous cashier. Staff must always sign in.
async function publicUser() {
  return null;
}

const signToken = (user, extra = {}, expiresIn = "10h") =>
  jwt.sign(
    { uid: user.id, role: user.role, tid: currentTenantId(), ...extra },
    process.env.JWT_SECRET,
    {
      expiresIn,
      issuer: "chai-order-api"
    }
  );

const signPlatformToken = (admin) =>
  jwt.sign({ pid: admin.id, sa: true }, process.env.JWT_SECRET, {
    expiresIn: "12h",
    issuer: "chai-order-platform"
  });

async function authenticatePlatform(req) {
  const p = readClaims(req, "chai-order-platform");

  if (!p || !p.sa || !p.pid) {
    return null;
  }

  const a = await one(
    "SELECT id, name, email, role, is_active FROM platform_admins WHERE id = ?",
    [p.pid]
  );

  return a && a.is_active ? a : null;
}

/* ---------- AUDIT + NOTIFICATIONS ---------- */

async function audit(ctx, d, conn = pool) {
  try {
    await conn.query(
      `INSERT INTO bb_audit
       (user_id, user_name, action, module, details, record_id,
        old_values, new_values, ip, user_agent, level)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        ctx?.user?.id || null,
        ctx?.user?.name || d.user_name || "System",
        d.action,
        d.module,
        String(d.details || "").slice(0, 500),
        d.record_id == null ? null : String(d.record_id),
        d.old ? JSON.stringify(d.old) : null,
        d.neu ? JSON.stringify(d.neu) : null,
        ctx?.ip || null,
        String(ctx?.req?.headers?.["user-agent"] || "").slice(0, 250),
        d.level || "info"
      ]
    );
  } catch (e) {
    console.error("Audit log failed:", e.message);
  }
}

const NOTIFY_PREF = {
  order: "n_new_order",
  payment: "n_payment",
  inventory: "n_low_stock",
  table: "n_table",
  report: "n_daily_report",
  expense: "n_expense",
  system: "n_system"
};

async function notify(d, conn = pool) {
  try {
    const S = await getSettings();

    if (!d.force && NOTIFY_PREF[d.type] && S[NOTIFY_PREF[d.type]] === false) {
      return;
    }

    await conn.query(
      `INSERT IGNORE INTO bb_notifications
       (type, title, message, priority, link_type, link_id, dedupe_key)
       VALUES (?,?,?,?,?,?,?)`,
      [
        d.type,
        d.title,
        d.message || "",
        d.priority || "normal",
        d.link_type || null,
        d.link_id == null ? null : String(d.link_id),
        d.dedupe || null
      ]
    );
  } catch (e) {
    console.error("Notification failed:", e.message);
  }
}

/* ---------- UPLOADS ---------- */

const MIME = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/pdf": "pdf"
};

function saveUpload(
  dataUrl,
  { allowPdf = false, maxBytes = 2 * 1024 * 1024 } = {}
) {
  const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(
    String(dataUrl || "")
  );

  if (!m || !MIME[m[1]] || (m[1] === "application/pdf" && !allowPdf)) {
    throw fail(
      400,
      "Unsupported file type. Use JPG, PNG or WebP" +
        (allowPdf ? " (or PDF)." : ".")
    );
  }

  const buf = Buffer.from(m[2], "base64");

  if (!buf.length || buf.length > maxBytes) {
    throw fail(
      400,
      `File is too large (max ${Math.round(maxBytes / 1048576)} MB).`
    );
  }

  const name =
    `${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${MIME[m[1]]}`;

  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  pool.query("INSERT INTO bb_files (name, mime, data) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)", [name, m[1], buf]).catch(() => {});

  return `/uploads/${name}`;
}

function removeUpload(url) {
  try {
    if (!url || !String(url).startsWith("/uploads/")) {
      return;
    }

    const file = path.join(UPLOAD_DIR, path.basename(url));
    pool.query("DELETE FROM bb_files WHERE name = ?", [path.basename(url)]).catch(() => {});

    if (file.startsWith(UPLOAD_DIR) && fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch {
    // Ignore file removal errors.
  }
}

const EXT_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".pdf": "application/pdf" };
/* Read an upload back from the database (used when the file is missing on disk) */
async function loadUpload(name) {
  const [rows] = await pool.query("SELECT mime, data FROM bb_files WHERE name = ? LIMIT 1", [String(name || "")]);
  return rows && rows[0] ? rows[0] : null;
}
/* At start-up: copy files that exist on disk but are not in the database yet */
async function syncUploadsToDb() {
  let n = 0;
  for (const name of fs.readdirSync(UPLOAD_DIR)) {
    const mime = EXT_MIME[path.extname(name).toLowerCase()];
    if (!mime) continue;
    const [r] = await pool.query("SELECT 1 FROM bb_files WHERE name = ? LIMIT 1", [name]);
    if (r && r.length) continue;
    await pool.query("INSERT IGNORE INTO bb_files (name, mime, data) VALUES (?, ?, ?)", [name, mime, fs.readFileSync(path.join(UPLOAD_DIR, name))]);
    n++;
  }
  return n;
}
/* ---------- MISC HELPERS ---------- */

const r2 = (n) =>
  Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const pad = (n) => String(n).padStart(2, "0");

const ymd = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

function dateRange(query) {
  const t = ymd();

  let from = isYmd(query.from) ? query.from : t;
  let to = isYmd(query.to) ? query.to : from;

  if (to < from) {
    [from, to] = [to, from];
  }

  return { from, to };
}

function paging(query, def = 10, max = 100000) {
  const limit = Math.min(
    Math.max(parseInt(query.limit, 10) || def, 1),
    max
  );

  const page = Math.max(parseInt(query.page, 10) || 1, 1);

  return {
    limit,
    offset: (page - 1) * limit,
    page
  };
}

const like = (s) =>
  `%${String(s).replace(/[%_\\]/g, "\\$&")}%`;

const str = (v, max = 255) =>
  String(v ?? "").trim().slice(0, max);

const bool = (v, d = 0) =>
  v === undefined || v === null
    ? d
    : v === true || v === 1 || v === "1" || v === "true"
      ? 1
      : 0;

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/* ---------- ROUTER ---------- */

const READONLY_OK = new Set(["/api/auth/login", "/api/auth/logout", "/api/waiter/login"]);

const routes = [];

function add(method, pattern, perm, handler) {
  const keys = [];

  const re = new RegExp(
    "^" +
      pattern.replace(/:(\w+)/g, (_, k) => {
        keys.push(k);
        return "([^/]+)";
      }) +
      "/?$"
  );

  routes.push({
    method,
    re,
    keys,
    perm,
    handler
  });
}

const api = {
  get: (...a) => add("GET", ...a),
  post: (...a) => add("POST", ...a),
  put: (...a) => add("PUT", ...a),
  patch: (...a) => add("PATCH", ...a),
  delete: (...a) => add("DELETE", ...a)
};

function send(res, status, data, headers = {}) {
  if (res.writableEnded) {
    return;
  }

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers
  });

  res.end(JSON.stringify(data));
}

async function readBody(req, limit = 9 * 1024 * 1024) {
  const chunks = [];
  let size = 0;

  for await (const c of req) {
    size += c.length;

    if (size > limit) {
      throw fail(413, "Request is too large.");
    }

    chunks.push(c);
  }

  if (!size) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw fail(400, "Invalid JSON in request.");
  }
}

/* ---------- REQUEST DISPATCH ---------- */

async function dispatch(req, res, url) {
  for (const r of routes) {
    if (r.method !== req.method) {
      continue;
    }

    const m = r.re.exec(url.pathname);

    if (!m) {
      continue;
    }

    const params = {};

    r.keys.forEach((k, i) => {
      params[k] = decodeURIComponent(m[i + 1]);
    });

    const ctx = {
      req,
      res,
      params,
      query: Object.fromEntries(url.searchParams),
      user: null,
      admin: null,
      body: {},
      ip: req.socket.remoteAddress
    };

    /*
      Which cafe is this request for?

      - Routes with perm "platform" belong to the website owner (no cafe).
      - Routes with a perm use the cafe stored inside the staff token.
      - Public routes (perm = null) find the cafe from the QR token
        (/api/public/qr/:token) or the cafe slug (/api/.../:slug/...).
        Login routes pick the cafe themselves.
    */
    const isPlatform = typeof r.perm === "string" && r.perm.startsWith("platform");

    const exec = async () => {
      if (isPlatform) {
        ctx.admin = await authenticatePlatform(req);

        if (!ctx.admin) {
          throw fail(401, "Please sign in to the owner panel.");
        }

        if (r.perm === "platform.write" && ctx.admin.role !== "owner") {
          throw fail(403, "Only the owner can do this.");
        }
      } else if (r.perm) {
        // Subscription ended: the cafe can look but not change anything.
        const st = currentStore();

        if (st && st.readOnly && req.method !== "GET" && !READONLY_OK.has(url.pathname)) {
          throw fail(403, st.readOnlyMessage || "Your subscription has ended.");
        }

        ctx.user = process.env.JWT_SECRET ? await authenticate(req) : null;

        if (!ctx.user) {
          throw fail(401, "Please sign in to continue.");
        }

        if (r.perm !== "auth" && !can(ctx.user, r.perm)) {
          throw fail(403, "You do not have permission to do this.");
        }
      }

      if (!r.perm) {
        const st = currentStore();

        if (st && st.readOnly && req.method !== "GET" && !READONLY_OK.has(url.pathname)) {
          throw fail(403, "This cafe is not taking orders right now.");
        }
      }

      if (["POST", "PUT", "PATCH"].includes(req.method)) {
        ctx.body = await readBody(req);
      }

      const result = await r.handler(ctx);

      if (result !== undefined) {
        const { __status, ...rest } = result;

        send(res, __status || 200, {
          success: true,
          ...rest
        });
      }
    };

    let tid = null;

    if (r.perm && !isPlatform) {
      const c = readClaims(req);
      tid = c && c.tid ? Number(c.tid) : null;
    } else if (!r.perm && params.token) {
      tid = tidFromQrToken(params.token);

      if (!tid) {
        throw fail(404, "This table QR code is invalid or inactive.");
      }
    } else if (!r.perm && params.slug) {
      const t = await getTenantBySlug(params.slug);

      if (!t) {
        throw fail(404, "Cafe not found.");
      }

      tid = t.id;
    }

    if (tid) {
      await runInTenant(tid, exec);
    } else {
      await exec();
    }

    return true;
  }

  return false;
}

/* ---------- SETTINGS MASKING ---------- */

const SECRET_KEYS = [
  "swiggy_api_key",
  "swiggy_webhook_secret",
  "zomato_api_key",
  "zomato_webhook_secret"
];

const maskSettings = (S) => {
  const o = { ...S };

  for (const k of SECRET_KEYS) {
    o[k] = S[k] ? "********" : "";
  }

  return o;
};

/* ---------- EXPORTS ---------- */

module.exports = {
  SECRET_KEYS,
  maskSettings,
  pool,
  q,
  one,
  tx,
  cq,
  fail,
  HttpError,
  getSettings,
  clearSettingsCache,
  PERMISSIONS,
  can,
  authenticate,
  authenticatePlatform,
  signPlatformToken,
  signToken,
  currentTenantId,
  runInTenant,
  audit,
  notify,
  saveUpload,
  removeUpload,
  UPLOAD_DIR,
  loadUpload,
  syncUploadsToDb,
  r2,
  ymd,
  isYmd,
  dateRange,
  paging,
  like,
  str,
  bool,
  num,
  api,
  send,
  dispatch
};