"use strict";
// Website owner panel + cafe sign-up.
//   public : /api/platform/config, /signup, /login
//   "platform"       : any owner-panel user (owner or support) - read only
//   "platform.write" : the owner only - everything that changes something
const bcrypt = require("bcryptjs");
const { api, q, one, fail, str, signToken, signPlatformToken, isYmd } = require("../lib/core");
const T = require("../lib/tenants");
const { runRaw } = T;
const { TENANT_TABLES } = require("../lib/tenantSql");

const METHODS = ["cash", "upi", "bank", "card", "other"];

/* ---------- small helpers ---------- */
const hits = new Map();
function limited(key, max, ms) {
  const now = Date.now();
  const a = (hits.get(key) || []).filter((t) => now - t < ms);
  if (a.length >= max) { hits.set(key, a); return true; }
  a.push(now); hits.set(key, a);
  return false;
}

const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const intOrNull = (v) => (v === "" || v === null || v === undefined ? null : Math.floor(Number(v)));
const ymdOf = (v) => (v ? String(v).slice(0, 10) : null);

function validOwner(b, { phoneRequired } = {}) {
  const name = str(b.cafe_name, 150), owner = str(b.owner_name, 100), email = str(b.email, 150).toLowerCase();
  const phone = String(b.phone || "").replace(/[^\d+]/g, "").slice(0, 20), password = String(b.password || "");
  const gst = T.normGst(b.gst_no);
  if (name.length < 2) throw fail(400, "Enter the cafe / restaurant name.");
  if (owner.length < 2) throw fail(400, "Enter the owner name.");
  if (!emailOk(email)) throw fail(400, "Enter a valid email address.");
  if (phoneRequired && !T.phoneKey(phone)) throw fail(400, "Enter a valid 10-digit mobile number.");
  if (phone && !T.phoneKey(phone)) throw fail(400, "Enter a valid 10-digit mobile number.");
  if (gst && !/^[0-9A-Z]{15}$/.test(gst)) throw fail(400, "GST number must be 15 characters, or leave it blank.");
  if (password.length < 8) throw fail(400, "Password must be at least 8 characters.");
  return { name, ownerName: owner, email, phone, password, gst };
}

async function log(ctx, action, t, details) {
  try {
    await q("INSERT INTO platform_activity (admin_id, admin_name, action, tenant_id, tenant_name, details, ip) VALUES (?,?,?,?,?,?,?)", [
      ctx.admin ? ctx.admin.id : null, ctx.admin ? ctx.admin.name || ctx.admin.email : "System", action,
      t ? t.id : null, t ? t.name : null, details ? String(details).slice(0, 500) : null, ctx.ip || null,
    ]);
  } catch (e) { console.error("activity log failed:", e.message); }
}

