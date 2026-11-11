"use strict";

// Permission keys a role can have (shared by core.js and migrate.js).
const PERMISSIONS = [
  ["waiter", "Waiter mobile app (take orders, send KOT)"],
  ["pos", "POS / Billing"],
  ["orders", "View orders"],
  ["orders.cancel", "Cancel orders / refunds"],
  ["tables", "View tables"],
  ["tables.manage", "Manage tables"],
  ["menu", "View menu items"],
  ["menu.manage", "Manage menu items & categories"],
  ["customers", "View customers"],
  ["customers.manage", "Add / edit customers"],
  ["reports", "Reports & dashboard"],
  ["expenses", "Expenses"],
  ["taxes", "Taxes / GST"],
  ["staff", "Staff & roles"],
  ["audit", "Audit logs"],
  ["notifications", "Notifications"],
  ["settings", "Settings"],
  ["discount", "Apply discounts"],
  ["backup", "Backup & restore"]
];

module.exports = { PERMISSIONS };
