"use strict";

// Cafes (tenants): lookup, access rules (pending / suspended / subscription), plans & limits,
// trial protection, creation, login index.

const bcrypt = require("bcryptjs");
const pool = require("../config/db");
const { fail } = require("./errors");
const { als, TENANT_TABLES, prefix, currentTenantId } = require("./tenantSql");
const { provisionTenant } = require("./migrate");

const q = async (sql, p) => (await pool.query(sql, p))[0];
const one = async (sql, p) => (await q(sql, p))[0] || null;

const SUPPORT = () => (process.env.SUPPORT_CONTACT ? ` Contact: ${process.env.SUPPORT_CONTACT}` : "");

/* ---------- dates ---------- */
const p2 = (n) => String(n).padStart(2, "0");
const toYmd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const todayYmd = () => toYmd(new Date());
function addDays(ymd, n) {
  const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number);
  return toYmd(new Date(y, m - 1, d + Number(n)));
}
const endOf = (t) => (t && t.subscription_ends_at ? String(t.subscription_ends_at).slice(0, 10) : "");

/* ---------- platform settings (owner can change them from the panel) ---------- */
const off = (v) => /^(0|false|no|off)$/i.test(String(v));
const settingDefaults = () => ({
  signup_open: !off(process.env.SIGNUP_OPEN || "true"),
  approval_required: !off(process.env.APPROVAL_REQUIRED || "true"),
  trial_days: 14,
  grace_days: 3,
});
let settingsMemo = null;

async function getPlatformSettings(force) {
  if (!force && settingsMemo && Date.now() - settingsMemo.at < 10000) return settingsMemo.s;
  const s = settingDefaults();
  for (const r of await q("SELECT k, v FROM platform_settings")) {
    try { s[r.k] = JSON.parse(r.v); } catch { s[r.k] = r.v; }
  }
  settingsMemo = { s, at: Date.now() };
  return s;
}

async function setPlatformSettings(obj) {
  const allowed = Object.keys(settingDefaults());
  for (const k of allowed) {
    if (obj[k] === undefined) continue;
    await q("INSERT INTO platform_settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)", [k, JSON.stringify(obj[k])]);
  }
  settingsMemo = null;
  return getPlatformSettings(true);
}

/* ---------- plans ---------- */
let plansMemo = null;
async function getPlans(force) {
  if (!force && plansMemo && Date.now() - plansMemo.at < 15000) return plansMemo.rows;
  const rows = await q("SELECT * FROM platform_plans ORDER BY sort_order, id");
  plansMemo = { rows, at: Date.now() };
  return rows;
}
const getPlan = async (code) => (await getPlans()).find((p) => p.code === code) || null;
const clearPlanCache = () => { plansMemo = null; };

/* ---------- cafe lookup (short cache) ---------- */
const cache = new Map();
const TTL = 15 * 1000;

async function getTenant(tid) {
  const id = Number(tid);
  if (!Number.isInteger(id) || id < 1) return null;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL) return hit.row;
  const row = await one("SELECT * FROM platform_tenants WHERE id = ?", [id]);
  cache.set(id, { row, at: Date.now() });
  return row;
}
const clearTenantCache = () => cache.clear();

const getTenantBySlug = (slug) =>
  one("SELECT * FROM platform_tenants WHERE slug = ?", [String(slug || "").toLowerCase()]);

/*
  What may this cafe do right now?
    blocked   -> cannot sign in at all (pending approval / suspended)
    readOnly  -> subscription ended (after the grace days): can look at data, cannot change anything
    grace     -> subscription just ended, still fully working for a few days
*/
async function accessInfo(t) {
  if (!t) return { blocked: "This cafe account was not found." };
  if (t.status === "pending") return { blocked: "Your cafe is waiting for approval. We will contact you soon." + SUPPORT() };
  if (t.status !== "active") return { blocked: "This cafe account is suspended." + SUPPORT() };
  const end = endOf(t);
  if (end && todayYmd() > end) {
    const grace = Number((await getPlatformSettings()).grace_days) || 0;
    if (todayYmd() <= addDays(end, grace)) return { grace: true, end, graceUntil: addDays(end, grace) };
    return {
      readOnly: true,
      end,
      message: `Your subscription ended on ${end}. You can view your data, but changes are switched off until you renew.` + SUPPORT(),
    };
  }
  return {};
}

// Short form used by login screens: message when the cafe is blocked, otherwise null.
function accessError(t) {
  if (!t) return "This cafe account was not found.";
  if (t.status === "pending") return "Your cafe is waiting for approval. We will contact you soon." + SUPPORT();
  if (t.status !== "active") return "This cafe account is suspended." + SUPPORT();
  return null;
}