const csvCell = (v) => {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formulas
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
function sendCsv(ctx, filename, headers, rows) {
  const out = [headers.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\r\n");
  ctx.res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"` });
  ctx.res.end("\ufeff" + out);
}

const TENANT_SELECT = `SELECT t.*, p.name plan_name, p.is_trial FROM platform_tenants t LEFT JOIN platform_plans p ON p.code = t.plan`;

function shape(t) {
  const today = T.todayYmd(), end = ymdOf(t.subscription_ends_at);
  let state = "active";
  if (t.status === "pending") state = "pending";
  else if (t.status !== "active") state = "suspended";
  else if (end && end < today) state = "expired";
  else if (t.is_trial) state = "trial";
  let days_left = null;
  if (end) days_left = Math.round((Date.parse(end) - Date.parse(today)) / 86400000);
  return {
    id: t.id, slug: t.slug, name: t.name, owner_name: t.owner_name, owner_email: t.owner_email, owner_phone: t.owner_phone,
    gst_no: t.gst_no, status: t.status, state, plan: t.plan, plan_name: t.plan_name || t.plan, is_trial: !!t.is_trial,
    subscription_ends_at: end, days_left, notes: t.notes, created_at: t.created_at, approved_at: t.approved_at,
  };
}

function listWhere(query) {
  const w = [], p = [];
  const st = query.status || "all";
  if (st === "active") w.push("t.status = 'active'");
  else if (st === "pending") w.push("t.status = 'pending'");
  else if (st === "suspended") w.push("t.status NOT IN ('active','pending')");
  else if (st === "expired") w.push("t.status = 'active' AND t.subscription_ends_at < CURDATE()");
  else if (st === "expiring") w.push("t.status = 'active' AND t.subscription_ends_at BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)");
  else if (st === "trial") w.push("t.status = 'active' AND p.is_trial = 1");
  if (query.plan) { w.push("t.plan = ?"); p.push(String(query.plan).slice(0, 40)); }
  if (query.q) { w.push("(t.name LIKE ? OR t.owner_email LIKE ? OR t.slug LIKE ? OR t.owner_phone LIKE ?)"); const l = `%${String(query.q).slice(0, 60)}%`; p.push(l, l, l, l); }
  return { where: w.length ? "WHERE " + w.join(" AND ") : "", params: p };
}
const SORTS = { newest: "t.id DESC", oldest: "t.id ASC", name: "t.name ASC", expiry: "t.subscription_ends_at IS NULL, t.subscription_ends_at ASC" };

/* ---------- today's sales across cafes (cached for a minute) ---------- */
let liveMemo = null;
async function cafeSales(tid) {
  await T.ensureTenant(tid);
  return runRaw(tid, async () => {
    const [r] = await q(
      `SELECT COALESCE(SUM(CASE WHEN DATE(paid_at) = CURDATE() THEN total END),0) today_sales,
              COALESCE(SUM(DATE(paid_at) = CURDATE()),0) today_orders,
              COALESCE(SUM(total),0) month_sales, COUNT(*) month_orders
       FROM bb_orders WHERE payment_status = 'paid' AND status <> 'cancelled' AND paid_at >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)`
    );
    return r;
  });
}
async function liveStats() {
  if (liveMemo && Date.now() - liveMemo.at < 60000) return liveMemo.data;
  const rows = await q("SELECT id, name FROM platform_tenants WHERE status = 'active' ORDER BY id DESC LIMIT 150");
  const list = [];
  for (const t of rows) {
    try {
      const r = await cafeSales(t.id);
      list.push({ id: t.id, name: t.name, today_sales: Number(r.today_sales), today_orders: Number(r.today_orders), month_sales: Number(r.month_sales), month_orders: Number(r.month_orders) });
    } catch (e) { /* a cafe that cannot be read is skipped */ }
  }
  const data = {
    today_sales: list.reduce((a, c) => a + c.today_sales, 0),
    today_orders: list.reduce((a, c) => a + c.today_orders, 0),
    month_sales: list.reduce((a, c) => a + c.month_sales, 0),
    month_orders: list.reduce((a, c) => a + c.month_orders, 0),
    top: list.filter((c) => c.month_sales > 0).sort((a, b) => b.month_sales - a.month_sales).slice(0, 5),
    cafes_counted: list.length,
  };
  liveMemo = { data, at: Date.now() };
  return data;
}

function lastMonths(n) {
  const out = [], d = new Date();
  d.setDate(1);
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

/* ======================= PUBLIC ======================= */
api.get("/api/platform/config", null, async () => {
  const S = await T.getPlatformSettings();
  return { signup_open: !!S.signup_open, approval_required: !!S.approval_required, trial_days: Number(S.trial_days) || 14 };
});

api.post("/api/platform/signup", null, async (ctx) => {
  const S = await T.getPlatformSettings();
  if (!S.signup_open) throw fail(403, "New sign-ups are closed right now." + T.SUPPORT());
  if (limited(`signup|${ctx.ip}`, Number(process.env.SIGNUP_LIMIT_PER_HOUR) || 5, 60 * 60 * 1000)) throw fail(429, "Too many sign-ups from this network. Please try later.");
  const v = validOwner(ctx.body, { phoneRequired: true });
  const t = await T.createTenant({ ...v, trial: true, pending: !!S.approval_required });
  await log({ ip: ctx.ip }, "signup", t, `${v.ownerName} <${v.email}> ${t.status === "pending" ? "(waiting for approval)" : "(trial started)"}`);
  if (t.status === "pending") {
    return { __status: 201, pending: true, message: "Thank you! Your request is received. We will approve it shortly and contact you." };
  }
  const u = { id: t.owner_user_id, name: v.ownerName, email: v.email, role: "admin" };
  const out = await runRaw(t.id, async () => ({ token: signToken(u), user: { ...u, permissions: ["*"] } }));
  return { __status: 201, message: "Your cafe is ready.", ...out };
});

api.post("/api/platform/login", null, async (ctx) => {
  const email = str(ctx.body.email, 150).toLowerCase(), password = String(ctx.body.password || "");
  if (!email || !password) throw fail(400, "Email and password are required.");
  if (limited(`plogin|${email}|${ctx.ip}`, 8, 15 * 60 * 1000)) throw fail(429, "Too many attempts. Try again in 15 minutes.");
  const a = await one("SELECT * FROM platform_admins WHERE email = ?", [email]);
  if (!a || !a.is_active || !(await bcrypt.compare(password, a.password_hash))) throw fail(401, "Invalid email or password.");
  await log({ admin: a, ip: ctx.ip }, "login", null, "Signed in to the owner panel");
  return { token: signPlatformToken(a), admin: { id: a.id, name: a.name, email: a.email, role: a.role } };
});

/* ======================= READ (owner + support) ======================= */
api.get("/api/platform/me", "platform", async (ctx) => ({ admin: ctx.admin }));

api.put("/api/platform/password", "platform", async (ctx) => {
  const cur = String(ctx.body.current_password || ""), next = String(ctx.body.new_password || "");
  if (next.length < 8) throw fail(400, "New password must be at least 8 characters.");
  const a = await one("SELECT * FROM platform_admins WHERE id = ?", [ctx.admin.id]);
  if (!(await bcrypt.compare(cur, a.password_hash))) throw fail(400, "Current password is wrong.");
  await q("UPDATE platform_admins SET password_hash = ? WHERE id = ?", [await bcrypt.hash(next, 10), a.id]);
  await log(ctx, "password", null, "Changed own password");
  return { message: "Password changed." };
});

api.get("/api/platform/dashboard", "platform", async () => {
  const [c] = await q(`SELECT COUNT(*) total,
      COALESCE(SUM(t.status = 'active'),0) active, COALESCE(SUM(t.status = 'pending'),0) pending,
      COALESCE(SUM(t.status NOT IN ('active','pending')),0) suspended,
      COALESCE(SUM(t.status = 'active' AND t.subscription_ends_at < CURDATE()),0) expired,
      COALESCE(SUM(t.status = 'active' AND t.subscription_ends_at BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)),0) expiring,
      COALESCE(SUM(t.status = 'active' AND p.is_trial = 1),0) trial
    FROM platform_tenants t LEFT JOIN platform_plans p ON p.code = t.plan`);
  const months = lastMonths(6), first = months[0] + "-01";
  const sRows = await q("SELECT DATE_FORMAT(created_at,'%Y-%m') ym, COUNT(*) n FROM platform_tenants WHERE created_at >= ? GROUP BY ym", [first]);
  const rRows = await q("SELECT DATE_FORMAT(paid_on,'%Y-%m') ym, COALESCE(SUM(amount),0) s FROM platform_payments WHERE paid_on >= ? GROUP BY ym", [first]);
  const sm = Object.fromEntries(sRows.map((r) => [r.ym, Number(r.n)])), rm = Object.fromEntries(rRows.map((r) => [r.ym, Number(r.s)]));
  const [rev] = await q("SELECT COALESCE(SUM(amount),0) total, COALESCE(SUM(CASE WHEN DATE_FORMAT(paid_on,'%Y-%m') = DATE_FORMAT(CURDATE(),'%Y-%m') THEN amount END),0) month FROM platform_payments");
  const mix = await q("SELECT t.plan, COALESCE(p.name, t.plan) name, COUNT(*) n FROM platform_tenants t LEFT JOIN platform_plans p ON p.code = t.plan WHERE t.status <> 'pending' GROUP BY t.plan, p.name ORDER BY n DESC");
  const pick = async (cond, order) => (await q(`${TENANT_SELECT} WHERE ${cond} ORDER BY ${order} LIMIT 8`)).map(shape);
  return {
    counts: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Number(v)])),
    signups: months.map((m) => ({ month: m, n: sm[m] || 0 })),
    revenue_months: months.map((m) => ({ month: m, amount: rm[m] || 0 })),
    revenue: { total: Number(rev.total), month: Number(rev.month) },
    plan_mix: mix.map((r) => ({ plan: r.plan, name: r.name, n: Number(r.n) })),
    pending: await pick("t.status = 'pending'", "t.id ASC"),
    expiring: await pick("t.status = 'active' AND t.subscription_ends_at BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)", "t.subscription_ends_at ASC"),
    expired: await pick("t.status = 'active' AND t.subscription_ends_at < CURDATE()", "t.subscription_ends_at DESC"),
    activity: await q("SELECT id, admin_name, action, tenant_id, tenant_name, details, created_at FROM platform_activity ORDER BY id DESC LIMIT 8"),
    live: await liveStats(),
  };
});

