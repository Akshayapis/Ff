/**
 * Wallet engine. EVERY balance change goes through applyWallet() inside a DB transaction,
 * which updates the balance (DB CHECK prevents negatives) and appends an immutable ledger row.
 */
import type { PoolClient } from "pg";
import { bad, one, q, getSettings, sNum, paise, rupees, notify, type Row } from "./core";

export interface WalletOp {
  type: string;
  dep?: number; // signed rupees change to deposit balance
  win?: number; // signed rupees change to winning balance
  matchId?: number | null;
  ref?: string;
  note?: string;
}

export async function applyWallet(c: PoolClient, userId: number, op: WalletOp) {
  const dep = op.dep ?? 0;
  const win = op.win ?? 0;
  let u: Row | null;
  try {
    u = await one(
      `UPDATE users SET deposit_balance = deposit_balance + $2, winning_balance = winning_balance + $3
       WHERE id=$1 RETURNING deposit_balance, winning_balance`,
      [userId, dep, win],
      c
    );
  } catch (e) {
    if ((e as { code?: string }).code === "23514") throw bad("Insufficient balance");
    throw e;
  }
  if (!u) throw bad("User not found", 404);
  const amount = rupees(Math.abs(paise(dep)) + Math.abs(paise(win)));
  await q(
    `INSERT INTO wallet_txns(user_id,type,amount,dep_delta,win_delta,dep_after,win_after,match_id,ref,note)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [userId, op.type, amount, dep, win, u.deposit_balance, u.winning_balance, op.matchId ?? null, op.ref ?? "", (op.note ?? "").slice(0, 300)],
    c
  );
  return { deposit: u.deposit_balance as number, winning: u.winning_balance as number };
}

/** Pay an entry fee: deposit balance first, then winning balance. Locks the user row. */
export async function spendEntryFee(c: PoolClient, userId: number, fee: number, matchId: number, note: string) {
  if (fee <= 0) return;
  const u = await one("SELECT deposit_balance, winning_balance FROM users WHERE id=$1 FOR UPDATE", [userId], c);
  if (!u) throw bad("User not found", 404);
  const feeP = paise(fee);
  const depP = Math.min(paise(u.deposit_balance), feeP);
  const winP = feeP - depP;
  if (winP > paise(u.winning_balance)) throw bad("Insufficient wallet balance. Please add money.", 400, "LOW_BALANCE");
  await applyWallet(c, userId, { type: "entry_fee", dep: -rupees(depP), win: -rupees(winP), matchId, ref: `M${matchId}`, note });
}

/** Refund the most recent entry fee of (user, match) back to the same buckets it came from. */
export async function refundEntryFee(c: PoolClient, userId: number, matchId: number, note: string) {
  const t = await one(
    "SELECT dep_delta, win_delta FROM wallet_txns WHERE user_id=$1 AND match_id=$2 AND type='entry_fee' ORDER BY id DESC LIMIT 1",
    [userId, matchId],
    c
  );
  if (!t) return 0;
  const dep = -t.dep_delta;
  const win = -t.win_delta;
  if (dep <= 0 && win <= 0) return 0;
  await applyWallet(c, userId, { type: "refund", dep, win, matchId, ref: `M${matchId}`, note });
  return rupees(paise(dep) + paise(win));
}

/* ------------------------------------------------------------------ referrals */

/** Called inside the registration transaction after the new user row exists. */
export async function registerReferral(c: PoolClient, newUserId: number, referrerId: number) {
  const s = await getSettings();
  const bonusReferrer = sNum(s, "ref_signup_referrer");
  const bonusReferred = sNum(s, "ref_signup_referred");
  const minDep = sNum(s, "ref_min_deposit");
  let earned = 0;
  let paid = false;
  if (bonusReferred > 0) {
    await applyWallet(c, newUserId, { type: "referral_bonus", dep: bonusReferred, ref: `REF-JOIN-${newUserId}`, note: "Signup bonus (referral)" });
  }
  if (bonusReferrer > 0 && minDep <= 0) {
    await applyWallet(c, referrerId, { type: "referral_bonus", dep: bonusReferrer, ref: `REF-${newUserId}`, note: "Referral signup bonus" });
    earned = bonusReferrer;
    paid = true;
    await notify(referrerId, "Referral bonus", `You earned ₹${bonusReferrer} for a new referral.`, c);
  }
  await q("INSERT INTO referrals(referrer_id,referred_id,referrer_bonus_paid,earned) VALUES($1,$2,$3,$4)", [referrerId, newUserId, paid, earned], c);
  await q("UPDATE users SET referred_by=$2 WHERE id=$1", [newUserId, referrerId], c);
}

/** Called inside the deposit-credit transaction. Pays referrer per admin referral settings. */
export async function referralOnDeposit(c: PoolClient, userId: number, amount: number) {
  const ref = await one("SELECT * FROM referrals WHERE referred_id=$1 FOR UPDATE", [userId], c);
  if (!ref) return;
  const s = await getSettings();
  const minDep = sNum(s, "ref_min_deposit");
  if (amount < minDep) return;
  let bonusP = 0;
  const notes: string[] = [];
  if (!ref.referrer_bonus_paid) {
    const b = sNum(s, "ref_signup_referrer");
    if (b > 0 && minDep > 0) {
      await applyWallet(c, ref.referrer_id, { type: "referral_bonus", dep: b, ref: `REF-${userId}`, note: "Referral bonus (first qualifying deposit)" });
      bonusP += paise(b);
      notes.push("joining bonus");
    }
    await q("UPDATE referrals SET referrer_bonus_paid=true WHERE id=$1", [ref.id], c);
  }
  const pct = sNum(s, "ref_percent");
  if (pct > 0) {
    let apply = s.ref_percent_mode === "every";
    if (!apply) {
      const n = await one("SELECT count(*)::int AS n FROM wallet_txns WHERE user_id=$1 AND type='deposit'", [userId], c);
      apply = (n?.n ?? 0) <= 1; // this deposit's ledger row is inserted before this call => first deposit when count is 1
    }
    if (apply) {
      let b = Math.floor((paise(amount) * pct) / 100);
      const cap = sNum(s, "ref_max_cap");
      if (cap > 0) b = Math.min(b, paise(cap));
      if (b > 0) {
        await applyWallet(c, ref.referrer_id, { type: "referral_bonus", dep: rupees(b), ref: `REFDEP-${userId}`, note: `Referral ${pct}% deposit bonus` });
        bonusP += b;
        notes.push(`${pct}% deposit bonus`);
      }
    }
  }
  if (bonusP > 0) {
    await q("UPDATE referrals SET earned = earned + $2 WHERE id=$1", [ref.id, rupees(bonusP)], c);
    await notify(ref.referrer_id, "Referral bonus", `You earned ₹${rupees(bonusP)} (${notes.join(" + ")}) from a referral.`, c);
  }
}
