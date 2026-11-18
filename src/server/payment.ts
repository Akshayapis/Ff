/**
 * Deposit / payment integration – https://v3payamunt.vercel.app/api/v1/
 *  POST /create-order  {username,key,amount,order_id,redirect_url,webhook_url}
 *  GET  /check-order?username=&key=&order_id=
 * Credentials come from admin settings (or env) and NEVER leave the server.
 * The wallet is credited ONLY after check-order (server-to-server) confirms a verified payment.
 */
import { bad, getSettings, one, q, tx, randCode, notify, siteUrl, type Row } from "./core";
import { applyWallet, referralOnDeposit } from "./wallet";

type Json = Record<string, unknown>;

/* ===================================================================
 * PARSING FUNCTIONS – the provider's exact format may differ.
 * Adjust ONLY these functions if the responses change.
 * =================================================================== */

const truthy = (v: unknown) => v === true || (typeof v === "string" && /^(true|1|yes)$/i.test(v.trim())) || v === 1;

/** Flatten `{...raw, ...raw.data}` so fields may be at top level or inside `data`. */
function flat(raw: Json): Json {
  const d = raw && typeof raw.data === "object" && raw.data && !Array.isArray(raw.data) ? (raw.data as Json) : {};
  return { ...raw, ...d };
}

export type PayState = "success" | "pending" | "failed" | "expired";
export interface ParsedCheck {
  state: PayState;
  utr: string;
  utrStatus: string;
  message: string;
}

/**
 * Interprets a check-order response.
 *  success  => utr_verified === true OR utr_status === "verified"   (the ONLY way a wallet gets credited)
 *  failed   => rejected === true OR utr_status === "rejected"
 *  expired  => expired === true OR utr_status === "expired_unverified"
 *  otherwise => pending
 */
export function parseCheckOrder(raw: Json): ParsedCheck {
  const j = flat(raw);
  const utrStatus = String(j.utr_status ?? "none").toLowerCase();
  const utr = String(j.submitted_utr ?? j.utr ?? "").slice(0, 60);
  const message = String(j.message ?? "").slice(0, 200);
  let state: PayState = "pending";
  if (truthy(j.utr_verified) || utrStatus === "verified") state = "success";
  else if (truthy(j.rejected) || utrStatus === "rejected") state = "failed";
  else if (truthy(j.expired) || utrStatus === "expired_unverified") state = "expired";
  return { state, utr, utrStatus, message };
}