api.get("/api/platform/tenants", "platform", async (ctx) => {
  const { where, params } = listWhere(ctx.query);
  const order = SORTS[ctx.query.sort] || SORTS.newest;
  const rows = await q(`${TENANT_SELECT} ${where} ORDER BY ${order} LIMIT 500`, params);
  return { tenants: rows.map(shape) };
});

api.get("/api/platform/tenants.csv", "platform", async (ctx) => {
  const { where, params } = listWhere(ctx.query);
  const rows = (await q(`${TENANT_SELECT} ${where} ORDER BY t.id DESC`, params)).map(shape);
  sendCsv(ctx, "cafes.csv",
    ["ID", "Code", "Cafe", "Owner", "Email", "Mobile", "GST", "Status", "Plan", "Valid till", "Days left", "Joined"],
    rows.map((t) => [t.id, t.slug, t.name, t.owner_name, t.owner_email, t.owner_phone, t.gst_no, t.state, t.plan_name, t.subscription_ends_at, t.days_left, ymdOf(t.created_at)]));
});

api.get("/api/platform/tenants/:id", "platform", async (ctx) => {
  const id = Number(ctx.params.id);
  const row = await one(`${TENANT_SELECT} WHERE t.id = ?`, [id]);
  if (!row) throw fail(404, "Cafe not found.");
  const t = shape(row);
  let stats = null, staff = [];
  if (row.status !== "pending") {
    await T.ensureTenant(id);
    const out = await runRaw(id, async () => {
      const [u] = await q("SELECT COUNT(*) n FROM bb_users");
      const [tb] = await q("SELECT COUNT(*) n FROM bb_tables WHERE is_active = 1");
      const [pr] = await q("SELECT COUNT(*) n FROM products WHERE is_archived = 0");
      const [o] = await q("SELECT COUNT(*) n, COALESCE(SUM(total),0) s, MAX(paid_at) last_at FROM bb_orders WHERE payment_status = 'paid' AND status <> 'cancelled'");
      const [d] = await q("SELECT COUNT(*) n, COALESCE(SUM(total),0) s FROM bb_orders WHERE payment_status = 'paid' AND status <> 'cancelled' AND DATE(paid_at) = CURDATE()");
      const [m] = await q("SELECT COUNT(*) n, COALESCE(SUM(total),0) s FROM bb_orders WHERE payment_status = 'paid' AND status <> 'cancelled' AND paid_at >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)");
      const st = await q("SELECT name, email, role, is_active, last_login FROM bb_users ORDER BY id LIMIT 100");
      return {
        stats: { staff: u.n, tables: tb.n, items: pr.n, orders: o.n, sales_total: Number(o.s), last_order_at: o.last_at, orders_today: d.n, sales_today: Number(d.s), orders_30d: m.n, sales_30d: Number(m.s) },
        staff: st,
      };
    });
    stats = out.stats; staff = out.staff;
  }
  const plan = await T.getPlan(row.plan);
  return {
    tenant: t, stats, staff,
    limits: plan ? { staff: plan.max_staff, tables: plan.max_tables, items: plan.max_items } : null,
    payments: await q("SELECT id, amount, paid_on, method, reference, note, plan, days_added, created_by, created_at FROM platform_payments WHERE tenant_id = ? ORDER BY id DESC LIMIT 50", [id]),
    activity: await q("SELECT id, admin_name, action, details, created_at FROM platform_activity WHERE tenant_id = ? ORDER BY id DESC LIMIT 20", [id]),
  };
});

