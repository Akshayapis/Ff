/** User-facing API routes (mounted under /api). */
import {
  bad, q, one, tx, getSettings, sNum, hashPw, checkPw, signUser, signPurpose, verifyPurpose, mobile as vMobile, password as vPassword,
  reqStr, amt, int, clean, limit, imgUrl, saveImage, randCode, maskUid, paise, rupees, maskMobile, type Row,
} from "./core";
import { ok, type Route } from "./router";
import { sendOtp, verifyOtp } from "./otp";
import { registerReferral, applyWallet } from "./wallet";
import { createDeposit, syncDeposit, handleWebhook } from "./payment";
import { matchDTO, joinMatch, STATUS_GROUPS } from "./matches";
import { autoProgress } from "./core";

function userDTO(u: Row) {
  return {
    id: u.id,
    name: u.name,
    mobile: u.mobile,
    avatar: /^\d+$/.test(u.avatar) ? imgUrl(parseInt(u.avatar, 10)) : "",
    referralCode: u.referral_code,
    deposit: u.deposit_balance,
    winning: u.winning_balance,
    balance: rupees(paise(u.deposit_balance) + paise(u.winning_balance)),
    lastUid: u.last_uid,
    lastIgn: u.last_ign,
    createdAt: u.created_at,
  };
}

async function publicConfig() {
  const s = await getSettings();
  const logo = parseInt(s.app_logo, 10);
  return {
    appName: s.app_name,
    tagline: s.app_tagline,
    logo: Number.isFinite(logo) ? imgUrl(logo) : "",
    minDeposit: sNum(s, "min_deposit"),
    maxDeposit: sNum(s, "max_deposit"),
    minWithdraw: sNum(s, "min_withdraw"),
    maxWithdraw: sNum(s, "max_withdraw"),
    gst: sNum(s, "gst_percent"),
    withdrawEnabled: s.withdraw_enabled === "1",
    support: { whatsapp: s.support_whatsapp, telegram: s.support_telegram, email: s.support_email },
    devLink: s.dev_link,
    maintenance: s.maintenance === "1",
  };
}

/** IST start-of-day as a Date */
function istDayStart() {
  const off = 330 * 60_000;
  return new Date(Math.floor((Date.now() + off) / 86_400_000) * 86_400_000 - off);
}

export async function leaderboardRows(period: string) {
  const s = await getSettings();
  let since = new Date(0);
  if (period === "daily") {
    since = istDayStart();
    const reset = s.lb_daily_reset_at ? new Date(s.lb_daily_reset_at) : null;
    if (reset && !isNaN(reset.getTime()) && reset > since) since = reset;
  } else if (period === "weekly") since = new Date(Date.now() - 7 * 86_400_000);
  const rows = await q(
    `SELECT u.id, u.name, u.avatar, sum(t.win_delta)::float8 AS total
       FROM wallet_txns t JOIN users u ON u.id=t.user_id
      WHERE t.type='win' AND t.created_at >= $1 AND u.banned=false
      GROUP BY u.id ORDER BY total DESC, min(t.created_at) ASC LIMIT 10`,
    [since]
  );
  return rows.filter((r) => r.total > 0).map((r, i) => ({ rank: i + 1, userId: r.id, name: r.name, winnings: r.total }));
}

const FILTERS: Record<string, string[]> = {
  deposit: ["deposit"],
  entry: ["entry_fee"],
  win: ["win"],
  referral: ["referral_bonus"],
  withdrawal: ["withdrawal", "withdrawal_refund"],
  refund: ["refund", "withdrawal_refund"],
};

