/**
 * Host Zone – server core.
 * DB helpers, one-time init (ledger immutability, constraints, seeds), JWT auth,
 * rate limiting, settings store, validation helpers, audit log.
 */
import { pool } from "@/db";
import type { PoolClient } from "pg";
import { types } from "pg";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";

// numeric -> JS number, bigint (count) -> JS number. Money arithmetic is done in SQL / integer paise.
types.setTypeParser(1700, (v: string) => parseFloat(v));
types.setTypeParser(20, (v: string) => parseInt(v, 10));

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const bad = (message: string, status = 400, code?: string) => new ApiError(status, message, code);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

export async function q(text: string, params: unknown[] = [], c?: PoolClient): Promise<Row[]> {
  const r = await (c ?? pool).query(text, params as never[]);
  return r.rows as Row[];
}
export async function one(text: string, params: unknown[] = [], c?: PoolClient): Promise<Row | null> {
  const rows = await q(text, params, c);
  return rows[0] ?? null;
}

/** Run fn inside a DB transaction (commit on success, rollback on any error). */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/* ------------------------------------------------------------------ settings */
const DEFAULTS: Record<string, string> = {
  app_name: "Host Zone",
  app_tagline: "Compete • Win • Repeat",
  app_logo: "",
  otp_base: "https://otp-lio.onrender.com",
  otp_key: "",
  pay_base: "https://v3payamunt.vercel.app/api/v1",
  pay_username: "",
  pay_key: "",
  site_url: "",
  gst_percent: "0",
  min_deposit: "10",
  max_deposit: "10000",
  min_withdraw: "50",
  max_withdraw: "10000",
  withdraw_enabled: "1",
  support_whatsapp: "",
  support_telegram: "",
  support_email: "",
  dev_link: "",
  maintenance: "0",
  ref_signup_referrer: "0",
  ref_signup_referred: "0",
  ref_percent: "0",
  ref_percent_mode: "first",
  ref_min_deposit: "0",
  ref_max_cap: "0",
  lb_daily_reset_at: "",
};
export const SECRET_KEYS = ["otp_key", "pay_key"];
const ENV_FALLBACK: Record<string, string> = {
  otp_key: "OTP_API_KEY",
  otp_base: "OTP_API_BASE",
  pay_key: "PAY_KEY",
  pay_username: "PAY_USERNAME",
  pay_base: "PAY_API_BASE",
  site_url: "PUBLIC_URL",
};
export const SETTING_KEYS = Object.keys(DEFAULTS);

let settingsCache: { at: number; v: Record<string, string> } | null = null;
export async function getSettings(): Promise<Record<string, string>> {
  if (settingsCache && Date.now() - settingsCache.at < 3000) return settingsCache.v;
  const rows = await q("SELECT key, value FROM settings");
  const v: Record<string, string> = { ...DEFAULTS };
  for (const r of rows) v[r.key] = r.value;
  for (const [k, env] of Object.entries(ENV_FALLBACK)) if (!v[k] && process.env[env]) v[k] = process.env[env] as string;
  settingsCache = { at: Date.now(), v };
  return v;
}
export async function setSettings(obj: Record<string, string>, c?: PoolClient) {
  for (const [k, v] of Object.entries(obj)) {
    if (!(k in DEFAULTS)) continue;
    await q(
      "INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
      [k, String(v)],
      c
    );
  }
  settingsCache = null;
}
export const sNum = (s: Record<string, string>, k: string) => {
  const n = parseFloat(s[k]);
  return Number.isFinite(n) ? n : 0;
};

/* ------------------------------------------------------------------ init */
let jwtSecret = "";
let initP: Promise<void> | null = null;
export function init(): Promise<void> {
  if (!initP) {
    initP = doInit().catch((e) => {
      initP = null;
      throw e;
    });
  }
  return initP;
}