api.get("/api/platform/plans", "platform", async () => {
  const plans = await T.getPlans(true);
  const used = await q("SELECT plan, COUNT(*) n FROM platform_tenants GROUP BY plan");
  const u = Object.fromEntries(used.map((r) => [r.plan, Number(r.n)]));
  return { plans: plans.map((p) => ({ ...p, price: Number(p.price), cafes: u[p.code] || 0 })) };
});

api.get("/api/platform/payments", "platform", async (ctx) => {
  const w = [], p = [];
  if (isYmd(ctx.query.from)) { w.push("paid_on >= ?"); p.push(ctx.query.from); }
  if (isYmd(ctx.query.to)) { w.push("paid_on <= ?"); p.push(ctx.query.to); }
  if (ctx.query.tenant_id) { w.push("tenant_id = ?"); p.push(Number(ctx.query.tenant_id)); }
  if (ctx.query.q) { w.push("(tenant_name LIKE ? OR reference LIKE ?)"); const l = `%${String(ctx.query.q).slice(0, 60)}%`; p.push(l, l); }
  const where = w.length ? "WHERE " + w.join(" AND ") : "";
  const rows = await q(`SELECT * FROM platform_payments ${where} ORDER BY paid_on DESC, id DESC LIMIT 500`, p);
  const [s] = await q(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) total FROM platform_payments ${where}`, p);
  return { payments: rows.map((r) => ({ ...r, amount: Number(r.amount), paid_on: ymdOf(r.paid_on) })), summary: { count: Number(s.n), total: Number(s.total) } };
});

api.get("/api/platform/payments.csv", "platform", async (ctx) => {
  const rows = await q("SELECT * FROM platform_payments ORDER BY paid_on DESC, id DESC LIMIT 5000");
  sendCsv(ctx, "payments.csv", ["ID", "Date", "Cafe", "Amount", "Method", "Reference", "Plan", "Days added", "Note", "Recorded by"],
    rows.map((r) => [r.id, ymdOf(r.paid_on), r.tenant_name, r.amount, r.method, r.reference, r.plan, r.days_added, r.note, r.created_by]));
});

api.get("/api/platform/activity", "platform", async (ctx) => {
  const w = [], p = [];
  if (ctx.query.tenant_id) { w.push("tenant_id = ?"); p.push(Number(ctx.query.tenant_id)); }
  if (ctx.query.action) { w.push("action = ?"); p.push(String(ctx.query.action).slice(0, 40)); }
  const rows = await q(`SELECT * FROM platform_activity ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY id DESC LIMIT 200`, p);
  return { activity: rows };
});

api.get("/api/platform/settings", "platform", async () => ({ settings: await T.getPlatformSettings(true) }));

/* ======================= WRITE (owner only) ======================= */
api.put("/api/platform/settings", "platform.write", async (ctx) => {
  const b = ctx.body, s = {};
  if (b.signup_open !== undefined) s.signup_open = !!b.signup_open;
  if (b.approval_required !== undefined) s.approval_required = !!b.approval_required;
  if (b.trial_days !== undefined) { const n = intOrNull(b.trial_days); if (!(n >= 1 && n <= 365)) throw fail(400, "Trial days must be between 1 and 365."); s.trial_days = n; }
  if (b.grace_days !== undefined) { const n = intOrNull(b.grace_days); if (!(n >= 0 && n <= 60)) throw fail(400, "Grace days must be between 0 and 60."); s.grace_days = n; }
  const out = await T.setPlatformSettings(s);
  await log(ctx, "settings", null, JSON.stringify(s));
  return { settings: out, message: "Settings saved." };
});

api.post("/api/platform/tenants", "platform.write", async (ctx) => {
  const v = validOwner(ctx.body);
  const plan = str(ctx.body.plan, 40).toLowerCase() || "free";
  if (!(await T.getPlan(plan))) throw fail(400, "Choose a valid plan.");
  if (ctx.body.subscription_ends_at && !isYmd(ctx.body.subscription_ends_at)) throw fail(400, "Use the date format YYYY-MM-DD.");
  const end = ctx.body.subscription_ends_at || null;
  const t = await T.createTenant({ ...v, trial: false, pending: false, plan, subscriptionEndsAt: end });
  await log(ctx, "create", t, `Created cafe for ${v.email} on plan ${plan}`);
  return { __status: 201, tenant: { id: t.id, slug: t.slug, name: t.name }, message: "Cafe created." };
});

api.patch("/api/platform/tenants/:id", "platform.write", async (ctx) => {
  const id = Number(ctx.params.id), b = ctx.body;
  const t = await one("SELECT * FROM platform_tenants WHERE id = ?", [id]);
  if (!t) throw fail(404, "Cafe not found.");
  if (t.status === "pending" && b.status !== undefined) throw fail(400, "Approve or reject this cafe first.");
  const sets = [], p = [], notes = [];
  if (b.status !== undefined) {
    if (!["active", "suspended"].includes(b.status)) throw fail(400, "Status must be active or suspended.");
    sets.push("status = ?"); p.push(b.status); notes.push(`status ${t.status} -> ${b.status}`);
  }
  if (b.plan !== undefined) {
    const code = str(b.plan, 40).toLowerCase();
    if (!(await T.getPlan(code))) throw fail(400, "Choose a valid plan.");
    sets.push("plan = ?"); p.push(code); notes.push(`plan ${t.plan} -> ${code}`);
  }
  if (b.subscription_ends_at !== undefined) {
    if (b.subscription_ends_at && !isYmd(b.subscription_ends_at)) throw fail(400, "Use the date format YYYY-MM-DD.");
    sets.push("subscription_ends_at = ?"); p.push(b.subscription_ends_at || null); notes.push(`valid till ${b.subscription_ends_at || "no expiry"}`);
  }
  if (b.notes !== undefined) { sets.push("notes = ?"); p.push(str(b.notes, 500) || null); }
  if (b.name !== undefined) { const n = str(b.name, 150); if (n.length < 2) throw fail(400, "Enter a cafe name."); sets.push("name = ?"); p.push(n); }
  if (!sets.length) throw fail(400, "Nothing to update.");
  await q(`UPDATE platform_tenants SET ${sets.join(", ")} WHERE id = ?`, [...p, id]);
  T.clearTenantCache();
  await log(ctx, b.status === "suspended" ? "suspend" : b.status === "active" ? "activate" : "update", t, notes.join("; ") || "Edited details");
  return { message: "Cafe updated." };
});

api.post("/api/platform/tenants/:id/approve", "platform.write", async (ctx) => {
  const t = await T.approveTenant(Number(ctx.params.id));
  await log(ctx, "approve", t, `Approved. Valid till ${ymdOf(t.subscription_ends_at) || "no expiry"}`);
  return { message: "Cafe approved. The owner can sign in now." };
});

api.post("/api/platform/tenants/:id/reject", "platform.write", async (ctx) => {
  const t = await one("SELECT * FROM platform_tenants WHERE id = ?", [Number(ctx.params.id)]);
  if (!t) throw fail(404, "Cafe not found.");
  if (t.status !== "pending") throw fail(400, "Only waiting requests can be rejected.");
  await T.deleteTenant(t.id);
  await log(ctx, "reject", t, `Rejected request from ${t.owner_email}`);
  return { message: "Request rejected." };
});

api.post("/api/platform/tenants/:id/extend", "platform.write", async (ctx) => {
  const t = await one("SELECT * FROM platform_tenants WHERE id = ?", [Number(ctx.params.id)]);
  if (!t) throw fail(404, "Cafe not found.");
  const next = await T.extendSubscription(t.id, ctx.body.days);
  await log(ctx, "extend", t, `+${Math.floor(Number(ctx.body.days))} days, valid till ${next}`);
  return { message: `Extended. Valid till ${next}.`, subscription_ends_at: next };
});

// Record a payment (cash / UPI / bank). Optionally also set the plan and add days in the same step.
api.post("/api/platform/tenants/:id/payments", "platform.write", async (ctx) => {
  const t = await one("SELECT * FROM platform_tenants WHERE id = ?", [Number(ctx.params.id)]);
  if (!t) throw fail(404, "Cafe not found.");
  const b = ctx.body, amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount < 0 || amount > 100000000) throw fail(400, "Enter a valid amount.");
  const method = METHODS.includes(b.method) ? b.method : "cash";
  const paidOn = isYmd(b.paid_on) ? b.paid_on : T.todayYmd();
  const days = intOrNull(b.days) || 0;
  let planCode = null;
  if (b.plan) {
    planCode = str(b.plan, 40).toLowerCase();
    if (!(await T.getPlan(planCode))) throw fail(400, "Choose a valid plan.");
  }
  if (t.status === "pending") throw fail(400, "Approve this cafe before recording a payment.");
  if (planCode) await q("UPDATE platform_tenants SET plan = ? WHERE id = ?", [planCode, t.id]);
  if (days > 0) await T.extendSubscription(t.id, days);
  T.clearTenantCache();
  await q(
    "INSERT INTO platform_payments (tenant_id, tenant_name, amount, paid_on, method, reference, note, plan, days_added, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [t.id, t.name, amount, paidOn, method, str(b.reference, 100) || null, str(b.note, 255) || null, planCode, Math.max(days, 0), ctx.admin.name || ctx.admin.email]
  );
  await log(ctx, "payment", t, `Rs ${amount} by ${method}${planCode ? ", plan " + planCode : ""}${days > 0 ? ", +" + days + " days" : ""}`);
  return { __status: 201, message: "Payment recorded." };
});

api.post("/api/platform/tenants/:id/reset-password", "platform.write", async (ctx) => {
  const id = Number(ctx.params.id), pw = String(ctx.body.password || "");
  if (pw.length < 8) throw fail(400, "Password must be at least 8 characters.");
  const t = await one("SELECT * FROM platform_tenants WHERE id = ?", [id]);
  if (!t) throw fail(404, "Cafe not found.");
  if (t.status === "pending") throw fail(400, "This cafe is still waiting for approval.");
  await T.ensureTenant(id);
  const hash = await bcrypt.hash(pw, 10);
  const n = await runRaw(id, async () => {
    const u = await one("SELECT id FROM bb_users WHERE email = ?", [t.owner_email]);
    if (!u) return 0;
    await q("UPDATE bb_users SET password_hash = ?, is_active = 1 WHERE id = ?", [hash, u.id]);
    return 1;
  });
  if (!n) throw fail(404, "The owner account was not found for this cafe.");
  await log(ctx, "reset_password", t, `Reset password for ${t.owner_email}`);
  return { message: `Password reset for ${t.owner_email}.` };
});

// "Login as cafe": a 2-hour sign-in as the cafe's admin, for support. Always recorded.
api.post("/api/platform/tenants/:id/impersonate", "platform.write", async (ctx) => {
  const id = Number(ctx.params.id);
  const t = await one("SELECT * FROM platform_tenants WHERE id = ?", [id]);
  if (!t) throw fail(404, "Cafe not found.");
  if (t.status !== "active") throw fail(400, "Only active cafes can be opened.");
  await T.ensureTenant(id);
  const out = await runRaw(id, async () => {
    const u = await one("SELECT id, name, email, role FROM bb_users WHERE role = 'admin' AND is_active = 1 ORDER BY (email = ?) DESC, id LIMIT 1", [t.owner_email]);
    if (!u) throw fail(404, "This cafe has no active admin.");
    return { token: signToken(u, { imp: ctx.admin.id }, "2h"), user: u };
  });
  await log(ctx, "impersonate", t, `Opened the cafe as ${out.user.email}`);
  return out;
});

// Download a cafe's data (menu, orders, customers ...) without password hashes
api.get("/api/platform/tenants/:id/export", "platform.write", async (ctx) => {
  const id = Number(ctx.params.id);
  const t = await one("SELECT * FROM platform_tenants WHERE id = ?", [id]);
  if (!t) throw fail(404, "Cafe not found.");
  if (t.status === "pending") throw fail(400, "This cafe has no data yet.");
  await T.ensureTenant(id);
  const data = await runRaw(id, async () => {
    const o = {};
    for (const name of TENANT_TABLES) {
      if (name === "bb_audit") continue;
      const rows = await q(`SELECT * FROM ${name}`);
      o[name] = name === "bb_users" ? rows.map(({ password_hash, ...r }) => r) : rows;
    }
    return o;
  });
  await log(ctx, "export", t, "Downloaded cafe data");
  ctx.res.writeHead(200, { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${t.slug}-data.json"` });
  ctx.res.end(JSON.stringify({ cafe: { name: t.name, slug: t.slug, exported_at: new Date().toISOString() }, data }));
});

