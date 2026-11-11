"use strict";

// Cafes (tenants): lookup, access rules (suspended / subscription), creation, login index.

const bcrypt = require("bcryptjs");
const pool = require("../config/db");
const { fail } = require("./errors");
const { als, TENANT_TABLES, prefix } = require("./tenantSql");
const { provisionTenant } = require("./migrate");

const q = async (sql, p) => (await pool.query(sql, p))[0];
const one = async (sql, p) => (await q(sql, p))[0] || null;

const SUPPORT = () => (process.env.SUPPORT_CONTACT ? ` Contact: ${process.env.SUPPORT_CONTACT}` : "");

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

const todayYmd = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// Returns a message when this cafe may NOT use the app right now, otherwise null.
// Subscription hook: set subscription_ends_at (a date) for a cafe and it is blocked after that day.
function accessError(t) {
  if (!t) return "This cafe account was not found.";
  if (t.status !== "active") return "This cafe account is suspended." + SUPPORT();
  const end = t.subscription_ends_at ? String(t.subscription_ends_at).slice(0, 10) : "";
  if (end && end < todayYmd()) return `Your subscription ended on ${end}. Please renew to continue.` + SUPPORT();
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

// Run fn() as cafe `tid` (checks the cafe exists, is active and its tables are ready).
async function runInTenant(tid, fn) {
  const t = await getTenant(tid);
  if (!t) throw fail(404, "This cafe was not found.");
  const err = accessError(t);
  if (err) throw fail(403, err);
  await ensureTenant(t.id);
  return als.run({ tid: t.id }, fn);
}

// Run fn() as cafe `tid` with NO status checks (owner/platform operations).
const runRaw = (tid, fn) => als.run({ tid: Number(tid) }, fn);

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

/* ---------- create / delete a cafe ---------- */
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

async function createTenant({ name, ownerName, email, phone, password, plan, subscriptionEndsAt }) {
  email = String(email).trim().toLowerCase();
  if (await findLogin("e:" + email)) {
    throw fail(409, "An account with this email already exists. Please sign in instead.");
  }
  const slug = await uniqueSlug(name);
  const [ins] = await pool.query(
    "INSERT INTO platform_tenants (slug, name, owner_name, owner_email, owner_phone, plan, subscription_ends_at) VALUES (?,?,?,?,?,?,?)",
    [slug, name, ownerName, email, phone || null, plan || "free", subscriptionEndsAt || null]
  );
  const tid = ins.insertId;
  let ownerUserId = null;
  try {
    const hash = await bcrypt.hash(String(password), 10);
    await runRaw(tid, async () => {
      await provisionTenant(tid, {
        settings: {
          restaurant_name: name,
          qr_brand_name: name.toUpperCase(),
          company_name: name,
          email,
          phone: phone || "",
        },
      });
      const r = (
        await pool.query("INSERT INTO bb_users (name, email, phone, password_hash, role) VALUES (?,?,?,?, 'admin')", [
          ownerName, email, phone || null, hash,
        ])
      )[0];
      ownerUserId = r.insertId;
      await reindexUser(tid, r.insertId);
    });
    ensured.set(tid, Promise.resolve());
  } catch (e) {
    await dropTenantData(tid).catch(() => {});
    await q("DELETE FROM platform_logins WHERE tenant_id = ?", [tid]).catch(() => {});
    await q("DELETE FROM platform_tenants WHERE id = ?", [tid]).catch(() => {});
    throw e;
  }
  clearTenantCache();
  return { ...(await getTenant(tid)), owner_user_id: ownerUserId };
}

async function dropTenantData(tid) {
  const c = await pool.getConnection();
  try {
    await c.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const t of TENANT_TABLES) {
      // direct (already prefixed) name; no tenant context is needed for raw DROP
      await c.query(`DROP TABLE IF EXISTS \`${prefix(tid)}${t}\``);
    }
    await c.query("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    c.release();
  }
}

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
  getTenant, getTenantBySlug, clearTenantCache, accessError, ensureTenant, runInTenant, runRaw,
  loginKeys, findLogin, assertLoginFree, reindexUser, removeUserLogins, reindexTenant,
  createTenant, deleteTenant, slugify, listActiveTenantIds, phone10,
};
