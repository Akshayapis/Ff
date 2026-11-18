/**
 * OTP (SMS) integration – https://otp-lio.onrender.com
 *  POST /api/sms/send-otp   {apiKey, number}
 *  POST /api/sms/verify-otp {apiKey, number, otp}
 * The API key is read from admin settings (or OTP_API_KEY env) and NEVER leaves the server.
 */
import { bad, getSettings, one, q, limit } from "./core";

const COOLDOWN_MS = 60_000; // resend cooldown
const EXPIRY_MS = 10 * 60_000; // OTP validity window
const MAX_SENDS_PER_HOUR = 5; // resend limit per number+purpose
const MAX_ATTEMPTS = 5; // wrong verify attempts per OTP

interface ProviderRes {
  ok: boolean;
  status: number;
  json: Record<string, unknown> | null;
  text: string;
}

/**
 * ===== SUCCESS DETECTION (single place to adjust) =====
 * Success only when HTTP is 2xx, no explicit failure flag, and the provider clearly says success:
 * an explicit positive flag (success/status/type/verified/valid === true|"success"|"ok"|...) OR a positive message
 * without any negative words. Unknown formats => treated as FAILURE (and the raw response is logged).
 */
export function isProviderSuccess(res: ProviderRes, kind: "send" | "verify"): boolean {
  if (!res.ok) return false;
  const j = res.json;
  const txt = (res.text || "").toLowerCase();
  const NEG = /(invalid|fail|wrong|incorrect|expired|error|not\s*(found|valid|verified|sent)|denied|unauthor|limit|blocked)/;
  if (j) {
    const flags = [j.success, j.ok, j.status, j.type, j.result, j.verified, j.valid, j.sent, j.return];
    const isFalse = (v: unknown) => v === false || (typeof v === "string" && /^(false|fail(ed)?|error|invalid|0)$/i.test(v.trim()));
    const isTrue = (v: unknown) => v === true || (typeof v === "string" && /^(true|success|ok|sent|verified|valid|approved|1)$/i.test(v.trim()));
    if (flags.some((f) => f !== undefined && isFalse(f))) return false;
    if (j.error) return false;
    if (kind === "verify" && (j.verified !== undefined || j.valid !== undefined)) {
      return isTrue(j.verified) || isTrue(j.valid);
    }
    if (flags.some((f) => f !== undefined && isTrue(f))) return true;
    const msg = String(j.message ?? j.msg ?? "").toLowerCase();
    if (msg && !NEG.test(msg) && /(success|sent|verified|valid)/.test(msg)) return true;
    return false;
  }
  return !NEG.test(txt) && (kind === "send" ? /(success|sent)/.test(txt) : /(success|verified|valid)/.test(txt));
}

async function callProvider(path: string, body: Record<string, string>): Promise<ProviderRes> {
  const s = await getSettings();
  if (!s.otp_key || !s.otp_base) throw bad("OTP service is not configured. Please contact support.", 503);
  const url = s.otp_base.replace(/\/+$/, "") + path;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: s.otp_key, ...body }),
      signal: AbortSignal.timeout(20000),
    });
    const text = await r.text();
    let json: Record<string, unknown> | null = null;
    try {
      const p = JSON.parse(text);
      if (p && typeof p === "object" && !Array.isArray(p)) json = p;
    } catch {
      /* non-JSON response */
    }
    return { ok: r.ok, status: r.status, json, text };
  } catch {
    throw bad("Could not reach the OTP service. Please try again.", 502);
  }
}

async function log(mobile: string, purpose: string, action: string, success: boolean, ip: string, raw: string) {
  await q("INSERT INTO otp_logs(mobile,purpose,action,success,ip,raw) VALUES($1,$2,$3,$4,$5,$6)", [mobile, purpose, action, success, ip, raw.slice(0, 600)]);
}