api.delete("/api/platform/tenants/:id", "platform.write", async (ctx) => {
  const id = Number(ctx.params.id);
  const t = await one("SELECT * FROM platform_tenants WHERE id = ?", [id]);
  if (!t) throw fail(404, "Cafe not found.");
  if (String(ctx.query.confirm || "") !== t.slug) throw fail(400, `Type the cafe code "${t.slug}" to confirm.`);
  await T.deleteTenant(id);
  await log(ctx, "delete", t, `Deleted cafe ${t.slug} and all its data`);
  return { message: "Cafe and all its data deleted." };
});

/* ----- plans ----- */
function planBody(b, isNew) {
  const out = {};
  if (isNew) {
    out.code = str(b.code, 40).toLowerCase();
    if (!/^[a-z0-9_-]{2,40}$/.test(out.code)) throw fail(400, "Plan code: 2-40 letters, numbers, - or _.");
  }
  const name = str(b.name, 80);
  if (name.length < 2) throw fail(400, "Enter the plan name.");
  out.name = name;
  const price = Number(b.price || 0);
  if (!Number.isFinite(price) || price < 0 || price > 100000000) throw fail(400, "Enter a valid price.");
  out.price = price;
  const days = intOrNull(b.duration_days);
  if (!(days >= 0 && days <= 3650)) throw fail(400, "Days must be between 0 and 3650 (0 = no expiry).");
  out.duration_days = days;
  for (const k of ["max_staff", "max_tables", "max_items"]) {
    const n = intOrNull(b[k]);
    if (n !== null && !(n >= 0 && n <= 100000)) throw fail(400, "Limits must be a number (or empty for unlimited).");
    out[k] = n;
  }
  out.is_active = b.is_active === undefined ? 1 : b.is_active ? 1 : 0;
  return out;
}

