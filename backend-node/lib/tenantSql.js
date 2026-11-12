"use strict";

// Multi-cafe isolation layer.
// Every cafe (tenant) gets its OWN set of tables inside the same database:
//   t1_bb_users, t1_products ...   (cafe 1)
//   t2_bb_users, t2_products ...   (cafe 2)
// Code keeps writing plain table names ("bb_users"); this file rewrites them to the
// current cafe's tables. A query that touches cafe tables without a cafe selected is
// REFUSED, so data can never leak from one cafe to another by mistake.

const { AsyncLocalStorage } = require("async_hooks");
const crypto = require("crypto");

const als = new AsyncLocalStorage();

// Tables that exist separately for every cafe. (bb_files and platform_* are shared.)
const TENANT_TABLES = [
  "categories", "products", "bb_roles", "bb_users", "bb_settings", "bb_tax_rates",
  "bb_tables", "bb_customers", "bb_loyalty_tx", "bb_sequences", "bb_orders",
  "bb_order_items", "bb_payments", "bb_expense_categories", "bb_expenses",
  "bb_notifications", "bb_audit", "bb_backups", "bb_online_orders", "bb_kots",
];

const RE = new RegExp("(?<![\\w$])(" + TENANT_TABLES.join("|") + ")(?![\\w$])", "g");

const prefix = (tid) => `t${Number(tid)}_`;
const currentStore = () => als.getStore() || null;
const currentTenantId = () => {
  const s = als.getStore();
  return s ? s.tid : null;
};

function rewrite(sql, tid) {
  const text = String(sql);
  if (tid == null) {
    if (text.search(RE) !== -1) {
      throw new Error("NO_TENANT: a cafe-data query ran without a selected cafe.");
    }
    return text;
  }
  const p = prefix(tid);
  return text.replace(RE, (_, t) => p + t);
}

// Table name for places where SQL text is not used (e.g. information_schema lookups).
const tableName = (name, tid = currentTenantId()) => prefix(tid) + name;

// QR token looks like a UUID (the website expects 36 chars of a-f, 0-9 and dashes).
// The first 8 characters hold the cafe id, the rest is random.
function newQrToken(tid = currentTenantId()) {
  if (tid == null) throw new Error("NO_TENANT: cannot create a QR token.");
  const h = crypto.randomBytes(12).toString("hex");
  const t = Number(tid).toString(16).padStart(8, "0");
  return `${t}-${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}-${h.slice(12)}`;
}

function tidFromQrToken(token) {
  const m = /^([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(String(token || ""));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return n > 0 ? n : null;
}

module.exports = {
  als, TENANT_TABLES, prefix, currentStore, currentTenantId, rewrite, tableName, newQrToken, tidFromQrToken,
};