export const userRoutes: Route[] = [
  /* ---------------------------------------------------------- public */
  { method: "GET", path: "/config", open: true, handler: async () => publicConfig() },
  {
    method: "GET", path: "/img/:id", open: true,
    handler: async (c) => {
      const id = parseInt(c.params.id, 10);
      const r = Number.isFinite(id) ? await one("SELECT mime, data FROM images WHERE id=$1", [id]) : null;
      if (!r) return new Response("Not found", { status: 404 });
      return new Response(Buffer.from(r.data, "base64"), {
        headers: { "Content-Type": r.mime, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" },
      });
    },
  },
  {
    method: "POST", path: "/payment/webhook", open: true,
    handler: async (c) => ok(await handleWebhook(c.body, c.url.searchParams)),
  },
  {
    method: "GET", path: "/payment/webhook", open: true,
    handler: async (c) => ok(await handleWebhook({}, c.url.searchParams)),
  },

  /* ---------------------------------------------------------- auth */
  {
    method: "POST", path: "/auth/otp/send",
    handler: async (c) => {
      const m = vMobile(c.body.mobile);
      const purpose = c.body.purpose === "reset" ? "reset" : "register";
      const exists = await one("SELECT id FROM users WHERE mobile=$1", [m]);
      if (purpose === "register") {
        if (exists) throw bad("This mobile number is already registered. Please login.");
        reqStr(c.body.name, "Full name", 2, 30);
        vPassword(c.body.password);
      } else if (!exists) throw bad("No account found with this mobile number");
      const r = await sendOtp(m, purpose, c.ip);
      return ok(r, "OTP sent to your mobile");
    },
  },
  {
    method: "POST", path: "/auth/register",
    handler: async (c) => {
      const name = reqStr(c.body.name, "Full name", 2, 30);
      const m = vMobile(c.body.mobile);
      const pw = vPassword(c.body.password);
      const device = clean(c.body.deviceId, 64);
      const refCode = clean(c.body.ref, 20).toUpperCase();
      if (await one("SELECT id FROM users WHERE mobile=$1", [m])) throw bad("This mobile number is already registered. Please login.");
      await verifyOtp(m, "register", clean(c.body.otp, 8), c.ip); // account is created ONLY after OTP is verified
      const hash = await hashPw(pw);
      let refNote = "";
      const user = await tx(async (cl) => {
        let u: Row | null = null;
        for (let i = 0; i < 6 && !u; i++) {
          try {
            await cl.query("SAVEPOINT ins");
            u = await one(
              "INSERT INTO users(name,mobile,password_hash,referral_code,device_id) VALUES($1,$2,$3,$4,$5) RETURNING *",
              [name, m, hash, randCode(8), device],
              cl
            );
          } catch (e) {
            await cl.query("ROLLBACK TO SAVEPOINT ins");
            const err = e as { code?: string; constraint?: string };
            if (err.code === "23505" && err.constraint?.includes("mobile")) throw bad("This mobile number is already registered. Please login.");
            if (err.code !== "23505") throw e;
          }
        }
        if (!u) throw bad("Could not create account. Please try again.");
        if (refCode) {
          const r = await one("SELECT id, device_id, banned FROM users WHERE referral_code=$1 AND id<>$2", [refCode, u.id], cl);
          if (!r || r.banned) refNote = "Referral code not valid – skipped";
          else if (device && (r.device_id === device || (await one("SELECT id FROM users WHERE device_id=$1 AND id<>$2 LIMIT 1", [device, u.id], cl)))) {
            refNote = "Referral not applied (this device already has an account)";
          } else await registerReferral(cl, u.id, r.id);
        }
        return (await one("SELECT * FROM users WHERE id=$1", [u.id], cl))!;
      });
      return ok({ token: signUser(user), user: userDTO(user), refNote }, "Account created successfully");
    },
  },
  {
    method: "POST", path: "/auth/login",
    handler: async (c) => {
      const m = vMobile(c.body.mobile);
      limit(`login:${c.ip}:${m}`, 8, 10 * 60_000, "Too many login attempts. Try again in a few minutes.");
      const u = await one("SELECT * FROM users WHERE mobile=$1", [m]);
      if (!u || !(await checkPw(String(c.body.password ?? ""), u.password_hash))) throw bad("Invalid mobile number or password", 401);
      if (u.banned) throw bad(u.ban_reason ? `Your account is blocked: ${u.ban_reason}` : "Your account is blocked. Contact support.", 403, "BANNED");
      return ok({ token: signUser(u), user: userDTO(u) }, "Login successful");
    },
  },
  {
    method: "POST", path: "/auth/forgot/verify",
    handler: async (c) => {
      const m = vMobile(c.body.mobile);
      const u = await one("SELECT id, token_version FROM users WHERE mobile=$1", [m]);
      if (!u) throw bad("No account found with this mobile number");
      await verifyOtp(m, "reset", clean(c.body.otp, 8), c.ip);
      return ok({ resetToken: signPurpose({ uid: u.id, tv: u.token_version }, "reset", "10m") }, "OTP verified");
    },
  },
  {
    method: "POST", path: "/auth/forgot/reset",
    handler: async (c) => {
      const d = verifyPurpose(String(c.body.resetToken ?? ""), "reset");
      const pw = vPassword(c.body.password);
      const r = await one("UPDATE users SET password_hash=$2, token_version=token_version+1 WHERE id=$1 AND token_version=$3 RETURNING id", [d.uid, await hashPw(pw), d.tv]);
      if (!r) throw bad("This reset link is no longer valid. Please start again.", 401);
      return ok(null, "Password changed. Please login.");
    },
  },

  /* ---------------------------------------------------------- profile */
  {
    method: "GET", path: "/me", auth: "user",
    handler: async (c) => {
      const n = await one("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read=false", [c.user.id]);
      return { user: userDTO(c.user), unread: n!.n };
    },
  },
  {
    method: "PUT", path: "/me", auth: "user",
    handler: async (c) => {
      const name = reqStr(c.body.name, "Name", 2, 30);
      const u = await one("UPDATE users SET name=$2 WHERE id=$1 RETURNING *", [c.user.id, name]);
      return ok({ user: userDTO(u!) }, "Profile updated");
    },
  },
  {
    method: "PUT", path: "/me/avatar", auth: "user",
    handler: async (c) => {
      limit(`avatar:${c.user.id}`, 10, 3600_000);
      const id = await saveImage(c.body.dataUrl, 150 * 1024);
      const u = await one("UPDATE users SET avatar=$2 WHERE id=$1 RETURNING *", [c.user.id, String(id)]);
      return ok({ user: userDTO(u!) }, "Avatar updated");
    },
  },
  {
    method: "PUT", path: "/me/password", auth: "user",
    handler: async (c) => {
      limit(`pwchg:${c.user.id}`, 8, 3600_000);
      if (!(await checkPw(String(c.body.oldPassword ?? ""), c.user.password_hash))) throw bad("Current password is incorrect");
      const pw = vPassword(c.body.newPassword);
      const u = await one("UPDATE users SET password_hash=$2, token_version=token_version+1 WHERE id=$1 RETURNING *", [c.user.id, await hashPw(pw)]);
      return ok({ token: signUser(u!) }, "Password changed");
    },
  },

  /* ---------------------------------------------------------- home / games / matches */
  {
    method: "GET", path: "/home", auth: "user",
    handler: async (c) => {
      await autoProgress();
      const banners = await q("SELECT id, img, link FROM banners WHERE active=true ORDER BY sort_order, id");
      const games = await q("SELECT id, name, icon_img FROM games WHERE active=true ORDER BY sort_order, id");
      const cnt = await q(
        "SELECT m.status, count(*)::int AS n FROM match_players p JOIN matches m ON m.id=p.match_id WHERE p.user_id=$1 GROUP BY m.status",
        [c.user.id]
      );
      const g = (s: string[]) => cnt.filter((r) => s.includes(r.status)).reduce((a, r) => a + r.n, 0);
      return {
        banners: banners.map((b) => ({ id: b.id, image: imgUrl(b.img), link: b.link })),
        games: games.map((x) => ({ id: x.id, name: x.name, icon: imgUrl(x.icon_img) })),
        contests: { ongoing: g(["ongoing"]), upcoming: g(["upcoming"]), result: g(["completed", "cancelled"]) },
      };
    },
  },
  {
    method: "GET", path: "/games/:id/matches", auth: "user",
    handler: async (c) => {
      await autoProgress();
      const gid = int(c.params.id, "Game");
      const st = STATUS_GROUPS[c.url.searchParams.get("status") || "upcoming"] || STATUS_GROUPS.upcoming;
      const game = await one("SELECT id, name FROM games WHERE id=$1 AND active=true", [gid]);
      if (!game) throw bad("Game not found", 404);
      const completed = st.includes("completed");
      const rows = await q(
        `SELECT m.*, g.name AS game_name,
           (SELECT count(*)::int FROM match_players p WHERE p.match_id=m.id) AS joined,
           (SELECT p.id FROM match_players p WHERE p.match_id=m.id AND p.user_id=$2) AS my_pid
         FROM matches m JOIN games g ON g.id=m.game_id
         WHERE m.game_id=$1 AND m.status = ANY($3::text[])
         ORDER BY m.start_at ${completed ? "DESC" : "ASC"}, m.id ${completed ? "DESC" : "ASC"} LIMIT 60`,
        [gid, c.user.id, st]
      );
      return { game: { id: game.id, name: game.name }, matches: rows.map((r) => matchDTO(r, !!r.my_pid)) };
    },
  },
  {
    method: "GET", path: "/my/matches", auth: "user",
    handler: async (c) => {
      await autoProgress();
      const st = STATUS_GROUPS[c.url.searchParams.get("status") || "upcoming"] || STATUS_GROUPS.upcoming;
      const completed = st.includes("completed");
      const rows = await q(
        `SELECT m.*, g.name AS game_name, p.kills AS my_kills, p.prize AS my_prize, p.is_winner AS my_winner,
           (SELECT count(*)::int FROM match_players x WHERE x.match_id=m.id) AS joined
         FROM match_players p JOIN matches m ON m.id=p.match_id JOIN games g ON g.id=m.game_id
         WHERE p.user_id=$1 AND m.status = ANY($2::text[])
         ORDER BY m.start_at ${completed ? "DESC" : "ASC"} LIMIT 100`,
        [c.user.id, st]
      );
      return { matches: rows.map((r) => ({ ...matchDTO(r, true), myKills: r.my_kills, myPrize: r.my_prize, myWinner: r.my_winner })) };
    },
  },
  {
    method: "GET", path: "/matches/:id/players", auth: "user",
    handler: async (c) => {
      const mid = int(c.params.id, "Match");
      const m = await one("SELECT id, title, status, win_prize, per_kill, result_submitted FROM matches WHERE id=$1", [mid]);
      if (!m) throw bad("Match not found", 404);
      const done = m.status === "completed";
      const rows = await q(
        `SELECT id, ign, uid, kills, prize, is_winner, user_id FROM match_players WHERE match_id=$1
         ORDER BY ${done ? "prize DESC, kills DESC, id" : "id"}`,
        [mid]
      );
      return {
        match: { id: m.id, title: m.title, status: m.status, winPrize: m.win_prize, perKill: m.per_kill },
        players: rows.map((r, i) => ({
          rank: done ? i + 1 : null,
          ign: r.ign,
          uid: maskUid(r.uid),
          me: r.user_id === c.user.id,
          kills: done ? r.kills : null,
          prize: done ? r.prize : null,
          winner: done ? r.is_winner : null,
        })),
      };
    },
  },
  {
    method: "POST", path: "/matches/:id/join", auth: "user",
    handler: async (c) => {
      limit(`join:${c.user.id}`, 20, 60_000);
      const r = await joinMatch(c.user.id, int(c.params.id, "Match"), c.body.uid, c.body.ign);
      return ok(r, "Joined successfully! Good luck 🎮");
    },
  },

  /* ---------------------------------------------------------- leaderboard */
  {
    method: "GET", path: "/leaderboard", auth: "user",
    handler: async (c) => {
      const p = ["daily", "weekly", "all"].includes(c.url.searchParams.get("period") || "") ? (c.url.searchParams.get("period") as string) : "daily";
      return { period: p, rows: await leaderboardRows(p), meId: c.user.id };
    },
  },

  /* ---------------------------------------------------------- wallet */
  {
    method: "GET", path: "/wallet", auth: "user",
    handler: async (c) => ({ user: userDTO(c.user), config: await publicConfig() }),
  },
  {
    method: "GET", path: "/wallet/txns", auth: "user",
    handler: async (c) => {
      const f = c.url.searchParams.get("filter") || "all";
      const types = FILTERS[f] || null;
      const page = Math.max(0, parseInt(c.url.searchParams.get("page") || "0", 10) || 0);
      const rows = await q(
        `SELECT * FROM (
           SELECT 'L'||t.id AS key, t.id AS sort_id, t.type, t.amount, t.dep_delta, t.win_delta, t.match_id, t.ref, t.note, t.created_at,
             CASE WHEN t.type='withdrawal' THEN COALESCE((SELECT w.status FROM withdrawals w WHERE 'WD-'||w.id = t.ref), 'pending') ELSE 'success' END AS status
           FROM wallet_txns t WHERE t.user_id=$1
           UNION ALL
           SELECT 'D'||d.id, d.id, 'deposit', d.amount, 0, 0, NULL::int, d.order_id, d.note, d.created_at, d.status
           FROM deposits d WHERE d.user_id=$1 AND d.status<>'success'
         ) x WHERE ($2::text[] IS NULL OR x.type = ANY($2::text[]))
         ORDER BY x.created_at DESC, x.sort_id DESC LIMIT 31 OFFSET $3`,
        [c.user.id, types, page * 30]
      );
      return {
        txns: rows.slice(0, 30).map((r) => ({
          key: r.key, type: r.type, amount: r.amount, dep: r.dep_delta, win: r.win_delta, matchId: r.match_id, ref: r.ref, note: r.note, at: r.created_at, status: r.status,
        })),
        more: rows.length > 30,
      };
    },
  },
  {
    method: "POST", path: "/deposit/create", auth: "user",
    handler: async (c) => {
      limit(`dep:${c.user.id}`, 10, 60_000);
      const amount = amt(c.body.amount, "Amount", false);
      return ok(await createDeposit(c.user, amount, c.req), "Order created");
    },
  },
  {
    method: "GET", path: "/deposit/:orderId", auth: "user",
    handler: async (c) => {
      limit(`depchk:${c.user.id}`, 40, 60_000);
      const d0 = await one("SELECT order_id FROM deposits WHERE order_id=$1 AND user_id=$2", [c.params.orderId, c.user.id]);
      if (!d0) throw bad("Deposit not found", 404);
      const d = await syncDeposit(c.params.orderId);
      return { orderId: d.order_id, amount: d.amount, status: d.status, utrStatus: d.utr_status, utr: d.utr, note: d.note, payUrl: d.pay_url, at: d.created_at };
    },
  },
  {
    method: "POST", path: "/withdraw", auth: "user",
    handler: async (c) => {
      limit(`wd:${c.user.id}`, 6, 60_000);
      const s = await getSettings();
      if (s.withdraw_enabled !== "1") throw bad("Withdrawals are currently disabled");
      const amount = amt(c.body.amount, "Amount", false);
      const min = sNum(s, "min_withdraw");
      const max = sNum(s, "max_withdraw");
      if (amount < min) throw bad(`Minimum withdrawal is ₹${min}`);
      if (max > 0 && amount > max) throw bad(`Maximum withdrawal is ₹${max}`);
      const method = c.body.method === "upi" ? "upi" : c.body.method === "bank" ? "bank" : "";
      if (!method) throw bad("Choose a withdrawal method");
      let holder = "", acc = "", ifsc = "", mob = "", upi = "";
      if (method === "bank") {
        holder = reqStr(c.body.holderName, "Account holder name", 2, 60);
        acc = String(c.body.accountNo ?? "").replace(/\s/g, "");
        if (!/^\d{9,18}$/.test(acc)) throw bad("Enter a valid account number (9-18 digits)");
        if (acc !== String(c.body.confirmAccountNo ?? "").replace(/\s/g, "")) throw bad("Account numbers do not match");
        ifsc = String(c.body.ifsc ?? "").trim().toUpperCase();
        if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw bad("Enter a valid IFSC code");
        mob = vMobile(c.body.mobile);
      } else {
        upi = String(c.body.upiId ?? "").trim().toLowerCase();
        if (!/^[a-z0-9._-]{2,50}@[a-z0-9]{2,30}$/.test(upi)) throw bad("Enter a valid UPI ID");
      }
      const gst = sNum(s, "gst_percent");
      const gstP = Math.round((paise(amount) * gst) / 100);
      const finalP = paise(amount) - gstP;
      if (finalP <= 0) throw bad("Amount too low after deductions");
      const r = await tx(async (cl) => {
        const u = await one("SELECT winning_balance FROM users WHERE id=$1 FOR UPDATE", [c.user.id], cl);
        if (!u || u.winning_balance < amount) throw bad("Insufficient winning balance. Only winnings can be withdrawn.");
        const w = await one(
          `INSERT INTO withdrawals(user_id,method,holder_name,account_no,ifsc,mobile,upi_id,amount,gst_percent,gst_amount,final_amount)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [c.user.id, method, holder, acc, ifsc, mob, upi, amount, gst, rupees(gstP), rupees(finalP)],
          cl
        );
        await applyWallet(cl, c.user.id, { type: "withdrawal", win: -amount, ref: `WD-${w!.id}`, note: `Withdrawal request #${w!.id} (${method.toUpperCase()}) – GST ₹${rupees(gstP)}, payable ₹${rupees(finalP)}` });
        return { id: w!.id, amount, gst: rupees(gstP), finalAmount: rupees(finalP) };
      });
      return ok(r, "Withdrawal request submitted");
    },
  },
  {
    method: "GET", path: "/withdrawals", auth: "user",
    handler: async (c) => {
      const rows = await q("SELECT * FROM withdrawals WHERE user_id=$1 ORDER BY id DESC LIMIT 50", [c.user.id]);
      return {
        withdrawals: rows.map((w) => ({
          id: w.id, method: w.method, amount: w.amount, gst: w.gst_amount, gstPercent: w.gst_percent, finalAmount: w.final_amount, status: w.status,
          to: w.method === "upi" ? w.upi_id : `${w.holder_name} • A/C ${"X".repeat(Math.max(0, w.account_no.length - 4))}${w.account_no.slice(-4)}`,
          payoutRef: w.payout_ref, reason: w.reason, at: w.created_at,
        })),
      };
    },
  },

  /* ---------------------------------------------------------- referrals / content */
  {
    method: "GET", path: "/referrals", auth: "user",
    handler: async (c) => {
      const rows = await q(
        `SELECT r.earned, r.referrer_bonus_paid, r.created_at, u.name, u.mobile
           FROM referrals r JOIN users u ON u.id=r.referred_id WHERE r.referrer_id=$1 ORDER BY r.id DESC LIMIT 200`,
        [c.user.id]
      );
      const s = await getSettings();
      return {
        code: c.user.referral_code,
        total: rows.length,
        earned: rows.reduce((a, r) => a + paise(r.earned), 0) / 100,
        rewards: { signup: sNum(s, "ref_signup_referrer"), friend: sNum(s, "ref_signup_referred"), percent: sNum(s, "ref_percent"), minDeposit: sNum(s, "ref_min_deposit") },
        list: rows.map((r) => ({ name: r.name, mobile: maskMobile(r.mobile), earned: r.earned, status: r.earned > 0 ? "credited" : "pending", at: r.created_at })),
      };
    },
  },
  {
    method: "GET", path: "/promotions", auth: "user",
    handler: async () => {
      const rows = await q("SELECT * FROM promotions WHERE active=true ORDER BY sort_order, id DESC LIMIT 50");
      const banners = await q("SELECT id, img, link FROM banners WHERE active=true ORDER BY sort_order, id");
      return {
        promotions: rows.map((p) => ({ id: p.id, title: p.title, body: p.body, image: imgUrl(p.img), link: p.link })),
        banners: banners.map((b) => ({ id: b.id, image: imgUrl(b.img), link: b.link })),
      };
    },
  },
  {
    method: "GET", path: "/announcements", auth: "user",
    handler: async (c) => {
      const a = await q("SELECT id, title, body, created_at FROM announcements WHERE active=true ORDER BY id DESC LIMIT 50");
      const n = await q("SELECT id, title, body, read, created_at FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 50", [c.user.id]);
      return { announcements: a, notifications: n };
    },
  },
  {
    method: "POST", path: "/notifications/read", auth: "user",
    handler: async (c) => {
      await q("UPDATE notifications SET read=true WHERE user_id=$1 AND read=false", [c.user.id]);
      return ok(null);
    },
  },
];
