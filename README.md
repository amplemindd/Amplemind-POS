# Chai Order System (multi-cafe)

One website, one database, many cafes / restaurants. Every cafe has its own owner login,
staff (manager / waiter / cashier), menu, tables, QR codes, orders and reports.
Their data is completely separate.

## The three kinds of users
| Who | Where they sign in | What they see |
|---|---|---|
| **Website owner (you)** | `/platform` | all cafes, plans, payments, activity, settings |
| **Support team** (optional) | `/platform` | the same pages, view only |
| **Cafe owner (admin)** | `/signup` once, then `/` | only their own cafe |
| **Staff** (waiter, manager, cashier) | `/` (waiters: waiter app, mobile number) | only the cafe they belong to |

Customers scan a table QR code and only that cafe's menu opens.

## Owner panel (`/platform`)
Dashboard (cafes, sales across cafes, sign-up and revenue charts), cafe list with filters and CSV export,
cafe drawer (sales, staff, limits, notes, extend +30/+90/+365 days, suspend, "open as cafe admin", reset password,
download data, delete), plans, payments you record by hand, activity log, team accounts, and settings.

## Free trial and subscription rules
- New sign-ups get the **Free Trial** plan (14 days, starts when you approve). Trial limits: 3 staff, 12 tables, 40 menu items.
- One trial per email (Gmail dots and +tags are ignored), per mobile number and per GST number. Deleting a cafe does not give the email another trial.
- With **Approve new cafes first** on, a cafe waits in "Pending" and nothing is created until you approve it.
- After `subscription_ends_at` the cafe has a few **grace days**, then becomes **view only** (can sign in and read, cannot change or take orders) until you extend it.
- Plans (price, days, limits) are yours to edit. The seeded Basic / Standard / Premium prices are only placeholders.

## How the data is separated
Each cafe gets its own tables inside the same database (`t1_bb_orders`, `t2_bb_orders`, ...).
Code uses normal table names and `backend-node/lib/tenantSql.js` maps them to the current cafe.
A query that runs without a selected cafe is refused, so one cafe can never read another cafe's data.
Shared tables: `platform_tenants`, `platform_plans`, `platform_payments`, `platform_activity`, `platform_settings`,
`platform_trials`, `platform_admins`, `platform_logins` (email / waiter mobile -> cafe) and `bb_files` (uploaded images).

## Local run
1. `npm install`
2. Copy `backend-node/.env.example` to `backend-node/.env` and fill values
3. `npm start` -> http://localhost:5000  (owner panel: /platform, cafe sign-up: /signup)

## Notes
- An email address (and a waiter's mobile number) can belong to only one account in the whole system.
- Online-order webhook URL per cafe: `/api/online/webhook/<cafe-code>/<swiggy|zomato>`.
- Rebuild the React app only if you change `frontend/src`: `cd frontend && npm install && npm run build`, then commit `frontend/build`.
