const mysql = require("mysql2/promise");
const path = require("path");
const dotenv = require("dotenv");

// Run everything in Indian time (server hosts are usually UTC, which showed times 5h30m behind).
process.env.TZ = process.env.APP_TZ || "Asia/Kolkata";
const DB_TZ = process.env.DB_TZ || "+05:30";

// Load environment variables from backend-node/.env
dotenv.config({
  path: path.resolve(__dirname, "../.env"),
  quiet: true,
});

const rawPool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "chai_order_system",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  decimalNumbers: true,
  dateStrings: true,
  timezone: DB_TZ,
});

// Make NOW(), CURDATE() and TIMESTAMP columns use the same timezone on every connection.
rawPool.pool.on("connection", (conn) => {
  conn.query("SET time_zone = '" + DB_TZ + "'");
});

// Every query goes through the cafe (tenant) layer: plain table names are rewritten to the
// current cafe's own tables (see lib/tenantSql.js).
const { als, rewrite } = require("../lib/tenantSql");
const prep = (sql) => {
  const store = als.getStore();
  const tid = store ? store.tid : null;
  if (sql && typeof sql === "object" && sql.sql) return { ...sql, sql: rewrite(sql.sql, tid) };
  return rewrite(sql, tid);
};

const pool = {
  query: (sql, params) => rawPool.query(prep(sql), params),
  async getConnection() {
    const c = await rawPool.getConnection();
    const original = c.query.bind(c);
    c.query = (sql, params) => original(prep(sql), params);
    return c;
  },
};

module.exports = pool;