export async function sendOtp(mobile: string, purpose: "register" | "reset", ip: string) {
  limit(`otp-ip:${ip}`, 10, 10 * 60_000, "Too many OTP requests from your network. Try again later.");
  limit(`otp-mob:${mobile}`, 8, 60 * 60_000, "Too many OTP requests for this number. Try again later.");
  // reserve the send slot atomically (cooldown + hourly limit) before calling the provider
  await q(
    "INSERT INTO otp_sessions(mobile,purpose) VALUES($1,$2) ON CONFLICT (mobile,purpose) DO NOTHING",
    [mobile, purpose]
  );
  const claimed = await one(
    `UPDATE otp_sessions SET
        send_count = CASE WHEN window_start < now() - interval '1 hour' THEN 1 ELSE send_count + 1 END,
        window_start = CASE WHEN window_start < now() - interval '1 hour' THEN now() ELSE window_start END,
        last_sent_at = now()
      WHERE mobile=$1 AND purpose=$2
        AND (last_sent_at IS NULL OR last_sent_at < now() - make_interval(secs => $3::float8))
        AND (window_start < now() - interval '1 hour' OR send_count < $4)
      RETURNING id`,
    [mobile, purpose, COOLDOWN_MS / 1000, MAX_SENDS_PER_HOUR]
  );
  if (!claimed) {
    const s = await one("SELECT last_sent_at, send_count, window_start FROM otp_sessions WHERE mobile=$1 AND purpose=$2", [mobile, purpose]);
    if (s && s.send_count >= MAX_SENDS_PER_HOUR && new Date(s.window_start).getTime() > Date.now() - 3600_000)
      throw bad("Resend limit reached. Please try again after an hour.", 429);
    const wait = s?.last_sent_at ? Math.max(1, Math.ceil((COOLDOWN_MS - (Date.now() - new Date(s.last_sent_at).getTime())) / 1000)) : 60;
    throw bad(`Please wait ${wait}s before requesting another OTP`, 429);
  }
  let res: ProviderRes;
  try {
    res = await callProvider("/api/sms/send-otp", { number: mobile });
  } catch (e) {
    await q("UPDATE otp_sessions SET last_sent_at=NULL, send_count=GREATEST(send_count-1,0) WHERE mobile=$1 AND purpose=$2", [mobile, purpose]);
    await log(mobile, purpose, "send", false, ip, "provider unreachable / not configured");
    throw e;
  }
  const success = isProviderSuccess(res, "send");
  await log(mobile, purpose, "send", success, ip, `HTTP ${res.status} ${res.text}`);
  if (!success) {
    // release the cooldown so the user can retry immediately after a provider-side failure
    await q("UPDATE otp_sessions SET last_sent_at=NULL, send_count=GREATEST(send_count-1,0) WHERE mobile=$1 AND purpose=$2", [mobile, purpose]);
    throw bad("Could not send OTP. Please check the number and try again.", 502);
  }
  await q(
    "UPDATE otp_sessions SET expires_at = now() + make_interval(secs => $3::float8), attempts=0 WHERE mobile=$1 AND purpose=$2",
    [mobile, purpose, EXPIRY_MS / 1000]
  );
  return { cooldown: COOLDOWN_MS / 1000, expiresIn: EXPIRY_MS / 1000 };
}

/** Verify the OTP with the provider for the SAME number it was sent to. Consumed on success. */
export async function verifyOtp(mobile: string, purpose: "register" | "reset", otp: string, ip: string) {
  if (!/^\d{4,8}$/.test(otp)) throw bad("Enter the OTP sent to your mobile");
  limit(`otpv-ip:${ip}`, 30, 10 * 60_000);
  const sess = await one(
    `UPDATE otp_sessions SET attempts = attempts + 1
      WHERE mobile=$1 AND purpose=$2 AND expires_at IS NOT NULL AND expires_at > now() AND attempts < $3
      RETURNING attempts`,
    [mobile, purpose, MAX_ATTEMPTS]
  );
  if (!sess) {
    const s = await one("SELECT expires_at, attempts FROM otp_sessions WHERE mobile=$1 AND purpose=$2", [mobile, purpose]);
    if (s && s.expires_at && new Date(s.expires_at) > new Date() && s.attempts >= MAX_ATTEMPTS)
      throw bad("Too many wrong attempts. Please request a new OTP.", 429);
    throw bad("OTP expired or not requested. Please request a new OTP.");
  }
  const res = await callProvider("/api/sms/verify-otp", { number: mobile, otp });
  const success = isProviderSuccess(res, "verify");
  await log(mobile, purpose, "verify", success, ip, `HTTP ${res.status} ${res.text}`);
  if (!success) {
    const left = MAX_ATTEMPTS - sess.attempts;
    throw bad(left > 0 ? `Invalid OTP. ${left} attempt${left === 1 ? "" : "s"} left.` : "Too many wrong attempts. Please request a new OTP.");
  }
  await q("UPDATE otp_sessions SET expires_at=NULL, attempts=0 WHERE mobile=$1 AND purpose=$2", [mobile, purpose]);
}