api.post("/api/platform/plans", "platform.write", async (ctx) => {
  const v = planBody(ctx.body, true);
  if (await one("SELECT id FROM platform_plans WHERE code = ?", [v.code])) throw fail(409, "A plan with this code already exists.");
  const [{ m }] = await q("SELECT COALESCE(MAX(sort_order),0)+1 m FROM platform_plans");
  await q("INSERT INTO platform_plans (code, name, price, duration_days, max_staff, max_tables, max_items, is_active, sort_order) VALUES (?,?,?,?,?,?,?,?,?)",
    [v.code, v.name, v.price, v.duration_days, v.max_staff, v.max_tables, v.max_items, v.is_active, m]);
  T.clearPlanCache();
  await log(ctx, "plan", null, `Created plan ${v.code}`);
  return { __status: 201, message: "Plan created." };
});

api.put("/api/platform/plans/:id", "platform.write", async (ctx) => {
  const p = await one("SELECT * FROM platform_plans WHERE id = ?", [Number(ctx.params.id)]);
  if (!p) throw fail(404, "Plan not found.");
  const v = planBody(ctx.body, false);
  await q("UPDATE platform_plans SET name=?, price=?, duration_days=?, max_staff=?, max_tables=?, max_items=?, is_active=? WHERE id = ?",
    [v.name, v.price, v.duration_days, v.max_staff, v.max_tables, v.max_items, v.is_active, p.id]);
  T.clearPlanCache();
  await log(ctx, "plan", null, `Edited plan ${p.code}`);
  return { message: "Plan saved." };
});