/* ---------- schema per cafe (created once per server start) ---------- */
const ensured = new Map();

function ensureTenant(tid) {
  if (!ensured.has(tid)) {
    ensured.set(
      tid,
      (async () => {
        await provisionTenant(tid);
        await reindexTenant(tid);
      })().catch((e) => {
        ensured.delete(tid);
        throw e;
      })
    );
  }
  return ensured.get(tid);
}

// Run fn() as cafe `tid` (checks the cafe exists, is allowed in and its tables are ready).
async function runInTenant(tid, fn) {
  const t = await getTenant(tid);
  if (!t) throw fail(404, "This cafe was not found.");
  const info = await accessInfo(t);
  if (info.blocked) throw fail(403, info.blocked);
  await ensureTenant(t.id);
  return als.run({ tid: t.id, readOnly: !!info.readOnly, readOnlyMessage: info.message || "" }, fn);
}

// Run fn() as cafe `tid` with NO status checks (owner/platform operations).
const runRaw = (tid, fn) => als.run({ tid: Number(tid) }, fn);

/* ---------- plan limits (staff / tables / menu items) ---------- */
const LIMITS = {
  staff: { col: "max_staff", label: "staff members", sql: "SELECT COUNT(*) n FROM bb_users WHERE role <> 'admin'" },
  tables: { col: "max_tables", label: "tables", sql: "SELECT COUNT(*) n FROM bb_tables WHERE is_active = 1" },
  items: { col: "max_items", label: "menu items", sql: "SELECT COUNT(*) n FROM products WHERE is_archived = 0" },
};

// Call before adding staff / a table / a menu item. Throws when the cafe's plan is full.
async function assertLimit(kind) {
  const L = LIMITS[kind];
  const t = await getTenant(currentTenantId());
  const plan = t ? await getPlan(t.plan) : null;
  const limit = plan ? plan[L.col] : null;
  if (limit === null || limit === undefined) return;
  const [{ n }] = await q(L.sql);
  if (Number(n) >= Number(limit)) {
    throw fail(403, `Your ${plan.name} plan allows up to ${limit} ${L.label}. Please upgrade to add more.` + SUPPORT());
  }
}

/* ---------- login index: email / waiter phone -> cafe ---------- */
const phone10 = (p) => String(p || "").replace(/\D/g, "").slice(-10);

function loginKeys({ email, phone, role }) {
  const keys = [];
  if (email) keys.push("e:" + String(email).trim().toLowerCase());
  if (role === "waiter" && phone10(phone).length === 10) keys.push("p:" + phone10(phone));
  return keys;
}

async function findLogin(key) {
  return one("SELECT tenant_id, user_id FROM platform_logins WHERE login_key = ?", [key]);
}

// Throws when this email / waiter phone already belongs to another account (any cafe).
async function assertLoginFree(tid, userId, u) {
  for (const key of loginKeys(u)) {
    const row = await findLogin(key);
    if (row && !(Number(row.tenant_id) === Number(tid) && Number(row.user_id) === Number(userId))) {
      throw fail(
        409,
        key.startsWith("e:")
          ? "This email is already used by another account. Use a different email."
          : "This mobile number is already used by another waiter account."
      );
    }
  }
}

// Make the index match one user's current row (call inside the cafe context).
async function reindexUser(tid, userId) {
  await q("DELETE FROM platform_logins WHERE tenant_id = ? AND user_id = ?", [tid, userId]);
  const u = await one("SELECT id, email, phone, role, is_active FROM bb_users WHERE id = ?", [userId]);
  if (!u) return;
  for (const key of loginKeys(u)) {
    await q("INSERT IGNORE INTO platform_logins (login_key, tenant_id, user_id) VALUES (?,?,?)", [key, tid, u.id]);
  }
}

async function removeUserLogins(tid, userId) {
  await q("DELETE FROM platform_logins WHERE tenant_id = ? AND user_id = ?", [tid, userId]);
}

async function reindexTenant(tid) {
  await runRaw(tid, async () => {
    const users = await q("SELECT id, email, phone, role FROM bb_users");
    await q("DELETE FROM platform_logins WHERE tenant_id = ?", [tid]);
    for (const u of users) {
      for (const key of loginKeys(u)) {
        await q("INSERT IGNORE INTO platform_logins (login_key, tenant_id, user_id) VALUES (?,?,?)", [key, tid, u.id]);
      }
    }
  });
}