async function doInit() {
  const c = await pool.connect();
  try {
    await c.query("SELECT pg_advisory_lock(727001)");
    // immutable ledger: any UPDATE / DELETE on wallet_txns is rejected
    await c.query(`CREATE OR REPLACE FUNCTION wtx_immutable() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'wallet ledger is immutable'; END; $$ LANGUAGE plpgsql`);
    await c.query("DROP TRIGGER IF EXISTS wtx_no_change ON wallet_txns");
    await c.query(
      "CREATE TRIGGER wtx_no_change BEFORE UPDATE OR DELETE ON wallet_txns FOR EACH ROW EXECUTE FUNCTION wtx_immutable()"
    );
    await c.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='users_bal_nonneg') THEN
        ALTER TABLE users ADD CONSTRAINT users_bal_nonneg CHECK (deposit_balance >= 0 AND winning_balance >= 0);
      END IF; END $$;`);
    // idempotency guards: a deposit order and a match win can be credited only once
    await c.query("CREATE UNIQUE INDEX IF NOT EXISTS wtx_deposit_once ON wallet_txns(ref) WHERE type='deposit'");
    await c.query("CREATE UNIQUE INDEX IF NOT EXISTS wtx_win_once ON wallet_txns(user_id, match_id) WHERE type='win'");
    for (const [k, v] of Object.entries(DEFAULTS)) {
      await c.query("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO NOTHING", [k, v]);
    }
    if (process.env.JWT_SECRET) jwtSecret = process.env.JWT_SECRET;
    else {
      const r = await c.query("SELECT value FROM settings WHERE key='jwt_secret'");
      if (r.rows[0]?.value) jwtSecret = r.rows[0].value;
      else {
        jwtSecret = crypto.randomBytes(48).toString("hex");
        await c.query("INSERT INTO settings(key,value) VALUES('jwt_secret',$1) ON CONFLICT (key) DO NOTHING", [jwtSecret]);
        const r2 = await c.query("SELECT value FROM settings WHERE key='jwt_secret'");
        jwtSecret = r2.rows[0].value;
      }
    }
    const a = await c.query("SELECT count(*)::int AS n FROM admins");
    if (a.rows[0].n === 0) {
      const un = (process.env.ADMIN_USERNAME || "admin").toLowerCase();
      const pw = process.env.ADMIN_PASSWORD || "ChangeMe@123";
      await c.query("INSERT INTO admins(username,password_hash) VALUES($1,$2)", [un, await bcrypt.hash(pw, 11)]);
    }
  } finally {
    await c.query("SELECT pg_advisory_unlock(727001)").catch(() => {});
    c.release();
  }
}

/* ------------------------------------------------------------------ auth */
export const hashPw = (p: string) => bcrypt.hash(p, 11);
export const checkPw = (p: string, h: string) => bcrypt.compare(p, h);

export const signUser = (u: Row) => jwt.sign({ sub: u.id, tv: u.token_version, role: "user" }, jwtSecret, { expiresIn: "30d" });
export const signAdmin = (a: Row) =>
  jwt.sign({ sub: a.id, tv: a.token_version, role: "admin" }, jwtSecret + ":admin", { expiresIn: "12h" });
export const signPurpose = (payload: object, purpose: string, expiresIn: string) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  jwt.sign({ ...payload, purpose }, jwtSecret + ":p", { expiresIn } as any);
export function verifyPurpose(token: string, purpose: string): Row {
  try {
    const d = jwt.verify(token, jwtSecret + ":p") as Row;
    if (d.purpose !== purpose) throw new Error("x");
    return d;
  } catch {
    throw bad("Session expired. Please start again.", 401);
  }
}

function bearer(req: Request) {
  const h = req.headers.get("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

export async function authUser(req: Request): Promise<Row> {
  const t = bearer(req);
  if (!t) throw bad("Please login", 401);
  let d: Row;
  try {
    d = jwt.verify(t, jwtSecret) as Row;
  } catch {
    throw bad("Session expired. Please login again.", 401);
  }
  if (d.role !== "user") throw bad("Please login", 401);
  const u = await one("SELECT * FROM users WHERE id=$1", [d.sub]);
  if (!u || u.token_version !== d.tv) throw bad("Session expired. Please login again.", 401);
  if (u.banned) throw bad(u.ban_reason ? `Your account is blocked: ${u.ban_reason}` : "Your account is blocked. Contact support.", 403, "BANNED");
  q("UPDATE users SET last_active_at=now() WHERE id=$1 AND last_active_at < now() - interval '1 minute'", [u.id]).catch(() => {});
  return u;
}

export async function authAdmin(req: Request): Promise<Row> {
  const t = bearer(req);
  if (!t) throw bad("Admin login required", 401);
  let d: Row;
  try {
    d = jwt.verify(t, jwtSecret + ":admin") as Row;
  } catch {
    throw bad("Admin session expired. Please login again.", 401);
  }
  if (d.role !== "admin") throw bad("Admin login required", 401);
  const a = await one("SELECT * FROM admins WHERE id=$1", [d.sub]);
  if (!a || a.token_version !== d.tv) throw bad("Admin session expired. Please login again.", 401);
  return a;
}

/* ------------------------------------------------------------------ rate limit */
const hits = new Map<string, { n: number; reset: number }>();
export function limit(key: string, max: number, windowMs: number, msg = "Too many requests. Please try again later.") {
  const now = Date.now();
  if (hits.size > 8000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  const h = hits.get(key);
  if (!h || h.reset < now) {
    hits.set(key, { n: 1, reset: now + windowMs });
    return;
  }
  h.n++;
  if (h.n > max) throw bad(msg, 429);
}
export function clientIp(req: Request) {
  const f = req.headers.get("x-forwarded-for");
  return (f ? f.split(",")[0].trim() : req.headers.get("x-real-ip") || "unknown").slice(0, 60);
}

/* ------------------------------------------------------------------ validation */
/** Trim, strip control chars and angle brackets (XSS hardening; clients also escape on render). */
export function clean(v: unknown, max = 200): string {
  // eslint-disable-next-line no-control-regex
  return String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, max);
}
export function reqStr(v: unknown, name: string, min = 1, max = 200): string {
  const s = clean(v, max + 1);
  if (s.length < min) throw bad(`${name} is required${min > 1 ? ` (min ${min} characters)` : ""}`);
  if (s.length > max) throw bad(`${name} is too long (max ${max} characters)`);
  return s;
}
export function amt(v: unknown, name = "Amount", allowZero = true): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").trim());
  if (!Number.isFinite(n) || n < 0) throw bad(`${name} is invalid`);
  const r = Math.round(n * 100) / 100;
  if (r > 10000000) throw bad(`${name} is too large`);
  if (!allowZero && r <= 0) throw bad(`${name} must be greater than 0`);
  return r;
}
export function int(v: unknown, name: string, min = 0, max = 1000000): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} is invalid`);
  return n;
}
export function mobile(v: unknown): string {
  const s = String(v ?? "").replace(/\D/g, "").replace(/^(91|0)(?=\d{10}$)/, "");
  if (!/^[6-9]\d{9}$/.test(s)) throw bad("Enter a valid 10-digit mobile number");
  return s;
}
export function password(v: unknown): string {
  const s = String(v ?? "");
  if (s.length < 6) throw bad("Password must be at least 6 characters");
  if (s.length > 64) throw bad("Password is too long");
  return s;
}
export const paise = (n: number) => Math.round(n * 100);
export const rupees = (p: number) => p / 100;
export const maskMobile = (m: string) => (m && m.length >= 10 ? m.slice(0, 2) + "******" + m.slice(-2) : m);
export const maskUid = (u: string) => (u.length <= 4 ? "****" : "*".repeat(u.length - 4) + u.slice(-4));