api.delete("/api/platform/plans/:id", "platform.write", async (ctx) => {
  const p = await one("SELECT * FROM platform_plans WHERE id = ?", [Number(ctx.params.id)]);
  if (!p) throw fail(404, "Plan not found.");
  if (["trial", "free"].includes(p.code)) throw fail(400, "The trial and free plans are needed by the system and cannot be deleted.");
  const [{ n }] = await q("SELECT COUNT(*) n FROM platform_tenants WHERE plan = ?", [p.code]);
  if (n) throw fail(409, `${n} cafe(s) use this plan. Move them to another plan first.`);
  await q("DELETE FROM platform_plans WHERE id = ?", [p.id]);
  T.clearPlanCache();
  await log(ctx, "plan", null, `Deleted plan ${p.code}`);
  return { message: "Plan deleted." };
});

/* ----- team (owner + support accounts) ----- */
api.get("/api/platform/admins", "platform.write", async () => ({
  admins: await q("SELECT id, name, email, role, is_active, created_at FROM platform_admins ORDER BY id"),
}));

api.post("/api/platform/admins", "platform.write", async (ctx) => {
  const name = str(ctx.body.name, 100), email = str(ctx.body.email, 150).toLowerCase(), pw = String(ctx.body.password || "");
  const role = ctx.body.role === "owner" ? "owner" : "support";
  if (name.length < 2) throw fail(400, "Enter a name.");
  if (!emailOk(email)) throw fail(400, "Enter a valid email address.");
  if (pw.length < 8) throw fail(400, "Password must be at least 8 characters.");
  if (await one("SELECT id FROM platform_admins WHERE email = ?", [email])) throw fail(409, "This email already has an account.");
  await q("INSERT INTO platform_admins (name, email, password_hash, role) VALUES (?,?,?,?)", [name, email, await bcrypt.hash(pw, 10), role]);
  await log(ctx, "team", null, `Added ${role} ${email}`);
  return { __status: 201, message: "Team member added." };
});