/* ---------- free-trial protection ---------- */
// a.b+x@gmail.com and ab@gmail.com are the same mailbox
function normEmail(e) {
  const s = String(e || "").trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at < 1) return s;
  let local = s.slice(0, at).split("+")[0];
  let domain = s.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}
const phoneKey = (p) => (phone10(p).length === 10 ? phone10(p) : "");
const normGst = (g) => String(g || "").trim().toUpperCase();

function trialKeys({ email, phone, gst }) {
  const k = [["e", normEmail(email)]];
  if (phoneKey(phone)) k.push(["p", phoneKey(phone)]);
  if (normGst(gst)) k.push(["g", normGst(gst)]);
  return k;
}

async function assertTrialAvailable(o) {
  for (const [type, value] of trialKeys(o)) {
    if (await one("SELECT tenant_id FROM platform_trials WHERE key_type = ? AND key_value = ?", [type, value])) {
      const what = type === "e" ? "email" : type === "p" ? "mobile number" : "GST number";
      throw fail(409, `A free trial was already used with this ${what}. Please contact us to subscribe.` + SUPPORT());
    }
  }
}

async function recordTrial(tid, o) {
  for (const [type, value] of trialKeys(o)) {
    await q("INSERT IGNORE INTO platform_trials (key_type, key_value, tenant_id) VALUES (?,?,?)", [type, value, tid]);
  }
}

/* ---------- create / approve / delete a cafe ---------- */
const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "cafe";

async function uniqueSlug(name) {
  const base = slugify(name);
  let slug = base;
  for (let i = 2; await one("SELECT id FROM platform_tenants WHERE slug = ?", [slug]); i++) {
    slug = `${base}-${i}`;
  }
  return slug;
}

// Create the cafe's tables and its first admin login. Returns the new admin's user id.
async function provisionOwner(tid, o) {
  const plan = await getPlan(o.plan);
  const tables = Math.min(24, (plan && plan.max_tables) || 24);
  let ownerUserId = null;
  await runRaw(tid, async () => {
    await provisionTenant(tid, {
      tables,
      settings: {
        restaurant_name: o.name,
        qr_brand_name: o.name.toUpperCase(),
        company_name: o.name,
        email: o.email,
        phone: o.phone || "",
      },
    });
    const r = (
      await pool.query("INSERT INTO bb_users (name, email, phone, password_hash, role) VALUES (?,?,?,?, 'admin')", [
        o.ownerName, o.email, o.phone || null, o.hash,
      ])
    )[0];
    ownerUserId = r.insertId;
    await reindexUser(tid, r.insertId);
  });
  ensured.set(tid, Promise.resolve());
  return ownerUserId;
}

/*
  Options:
    trial   true  -> uses the free-trial plan; one trial per email / mobile / GST
    pending true  -> wait for the owner's approval (nothing is created until approved)
    plan / subscriptionEndsAt -> for cafes the owner adds by hand
*/
async function createTenant({ name, ownerName, email, phone, password, gst, trial, pending, plan, subscriptionEndsAt }) {
  email = String(email).trim().toLowerCase();
  const emailKey = normEmail(email);
  if (await findLogin("e:" + email)) {
    throw fail(409, "An account with this email already exists. Please sign in instead.");
  }
  if (await one("SELECT id FROM platform_tenants WHERE owner_email_key = ? AND status = 'pending'", [emailKey])) {
    throw fail(409, "This email already has a request waiting for approval.");
  }
  if (trial) await assertTrialAvailable({ email, phone, gst });

  const planCode = trial ? "trial" : plan || "free";
  const planRow = await getPlan(planCode);
  if (!planRow) throw fail(400, "Unknown plan.");

  const s = await getPlatformSettings();
  let endsAt = subscriptionEndsAt || null;
  if (!pending && !endsAt && planRow.is_trial) endsAt = addDays(todayYmd(), Number(s.trial_days) || 14);

  const slug = await uniqueSlug(name);
  const hash = await bcrypt.hash(String(password), 10);
  const [ins] = await pool.query(
    `INSERT INTO platform_tenants
      (slug, name, owner_name, owner_email, owner_phone, plan, subscription_ends_at, status,
       owner_email_key, owner_phone_key, gst_no, pending_password_hash, approved_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?, ${pending ? "NULL" : "NOW()"})`,
    [
      slug, name, ownerName, email, phone || null, planCode, endsAt, pending ? "pending" : "active",
      emailKey, phoneKey(phone) || null, normGst(gst) || null, pending ? hash : null,
    ]
  );
  const tid = ins.insertId;
  if (trial) await recordTrial(tid, { email, phone, gst });

  let ownerUserId = null;
  if (!pending) {
    try {
      ownerUserId = await provisionOwner(tid, { plan: planCode, name, ownerName, email, phone, hash });
    } catch (e) {
      await dropTenantData(tid).catch(() => {});
      await q("DELETE FROM platform_logins WHERE tenant_id = ?", [tid]).catch(() => {});
      await q("DELETE FROM platform_trials WHERE tenant_id = ?", [tid]).catch(() => {});
      await q("DELETE FROM platform_tenants WHERE id = ?", [tid]).catch(() => {});
      throw e;
    }
  }
  clearTenantCache();
  return { ...(await getTenant(tid)), owner_user_id: ownerUserId };
}

