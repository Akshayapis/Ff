# Host Zone – Compete • Win • Repeat

Real-money Free Fire tournament app.

| Part | Location |
|---|---|
| User app (single file) | `public/index.html` → served at `/` and `/index.html` |
| Admin panel (single file) | `public/admin.html` → served at `/admin` and `/admin.html` |
| Backend (Node.js, REST `/api`) | `src/server/*` exposed through `src/app/api/[[...path]]/route.ts` |
| Database schema (PostgreSQL / Drizzle) | `src/db/schema.ts` |

> **Why not `server.js` + Express + SQLite?** This project runs on Next.js + PostgreSQL, so the backend is implemented
> as Node route handlers on the same server (`npm start`). It provides everything requested: JWT auth (separate admin
> secret), bcrypt, security headers, rate limiting, validation, DB transactions with row locks for every wallet change,
> and an immutable ledger (a DB trigger rejects UPDATE/DELETE on `wallet_txns`). API keys never reach the browser.

## Environment variables
See `.env.example`.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (required) |
| `JWT_SECRET` | Token signing secret (auto-generated + stored if omitted) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | First admin account (created only if no admin exists) – **change after first login** (Admin → Change password) |
| `PUBLIC_URL` | Public https URL (payment redirect + webhook). Also editable in Admin → Settings |
| `OTP_API_KEY`, `PAY_USERNAME`, `PAY_KEY` (+ `*_BASE`) | Optional fallbacks – normally set in Admin → Settings |

## Run locally
```bash
npm install
cp .env.example .env        # edit DATABASE_URL etc.
npx drizzle-kit push        # create tables
npm run build && npm start  # http://localhost:3000   (admin: /admin)
```
Default first admin: `admin` / `ChangeMe@123` (unless `ADMIN_USERNAME` / `ADMIN_PASSWORD` set).

## Deploy on Render
1. Create a **PostgreSQL** instance on Render and copy its *Internal Database URL*.
2. Create a **Web Service** from your repo:
   - Build command: `npm install && npx drizzle-kit push --force && npm run build`
   - Start command: `npm start`
   - Environment: `DATABASE_URL`, `JWT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `PUBLIC_URL=https://<your-service>.onrender.com`
   - Health check path: `/api/health`
3. Open `https://<your-service>.onrender.com/admin`, login, **change the admin password**.
4. Admin → **Settings**: enter the OTP API key, payment username + key (stored server-side, shown masked afterwards), GST %, limits, support links, logo.
5. Create Games → Matches, add Banners. The app shows proper empty states until you do.

### Set API keys from admin
Admin → Settings → *OTP API* (base URL `https://otp-lio.onrender.com` + key) and *Payment API* (base URL
`https://v3payamunt.vercel.app/api/v1`, username, key). The page also shows the webhook URL
(`<site>/api/payment/webhook`) and redirect URL (`<site>/index.html#wallet`).

### Adjusting provider response formats (one place each)
- OTP success detection: `isProviderSuccess()` in `src/server/otp.ts`
- Payment status / link parsing: `parseCheckOrder()`, `extractPayLink()` in `src/server/payment.ts`
  (wallet is credited only when `utr_verified === true` or `utr_status === "verified"` from a server-to-server `check-order`;
  webhooks are never trusted – they only trigger a re-check; a background poller re-checks pending orders every 30 s).

## Money rules (server-side)
- Entry fee is taken from Deposit balance first, then Winning balance. Only **Winning balance** is withdrawable.
- Win prize split = `win_prize ÷ ticked winners` (rounded **down** to 2 decimals) + `kills × per-kill`; result can be submitted once.
- Cancel match / remove player → entry fee refunded to the same balance(s) it came from.
- Withdrawal: GST % (admin) deducted; rejected withdrawals are refunded automatically to Winning balance.
- Referral bonuses are credited to the Deposit balance.

## Manual test checklist
1. **Register + OTP** – Settings: save OTP key → open app → Register (with `?ref=CODE`) → SEND OTP → enter OTP → account created only after verify; resend is blocked for 60 s; wrong OTP shows attempts left; wrong 5× requires a new OTP.
2. **Forgot password** – Login → Forgot password → mobile → OTP → new password → login with new password (old sessions are logged out).
3. **Deposit** – Wallet → Add Money → ₹100 chip → pay via the opened link → sheet shows pending / UTR status → wallet credited exactly once after verification (try pressing *Check status* repeatedly; Admin → Deposits shows order, UTR, status; try manual Approve/Reject).
4. **Join match** – Admin: add game + match (entry fee) → user: game → JOIN NOW → UID/name → fee deducted; second join blocked; JOINED/FULL states; low balance shows *Add Money*.
5. **Room ID copy** – Admin → Matches → Room → set ID/password, tick *Release* → joined user sees both with COPY buttons; non-joined users see nothing.
6. **Result with 1 / 2 / 4 winners** – Admin → Matches → Result: win prize ₹100 → tick 1 (₹100), 2 (₹50 each), 4 (₹25 each); preview updates live; Submit once → winners' Winning balance credited, ledger shows `MATCH ID`, match Completed; second submit is rejected. Also try per-kill and combined prizes. Cancel another match → all fees refunded.
7. **Withdrawal with GST** – Settings: GST 18% → user Withdraw (UPI or Bank) → summary shows GST + final payable *before* submit → Admin → Withdrawals: Approve → Mark paid (reference) or Reject (auto refund) → export CSV.
8. **Referral** – Admin → Referrals: set bonuses → new user registers with code → referrer's My Referrals shows status / earnings; deposit % bonus follows first/every setting; self/duplicate-device referrals are ignored.
9. **Leaderboard** – after results, Leaderboard shows top 10 (Daily / Weekly / All-time, #1 crown); Admin → Leaderboard → *Reset daily* clears only the daily board.
10. **Extras** – block a user (logged out with a message), maintenance mode, banners carousel, announcements push, audit log, OTP log, ledger log.
