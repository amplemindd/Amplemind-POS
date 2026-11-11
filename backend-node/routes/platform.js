"use strict";
// Website owner (super admin) + cafe sign-up.
//   POST /api/platform/signup          public  - a new cafe owner creates their cafe
//   POST /api/platform/login           public  - website owner login
//   /api/platform/tenants ...          owner   - manage every cafe, plan and subscription date
const bcrypt = require("bcryptjs");
const { api, q, one, fail, str, signToken, signPlatformToken, isYmd } = require("../lib/core");
const T = require("../lib/tenants");
const { runRaw } = T;

const SIGNUP_OPEN = () => !/^(0|false|no|off)$/i.test(String(process.env.SIGNUP_OPEN || "true"));
const PLANS = ["free", "trial", "basic", "standard", "premium"];

/* small in-memory limiter: max N hits per window per key */
const hits = new Map();
function limited(key, max, ms) {
  const now = Date.now();
  const a = (hits.get(key) || []).filter((t) => now - t < ms);
  if (a.length >= max) { hits.set(key, a); return true; }
  a.push(now); hits.set(key, a);
  return false;
}

const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
function validOwner(b) {
  const name = str(b.cafe_name, 150), owner = str(b.owner_name, 100), email = str(b.email, 150).toLowerCase();
  const phone = String(b.phone || "").replace(/[^\d+]/g, "").slice(0, 20), password = String(b.password || "");
  if (name.length < 2) throw fail(400, "Enter the cafe / restaurant name.");
  if (owner.length < 2) throw fail(400, "Enter the owner name.");
  if (!emailOk(email)) throw fail(400, "Enter a valid email address.");
  if (password.length < 8) throw fail(400, "Password must be at least 8 characters.");
  return { name, ownerName: owner, email, phone, password };
}
const pub = (t) => ({ id: t.id, slug: t.slug, name: t.name, status: t.status, plan: t.plan, subscription_ends_at: t.subscription_ends_at ? String(t.subscription_ends_at).slice(0, 10) : null });

/* ---------- public ---------- */
api.get("/api/platform/config", null, async () => ({ signup_open: SIGNUP_OPEN() }));

api.post("/api/platform/signup", null, async (ctx) => {
  if (!SIGNUP_OPEN()) throw fail(403, "New sign-ups are closed right now.");
  if (limited(`signup|${ctx.ip}`, 5, 60 * 60 * 1000)) throw fail(429, "Too many sign-ups from this network. Please try later.");
  const v = validOwner(ctx.body);
  const t = await T.createTenant(v);
  // sign the new owner in straight away
  const u = { id: t.owner_user_id, name: v.ownerName, email: v.email, role: "admin" };
  const out = await runRaw(t.id, async () => ({ token: signToken(u), user: { ...u, permissions: ["*"] } }));
  return { __status: 201, message: "Your cafe is ready.", ...out, tenant: pub(t) };
});

const attempts = new Map();
api.post("/api/platform/login", null, async (ctx) => {
  const email = str(ctx.body.email, 150).toLowerCase(), password = String(ctx.body.password || "");
  if (!email || !password) throw fail(400, "Email and password are required.");
  if (limited(`plogin|${email}|${ctx.ip}`, 8, 15 * 60 * 1000)) throw fail(429, "Too many attempts. Try again in 15 minutes.");
  const a = await one("SELECT * FROM platform_admins WHERE email = ?", [email]);
  if (!a || !a.is_active || !(await bcrypt.compare(password, a.password_hash))) throw fail(401, "Invalid email or password.");
  return { token: signPlatformToken(a), admin: { id: a.id, name: a.name, email: a.email } };
});

/* ---------- website owner only ---------- */
api.get("/api/platform/me", "platform", async (ctx) => ({ admin: ctx.admin }));

api.put("/api/platform/password", "platform", async (ctx) => {
  const cur = String(ctx.body.current_password || ""), next = String(ctx.body.new_password || "");
  if (next.length < 8) throw fail(400, "New password must be at least 8 characters.");
  const a = await one("SELECT * FROM platform_admins WHERE id = ?", [ctx.admin.id]);
  if (!(await bcrypt.compare(cur, a.password_hash))) throw fail(400, "Current password is wrong.");
  await q("UPDATE platform_admins SET password_hash = ? WHERE id = ?", [await bcrypt.hash(next, 10), a.id]);
  return { message: "Password changed." };
});

api.get("/api/platform/tenants", "platform", async (ctx) => {
  const w = [], p = [];
  if (ctx.query.status && ctx.query.status !== "all") { w.push("status = ?"); p.push(ctx.query.status); }
  if (ctx.query.q) { w.push("(name LIKE ? OR owner_email LIKE ? OR slug LIKE ?)"); const l = `%${String(ctx.query.q).slice(0, 60)}%`; p.push(l, l, l); }
  const rows = await q(`SELECT * FROM platform_tenants ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY id DESC LIMIT 500`, p);
  const today = new Date().toISOString().slice(0, 10);
  const total = await one("SELECT COUNT(*) n, SUM(status='active') active, SUM(status<>'active') suspended FROM platform_tenants");
  return {
    tenants: rows.map((t) => ({ ...t, subscription_ends_at: t.subscription_ends_at ? String(t.subscription_ends_at).slice(0, 10) : null,
      expired: !!t.subscription_ends_at && String(t.subscription_ends_at).slice(0, 10) < today })),
    summary: { total: Number(total.n || 0), active: Number(total.active || 0), suspended: Number(total.suspended || 0) },
    signup_open: SIGNUP_OPEN(),
  };
});