// Approve a cafe that was waiting: create its tables + admin login and start its trial clock.
async function approveTenant(tid) {
  const t = await one("SELECT * FROM platform_tenants WHERE id = ?", [Number(tid)]);
  if (!t) throw fail(404, "Cafe not found.");
  if (t.status !== "pending") throw fail(400, "This cafe is not waiting for approval.");
  if (!t.pending_password_hash) throw fail(400, "This request has no saved password. Reject it and create the cafe manually.");
  if (await findLogin("e:" + String(t.owner_email).toLowerCase())) {
    throw fail(409, "Another account already uses this email.");
  }
  let ownerUserId;
  try {
    ownerUserId = await provisionOwner(t.id, {
      plan: t.plan, name: t.name, ownerName: t.owner_name, email: String(t.owner_email).toLowerCase(),
      phone: t.owner_phone, hash: t.pending_password_hash,
    });
  } catch (e) {
    await dropTenantData(t.id).catch(() => {});
    await q("DELETE FROM platform_logins WHERE tenant_id = ?", [t.id]).catch(() => {});
    ensured.delete(t.id);
    throw e;
  }
  const planRow = await getPlan(t.plan);
  const s = await getPlatformSettings();
  const endsAt = planRow && planRow.is_trial ? addDays(todayYmd(), Number(s.trial_days) || 14) : endOf(t) || null;
  await q(
    "UPDATE platform_tenants SET status = 'active', approved_at = NOW(), pending_password_hash = NULL, subscription_ends_at = ? WHERE id = ?",
    [endsAt, t.id]
  );
  clearTenantCache();
  return { ...(await getTenant(t.id)), owner_user_id: ownerUserId };
}

// Add days to a cafe's subscription (counting from today if it already ended).
async function extendSubscription(tid, days) {
  const t = await one("SELECT * FROM platform_tenants WHERE id = ?", [Number(tid)]);
  if (!t) throw fail(404, "Cafe not found.");
  const n = Math.floor(Number(days));
  if (!Number.isFinite(n) || n < 1 || n > 3650) throw fail(400, "Days must be between 1 and 3650.");
  const end = endOf(t);
  const base = end && end >= todayYmd() ? end : todayYmd();
  const next = addDays(base, n);
  await q("UPDATE platform_tenants SET subscription_ends_at = ? WHERE id = ?", [next, t.id]);
  clearTenantCache();
  return next;
}

async function dropTenantData(tid) {
  const c = await pool.getConnection();
  try {
    await c.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const t of TENANT_TABLES) {
      // already-prefixed name, so no cafe context is needed for a raw DROP
      await c.query(`DROP TABLE IF EXISTS \`${prefix(tid)}${t}\``);
    }
    await c.query("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    c.release();
  }
}

// Delete a cafe and all its data. (Trial history is kept so the same email cannot take another trial.)
async function deleteTenant(tid) {
  await dropTenantData(tid);
  await q("DELETE FROM platform_logins WHERE tenant_id = ?", [tid]);
  await q("DELETE FROM platform_tenants WHERE id = ?", [tid]);
  ensured.delete(Number(tid));
  clearTenantCache();
}

const listActiveTenantIds = async () =>
  (await q("SELECT id FROM platform_tenants WHERE status = 'active'")).map((r) => r.id);

module.exports = {
  getTenant, getTenantBySlug, clearTenantCache, accessInfo, accessError, ensureTenant, runInTenant, runRaw,
  getPlatformSettings, setPlatformSettings, getPlans, getPlan, clearPlanCache, assertLimit,
  loginKeys, findLogin, assertLoginFree, reindexUser, removeUserLogins, reindexTenant,
  normEmail, phoneKey, normGst, createTenant, approveTenant, extendSubscription, deleteTenant,
  slugify, listActiveTenantIds, phone10, todayYmd, addDays, endOf, SUPPORT,
};