api.patch("/api/platform/admins/:id", "platform.write", async (ctx) => {
  const id = Number(ctx.params.id), b = ctx.body;
  const a = await one("SELECT * FROM platform_admins WHERE id = ?", [id]);
  if (!a) throw fail(404, "Account not found.");
  const sets = [], p = [];
  if (b.role !== undefined) { if (!["owner", "support"].includes(b.role)) throw fail(400, "Invalid role."); sets.push("role = ?"); p.push(b.role); }
  if (b.is_active !== undefined) { sets.push("is_active = ?"); p.push(b.is_active ? 1 : 0); }
  if (b.name !== undefined) { const n = str(b.name, 100); if (n.length < 2) throw fail(400, "Enter a name."); sets.push("name = ?"); p.push(n); }
  if (b.password) { if (String(b.password).length < 8) throw fail(400, "Password must be at least 8 characters."); sets.push("password_hash = ?"); p.push(await bcrypt.hash(String(b.password), 10)); }
  if (!sets.length) throw fail(400, "Nothing to update.");
  const losesOwner = (b.role !== undefined && b.role !== "owner") || (b.is_active !== undefined && !b.is_active);
  if (a.role === "owner" && losesOwner) {
    if (a.id === ctx.admin.id) throw fail(400, "You cannot remove your own owner access.");
    const [{ n }] = await q("SELECT COUNT(*) n FROM platform_admins WHERE role = 'owner' AND is_active = 1 AND id <> ?", [a.id]);
    if (!n) throw fail(400, "At least one active owner is required.");
  }
  await q(`UPDATE platform_admins SET ${sets.join(", ")} WHERE id = ?`, [...p, id]);
  await log(ctx, "team", null, `Updated ${a.email}`);
  return { message: "Saved." };
});