api.post("/api/platform/tenants", "platform", async (ctx) => {
  const v = validOwner(ctx.body);
  const plan = PLANS.includes(ctx.body.plan) ? ctx.body.plan : "free";
  const end = isYmd(ctx.body.subscription_ends_at) ? ctx.body.subscription_ends_at : null;
  const t = await T.createTenant({ ...v, plan, subscriptionEndsAt: end });
  return { __status: 201, tenant: pub(t), message: "Cafe created." };
});

api.get("/api/platform/tenants/:id", "platform", async (ctx) => {
  const t = await one("SELECT * FROM platform_tenants WHERE id = ?", [Number(ctx.params.id)]);
  if (!t) throw fail(404, "Cafe not found.");
  await T.ensureTenant(t.id);
  const stats = await runRaw(t.id, async () => {
    const [u] = await q("SELECT COUNT(*) n FROM bb_users");
    const [tb] = await q("SELECT COUNT(*) n FROM bb_tables WHERE is_active = 1");
    const [pr] = await q("SELECT COUNT(*) n FROM products WHERE is_archived = 0");
    const [o] = await q("SELECT COUNT(*) n, MAX(created_at) last_at FROM bb_orders");
    const [today] = await q("SELECT COUNT(*) n FROM bb_orders WHERE DATE(created_at) = CURDATE()");
    return { staff: u.n, tables: tb.n, items: pr.n, orders: o.n, orders_today: today.n, last_order_at: o.last_at };
  });
  return { tenant: { ...t, subscription_ends_at: t.subscription_ends_at ? String(t.subscription_ends_at).slice(0, 10) : null }, stats };
});

api.patch("/api/platform/tenants/:id", "platform", async (ctx) => {
  const id = Number(ctx.params.id), b = ctx.body;
  const t = await one("SELECT * FROM platform_tenants WHERE id = ?", [id]);
  if (!t) throw fail(404, "Cafe not found.");
  const sets = [], p = [];
  if (b.status !== undefined) { if (!["active", "suspended"].includes(b.status)) throw fail(400, "Status must be active or suspended."); sets.push("status = ?"); p.push(b.status); }
  if (b.plan !== undefined) { const plan = str(b.plan, 40).toLowerCase(); if (!/^[a-z0-9_-]{2,40}$/.test(plan)) throw fail(400, "Invalid plan name."); sets.push("plan = ?"); p.push(plan); }
  if (b.subscription_ends_at !== undefined) {
    if (b.subscription_ends_at && !isYmd(b.subscription_ends_at)) throw fail(400, "Use the date format YYYY-MM-DD.");
    sets.push("subscription_ends_at = ?"); p.push(b.subscription_ends_at || null);
  }
  if (b.notes !== undefined) { sets.push("notes = ?"); p.push(str(b.notes, 500) || null); }
  if (b.name !== undefined) { const n = str(b.name, 150); if (n.length < 2) throw fail(400, "Enter a cafe name."); sets.push("name = ?"); p.push(n); }
  if (!sets.length) throw fail(400, "Nothing to update.");
  await q(`UPDATE platform_tenants SET ${sets.join(", ")} WHERE id = ?`, [...p, id]);
  T.clearTenantCache();
  return { tenant: pub(await T.getTenant(id)), message: "Cafe updated." };
});

// Reset the password of the cafe's owner (first admin) - for "I forgot my password"
api.post("/api/platform/tenants/:id/reset-password", "platform", async (ctx) => {
  const id = Number(ctx.params.id), pw = String(ctx.body.password || "");
  if (pw.length < 8) throw fail(400, "Password must be at least 8 characters.");
  const t = await one("SELECT * FROM platform_tenants WHERE id = ?", [id]);
  if (!t) throw fail(404, "Cafe not found.");
  await T.ensureTenant(id);
  const hash = await bcrypt.hash(pw, 10);
  const n = await runRaw(id, async () => {
    const u = await one("SELECT id FROM bb_users WHERE email = ?", [t.owner_email]);
    if (!u) return 0;
    await q("UPDATE bb_users SET password_hash = ?, is_active = 1 WHERE id = ?", [hash, u.id]);
    return 1;
  });
  if (!n) throw fail(404, "The owner account was not found for this cafe.");
  return { message: `Password reset for ${t.owner_email}.` };
});

// Permanently delete a cafe and ALL its data
api.delete("/api/platform/tenants/:id", "platform", async (ctx) => {
  const id = Number(ctx.params.id);
  const t = await one("SELECT * FROM platform_tenants WHERE id = ?", [id]);
  if (!t) throw fail(404, "Cafe not found.");
  if (String(ctx.query.confirm || "") !== t.slug) throw fail(400, `Type the cafe code "${t.slug}" to confirm.`);
  await T.deleteTenant(id);
  return { message: "Cafe and all its data deleted." };
});