export async function audit(admin: string, action: string, details = "", c?: PoolClient) {
  await q("INSERT INTO audit_logs(admin,action,details) VALUES($1,$2,$3)", [admin, action, details.slice(0, 1000)], c);
}

export async function notify(userId: number, title: string, body: string, c?: PoolClient) {
  await q("INSERT INTO notifications(user_id,title,body) VALUES($1,$2,$3)", [userId, title, body], c);
}

export function imgUrl(id: number | null | undefined) {
  return id ? `/api/img/${id}` : "";
}

/** Store a (client-compressed) data URL image. Returns image id. */
export async function saveImage(dataUrl: unknown, maxBytes = 600 * 1024): Promise<number> {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) throw bad("Invalid image. Use JPG, PNG or WEBP.");
  const size = Math.floor((m[2].length * 3) / 4);
  if (size > maxBytes) throw bad(`Image too large (max ${Math.round(maxBytes / 1024)} KB after compression)`);
  const r = await one("INSERT INTO images(mime,data) VALUES($1,$2) RETURNING id", [m[1], m[2]]);
  return r!.id;
}

export function randCode(len = 8) {
  const al = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = crypto.randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += al[b[i] % al.length];
  return s;
}

/** Move upcoming matches whose start time has passed to ongoing. */
export async function autoProgress() {
  await q("UPDATE matches SET status='ongoing' WHERE status='upcoming' AND start_at <= now()");
}

/** Public base URL of this site (for payment redirect + webhook). */
export async function siteUrl(req?: Request): Promise<string> {
  const s = await getSettings();
  if (s.site_url) return s.site_url.replace(/\/+$/, "");
  if (req) {
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
    const proto = req.headers.get("x-forwarded-proto") || (host?.startsWith("localhost") ? "http" : "https");
    if (host) return `${proto}://${host}`;
  }
  return "";
}