/** Finds the payment link in a create-order response (several likely key names, then any http URL). */
export function extractPayLink(raw: Json, exclude: string[]): string {
  const j = flat(raw);
  const keys = ["payment_url", "payment_link", "pay_url", "paymentUrl", "paymentLink", "checkout_url", "payment_page", "url", "link", "pay_link"];
  for (const k of keys) if (typeof j[k] === "string" && /^https?:\/\//i.test(j[k] as string)) return j[k] as string;
  const seen: string[] = [];
  const walk = (o: unknown, depth: number) => {
    if (depth > 3 || !o) return;
    if (typeof o === "string") {
      if (/^https?:\/\//i.test(o) && !exclude.includes(o)) seen.push(o);
    } else if (typeof o === "object") for (const v of Object.values(o as Json)) walk(v, depth + 1);
  };
  walk(j, 0);
  return seen[0] || "";
}

/** Safe subset of create-order response to show the user (never includes keys). */
export function publicDetails(raw: Json): { k: string; v: string }[] {
  const out: { k: string; v: string }[] = [];
  const walk = (o: Json, prefix: string, depth: number) => {
    for (const [k, v] of Object.entries(o)) {
      if (/key|secret|token|password|username|webhook|redirect/i.test(k)) continue;
      if (v && typeof v === "object" && !Array.isArray(v) && depth < 2) walk(v as Json, prefix + k + ".", depth + 1);
      else if (typeof v === "string" || typeof v === "number") out.push({ k: (prefix + k).replace(/_/g, " "), v: String(v).slice(0, 200) });
    }
  };
  walk(raw, "", 0);
  return out.slice(0, 12);
}

/* =================================================================== */

async function creds() {
  const s = await getSettings();
  if (!s.pay_base || !s.pay_username || !s.pay_key) throw bad("Payments are not configured yet. Please contact support.", 503);
  return { base: s.pay_base.replace(/\/+$/, ""), user: s.pay_username, key: s.pay_key, s };
}

function stripSecrets(text: string, key: string, user: string) {
  let t = text;
  if (key) t = t.split(key).join("***");
  if (user) t = t.split(user).join("***");
  return t.slice(0, 2000);
}

async function readJson(r: Response): Promise<{ json: Json; text: string }> {
  const text = await r.text();
  try {
    const p = JSON.parse(text);
    if (p && typeof p === "object" && !Array.isArray(p)) return { json: p as Json, text };
  } catch {
    /* ignore */
  }
  return { json: {}, text };
}

export async function createDeposit(user: Row, amount: number, req: Request) {
  const { base, user: pu, key, s } = await creds();
  const min = parseFloat(s.min_deposit) || 0;
  const max = parseFloat(s.max_deposit) || 0;
  if (!Number.isInteger(amount)) throw bad("Enter a whole rupee amount");
  if (amount < min) throw bad(`Minimum deposit is ₹${min}`);
  if (max > 0 && amount > max) throw bad(`Maximum deposit is ₹${max}`);
  const pend = await one("SELECT count(*)::int AS n FROM deposits WHERE user_id=$1 AND status='pending' AND created_at > now() - interval '1 hour'", [user.id]);
  if (pend && pend.n >= 5) throw bad("Too many pending deposits. Complete or wait for them to expire.");

  const orderId = `HZ-${user.id}-${Date.now()}-${randCode(5)}`;
  const origin = await siteUrl(req);
  const redirect = `${origin}/index.html#wallet`;
  const webhook = `${origin}/api/payment/webhook`;
  await q("INSERT INTO deposits(user_id,order_id,amount) VALUES($1,$2,$3)", [user.id, orderId, amount]);

  let res: Response;
  try {
    res = await fetch(`${base}/create-order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: pu, key, amount, order_id: orderId, redirect_url: redirect, webhook_url: webhook }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    await q("UPDATE deposits SET status='failed', note='Payment gateway unreachable', updated_at=now() WHERE order_id=$1", [orderId]);
    throw bad("Payment gateway is unreachable. Please try again.", 502);
  }
  const { json, text } = await readJson(res);
  const f = flat(json);
  const explicitFail =
    !res.ok || f.success === false || f.status === false || /^(error|failed|fail)$/i.test(String(f.status ?? ""));
  const payUrl = extractPayLink(json, [redirect, webhook]);
  const details = publicDetails(json);
  if (explicitFail || (!payUrl && details.length === 0)) {
    await q("UPDATE deposits SET status='failed', note=$2, provider_raw=$3, updated_at=now() WHERE order_id=$1", [
      orderId,
      String(f.message ?? "Gateway rejected the order").slice(0, 200),
      stripSecrets(text, key, pu),
    ]);
    throw bad(String(f.message || "Could not create payment order. Please try again."), 502);
  }
  await q("UPDATE deposits SET pay_url=$2, provider_raw=$3, updated_at=now() WHERE order_id=$1", [orderId, payUrl, stripSecrets(text, key, pu)]);
  return { orderId, payUrl, details, amount };
}

/** Credit a deposit exactly once. Safe to call repeatedly / concurrently (row lock + unique ledger index). */
export async function creditDeposit(orderId: string, utr: string, note: string): Promise<{ credited: boolean; userId?: number }> {
  return tx(async (c) => {
    const d = await one("SELECT * FROM deposits WHERE order_id=$1 FOR UPDATE", [orderId], c);
    if (!d) throw bad("Deposit not found", 404);
    if (d.credited) return { credited: false, userId: d.user_id };
    await q(
      "UPDATE deposits SET status='success', utr_status='verified', utr=CASE WHEN $2<>'' THEN $2 ELSE utr END, credited=true, paid_at=now(), note=$3, updated_at=now() WHERE id=$1",
      [d.id, utr, note],
      c
    );
    await applyWallet(c, d.user_id, { type: "deposit", dep: d.amount, ref: d.order_id, note: `Deposit ${d.order_id}` });
    await referralOnDeposit(c, d.user_id, d.amount);
    await notify(d.user_id, "Deposit successful", `₹${d.amount} has been added to your wallet.`, c);
    return { credited: true, userId: d.user_id };
  });
}

/** Ask the provider about an order (server-side) and update our record; credits on verified payment. */
export async function syncDeposit(orderId: string): Promise<Row> {
  const d0 = await one("SELECT * FROM deposits WHERE order_id=$1", [orderId]);
  if (!d0) throw bad("Deposit not found", 404);
  if (d0.status !== "pending") return d0;
  const { base, user, key } = await creds();
  let parsed: ParsedCheck;
  let text = "";
  try {
    const r = await fetch(
      `${base}/check-order?username=${encodeURIComponent(user)}&key=${encodeURIComponent(key)}&order_id=${encodeURIComponent(orderId)}`,
      { signal: AbortSignal.timeout(20000), cache: "no-store" }
    );
    const o = await readJson(r);
    text = o.text;
    if (!r.ok) {
      // order unknown / gateway error: leave pending, but expire stale orders locally
      await staleExpire(orderId);
      return (await one("SELECT * FROM deposits WHERE order_id=$1", [orderId]))!;
    }
    parsed = parseCheckOrder(o.json);
  } catch {
    return d0; // network error: keep pending, try again later
  }
  const raw = stripSecrets(text, key, user);
  if (parsed.state === "success") {
    await q("UPDATE deposits SET provider_raw=$2 WHERE order_id=$1", [orderId, raw]);
    await creditDeposit(orderId, parsed.utr, "Verified by payment gateway");
  } else if (parsed.state === "failed" || parsed.state === "expired") {
    await q(
      "UPDATE deposits SET status=$2, utr_status=$3, utr=$4, provider_raw=$5, note=$6, updated_at=now() WHERE order_id=$1 AND status='pending'",
      [orderId, parsed.state === "failed" ? "rejected" : "expired", parsed.utrStatus, parsed.utr, raw, parsed.message]
    );
  } else {
    await q("UPDATE deposits SET utr_status=$2, utr=$3, provider_raw=$4, updated_at=now() WHERE order_id=$1 AND status='pending'", [
      orderId,
      parsed.utrStatus,
      parsed.utr,
      raw,
    ]);
    await staleExpire(orderId);
  }
  return (await one("SELECT * FROM deposits WHERE order_id=$1", [orderId]))!;
}

/** Pending orders with no payment for 24h are expired locally. */
async function staleExpire(orderId: string) {
  await q("UPDATE deposits SET status='expired', note='Order expired', updated_at=now() WHERE order_id=$1 AND status='pending' AND created_at < now() - interval '24 hours'", [orderId]);
}

/** Background poller target: re-check all recent pending orders. */
export async function pollPendingDeposits() {
  const rows = await q("SELECT order_id FROM deposits WHERE status='pending' AND created_at > now() - interval '25 hours' ORDER BY id LIMIT 50");
  for (const r of rows) {
    try {
      await syncDeposit(r.order_id);
    } catch {
      /* continue with next order */
    }
  }
  await q("UPDATE deposits SET status='expired', note='Order expired', updated_at=now() WHERE status='pending' AND created_at < now() - interval '25 hours'");
}

/** Webhook: the payload is NOT trusted – we only extract the order_id and re-verify via check-order. */
export async function handleWebhook(body: Json, query: URLSearchParams) {
  const f = flat(body || {});
  const orderId = String(f.order_id ?? f.orderId ?? query.get("order_id") ?? "").slice(0, 100);
  if (!/^HZ-\d+-\d+-[A-Z0-9]+$/.test(orderId)) throw bad("Invalid order", 400);
  const d = await syncDeposit(orderId);
  return { status: d.status };
}
