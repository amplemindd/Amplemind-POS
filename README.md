# Chai Order System (multi-cafe)

One website, one database, many cafes / restaurants. Every cafe has its own owner login,
staff (manager / waiter / cashier), menu, tables, QR codes, orders and reports.
Their data is completely separate.

## The three kinds of users
| Who | Where they sign in | What they see |
|---|---|---|
| **Website owner (you)** | `/platform` | all cafes, status, plan, subscription date, create/suspend/delete |
| **Cafe owner (admin)** | `/signup` once, then `/` | only their own cafe |
| **Staff** (waiter, manager, cashier) | `/` (waiters: waiter app, mobile number) | only the cafe they belong to |

Customers scan a table QR code and only that cafe's menu opens.

## How the data is separated
Each cafe gets its own tables inside the same database (`t1_bb_orders`, `t2_bb_orders`, ...).
Code uses normal table names and `backend-node/lib/tenantSql.js` maps them to the current cafe.
A query that runs without a selected cafe is refused, so one cafe can never read another cafe's data.
Shared tables: `platform_tenants` (cafes), `platform_admins` (website owners),
`platform_logins` (email / waiter mobile -> cafe), `bb_files` (uploaded images).

## Subscriptions (add your own rules later)
`platform_tenants` already has `status` (active / suspended), `plan` and `subscription_ends_at`.
Access is blocked automatically after `subscription_ends_at`. Leave the date empty for no expiry.
Change them from `/platform`, or plug your payment system into `PATCH /api/platform/tenants/:id`.

## Local run
1. `npm install`
2. Copy `backend-node/.env.example` to `backend-node/.env` and fill values
3. `npm start` -> http://localhost:5000  (owner panel: /platform, cafe sign-up: /signup)

## Notes
- An email address (and a waiter's mobile number) can belong to only one account in the whole system.
- Online-order webhook URL per cafe: `/api/online/webhook/<cafe-code>/<swiggy|zomato>`.
- Rebuild the React app only if you change `frontend/src`: `cd frontend && npm install && npm run build`, then commit `frontend/build`.
