/** Admin API routes (mounted under /api/admin). Separate JWT secret from users. */
import {
  bad, q, one, tx, getSettings, setSettings, SECRET_KEYS, hashPw, checkPw, signAdmin, reqStr, amt, int, clean, limit, imgUrl, saveImage,
  audit, notify, paise, rupees, mobile as vMobile, password as vPassword, siteUrl, type Row,
} from "./core";
import { ok, type Route } from "./router";
import { applyWallet } from "./wallet";
import { creditDeposit, syncDeposit } from "./payment";
import { submitResult, cancelMatch, removePlayer, deleteMatch } from "./matches";
import { leaderboardRows } from "./user-routes";
import { autoProgress } from "./core";

const A = (c: { admin: Row }) => c.admin.username as string;
const page = (c: { url: URL }) => Math.max(0, parseInt(c.url.searchParams.get("page") || "0", 10) || 0);
const like = (v: string | null) => `%${(v || "").trim().replace(/[%_\\]/g, (m) => "\\" + m)}%`;
const bool = (v: unknown) => v === true || v === "1" || v === 1 || v === "true";
const optImage = async (v: unknown, max = 600 * 1024) => (v ? saveImage(v, max) : null);

function matchFields(b: Row) {
  const type = ["Solo", "Duo", "Squad"].includes(b.type) ? b.type : null;
  const version = ["TPP", "FPP"].includes(b.version) ? b.version : null;
  if (!type) throw bad("Select a valid match type");
  if (!version) throw bad("Select a valid version");
  const start = new Date(b.startAt);
  if (isNaN(start.getTime())) throw bad("Enter a valid date and time");
  return {
    title: reqStr(b.title, "Match title", 2, 80),
    type,
    version,
    map: clean(b.map, 40),
    entryFee: amt(b.entryFee ?? 0, "Entry fee"),
    prizePool: amt(b.prizePool ?? 0, "Prize pool"),
    winPrize: amt(b.winPrize ?? 0, "Win prize"),
    perKill: amt(b.perKill ?? 0, "Per kill"),
    maxPlayers: int(b.maxPlayers, "Max players", 2, 200),
    startAt: start,
  };
}

const MATCH_SELECT = `SELECT m.*, g.name AS game_name,
  (SELECT count(*)::int FROM match_players p WHERE p.match_id=m.id) AS joined
  FROM matches m JOIN games g ON g.id=m.game_id`;

function adminMatch(m: Row) {
  return {
    id: m.id, gameId: m.game_id, gameName: m.game_name, title: m.title, banner: imgUrl(m.banner_img), type: m.type, version: m.version, map: m.map,
    entryFee: m.entry_fee, prizePool: m.prize_pool, winPrize: m.win_prize, perKill: m.per_kill, maxPlayers: m.max_players, joined: m.joined,
    startAt: m.start_at, status: m.status, roomId: m.room_id, roomPassword: m.room_password, roomReleased: m.room_released, resultSubmitted: m.result_submitted,
  };
}

export const adminRoutes: Route[] = [
  /* ---------------------------------------------------------- auth */
  {
    method: "POST", path: "/admin/login", auth: undefined,
    handler: async (c) => {
      limit(`adm-login:${c.ip}`, 8, 10 * 60_000, "Too many login attempts. Try again later.");
      const a = await one("SELECT * FROM admins WHERE username=$1", [clean(c.body.username, 50).toLowerCase()]);
      if (!a || !(await checkPw(String(c.body.password ?? ""), a.password_hash))) throw bad("Invalid admin credentials", 401);
      await audit(a.username, "login", `ip ${c.ip}`);
      return ok({ token: signAdmin(a), username: a.username }, "Welcome admin");
    },
  },
  {
    method: "GET", path: "/admin/me", auth: "admin",
    handler: async (c) => ({ username: c.admin.username }),
  },
  {
    method: "POST", path: "/admin/password", auth: "admin",
    handler: async (c) => {
      limit(`adm-pw:${c.admin.id}`, 6, 3600_000);
      if (!(await checkPw(String(c.body.oldPassword ?? ""), c.admin.password_hash))) throw bad("Current password is incorrect");
      const pw = vPassword(c.body.newPassword);
      if (pw.length < 8) throw bad("Admin password must be at least 8 characters");
      const a = await one("UPDATE admins SET password_hash=$2, token_version=token_version+1 WHERE id=$1 RETURNING *", [c.admin.id, await hashPw(pw)]);
      await audit(A(c), "change_password");
      return ok({ token: signAdmin(a!) }, "Password changed");
    },
  },

  /* ---------------------------------------------------------- dashboard */
  {
    method: "GET", path: "/admin/dashboard", auth: "admin",
    handler: async () => {
      const off = 330 * 60_000;
      const dayStart = new Date(Math.floor((Date.now() + off) / 86_400_000) * 86_400_000 - off);
      const t = await one(
        `SELECT
          (SELECT count(*)::int FROM users) AS users,
          (SELECT count(*)::int FROM users WHERE last_active_at >= $1) AS active_today,
          (SELECT COALESCE(sum(amount),0) FROM deposits WHERE status='success') AS deposits,
          (SELECT COALESCE(sum(amount),0) FROM withdrawals WHERE status IN ('approved','paid')) AS withdrawals,
          (SELECT COALESCE(sum(amount),0) FROM withdrawals WHERE status='pending') AS pending_wd_amount,
          (SELECT count(*)::int FROM withdrawals WHERE status='pending') AS pending_wd,
          (SELECT COALESCE(sum(amount),0) FROM wallet_txns WHERE type='entry_fee') AS entry_total,
          (SELECT COALESCE(sum(amount),0) FROM wallet_txns WHERE type='refund') AS refund_total,
          (SELECT COALESCE(sum(amount),0) FROM wallet_txns WHERE type='win') AS prize_paid,
          (SELECT count(*)::int FROM matches WHERE status IN ('upcoming','ongoing')) AS open_matches,
          (SELECT count(*)::int FROM deposits WHERE status='pending') AS pending_deposits`,
        [dayStart]
      );
      const series = await q(
        `WITH d AS (SELECT to_char(g::date,'YYYY-MM-DD') AS day FROM generate_series((now() AT TIME ZONE 'Asia/Kolkata')::date - 29, (now() AT TIME ZONE 'Asia/Kolkata')::date, interval '1 day') g)
         SELECT d.day,
           COALESCE((SELECT sum(amount) FROM wallet_txns w WHERE w.type='deposit' AND to_char(w.created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD')=d.day),0) AS deposits,
           COALESCE((SELECT sum(amount) FROM wallet_txns w WHERE w.type='entry_fee' AND to_char(w.created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD')=d.day),0) AS entry,
           COALESCE((SELECT sum(amount) FROM wallet_txns w WHERE w.type='refund' AND to_char(w.created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD')=d.day),0) AS refunds,
           COALESCE((SELECT sum(amount) FROM wallet_txns w WHERE w.type='win' AND to_char(w.created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD')=d.day),0) AS prizes,
           COALESCE((SELECT sum(amount) FROM withdrawals x WHERE x.status IN ('approved','paid') AND to_char(x.created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD')=d.day),0) AS withdrawals,
           (SELECT count(*)::int FROM users u WHERE to_char(u.created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD')=d.day) AS signups
         FROM d ORDER BY d.day`
      );
      return {
        totals: {
          users: t!.users, activeToday: t!.active_today, deposits: t!.deposits, withdrawals: t!.withdrawals,
          pendingWithdrawals: t!.pending_wd, pendingWithdrawalAmount: t!.pending_wd_amount,
          entryCollected: rupees(paise(t!.entry_total) - paise(t!.refund_total)), prizePaid: t!.prize_paid,
          profit: rupees(paise(t!.entry_total) - paise(t!.refund_total) - paise(t!.prize_paid)),
          openMatches: t!.open_matches, pendingDeposits: t!.pending_deposits,
        },
        series: series.map((s) => ({ day: s.day, deposits: s.deposits, entry: rupees(paise(s.entry) - paise(s.refunds)), prizes: s.prizes, withdrawals: s.withdrawals, signups: s.signups })),
      };
    },
  },

  /* ---------------------------------------------------------- games */
  {
    method: "GET", path: "/admin/games", auth: "admin",
    handler: async () => {
      const rows = await q("SELECT g.*, (SELECT count(*)::int FROM matches m WHERE m.game_id=g.id) AS matches FROM games g ORDER BY sort_order, id");
      return { games: rows.map((g) => ({ id: g.id, name: g.name, icon: imgUrl(g.icon_img), sortOrder: g.sort_order, active: g.active, matches: g.matches })) };
    },
  },
  {
    method: "POST", path: "/admin/games", auth: "admin",
    handler: async (c) => {
      const name = reqStr(c.body.name, "Game name", 2, 40);
      if (!c.body.icon) throw bad("Upload a game icon");
      const icon = await saveImage(c.body.icon, 300 * 1024);
      const g = await one("INSERT INTO games(name,icon_img,sort_order,active) VALUES($1,$2,$3,$4) RETURNING id", [name, icon, int(c.body.sortOrder ?? 0, "Sort order", 0, 9999), c.body.active !== false]);
      await audit(A(c), "game_create", `#${g!.id} ${name}`);
      return ok({ id: g!.id }, "Game added");
    },
  },
  {
    method: "PUT", path: "/admin/games/:id", auth: "admin",
    handler: async (c) => {
      const id = int(c.params.id, "Game");
      const name = reqStr(c.body.name, "Game name", 2, 40);
      const icon = await optImage(c.body.icon, 300 * 1024);
      const r = await one("UPDATE games SET name=$2, sort_order=$3, active=$4, icon_img=COALESCE($5, icon_img) WHERE id=$1 RETURNING id", [id, name, int(c.body.sortOrder ?? 0, "Sort order", 0, 9999), c.body.active !== false, icon]);
      if (!r) throw bad("Game not found", 404);
      await audit(A(c), "game_update", `#${id} ${name}`);
      return ok(null, "Game updated");
    },
  },
  {
    method: "DELETE", path: "/admin/games/:id", auth: "admin",
    handler: async (c) => {
      const id = int(c.params.id, "Game");
      const n = await one("SELECT count(*)::int AS n FROM matches WHERE game_id=$1", [id]);
      if (n!.n > 0) throw bad("This game has matches. Delete them first or disable the game instead.");
      await q("DELETE FROM games WHERE id=$1", [id]);
      await audit(A(c), "game_delete", `#${id}`);
      return ok(null, "Game deleted");
    },
  },

  /* ---------------------------------------------------------- matches */
  {
    method: "GET", path: "/admin/matches", auth: "admin",
    handler: async (c) => {
      await autoProgress();
      const sp = c.url.searchParams;
      const rows = await q(
        `${MATCH_SELECT} WHERE ($1::int IS NULL OR m.game_id=$1) AND ($2::text IS NULL OR m.status=$2)
           AND ($3::text IS NULL OR m.title ILIKE $3 OR m.id::text = $4)
         ORDER BY m.start_at DESC, m.id DESC LIMIT 200`,
        [sp.get("gameId") ? parseInt(sp.get("gameId")!, 10) || null : null, sp.get("status") || null, sp.get("q") ? like(sp.get("q")) : null, (sp.get("q") || "").trim()]
      );
      return { matches: rows.map(adminMatch) };
    },
  },
  {
    method: "POST", path: "/admin/matches", auth: "admin",
    handler: async (c) => {
      const f = matchFields(c.body);
      const gid = int(c.body.gameId, "Game");
      if (!(await one("SELECT id FROM games WHERE id=$1", [gid]))) throw bad("Game not found");
      const banner = await optImage(c.body.banner);
      const m = await one(
        `INSERT INTO matches(game_id,title,banner_img,type,version,map,entry_fee,prize_pool,win_prize,per_kill,max_players,start_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [gid, f.title, banner, f.type, f.version, f.map, f.entryFee, f.prizePool, f.winPrize, f.perKill, f.maxPlayers, f.startAt]
      );
      await audit(A(c), "match_create", `#${m!.id} ${f.title}`);
      return ok({ id: m!.id }, "Match created");
    },
  },
  {
    method: "PUT", path: "/admin/matches/:id", auth: "admin",
    handler: async (c) => {
      const id = int(c.params.id, "Match");
      const f = matchFields(c.body);
      const banner = await optImage(c.body.banner);
      await tx(async (cl) => {
        const m = await one("SELECT * FROM matches WHERE id=$1 FOR UPDATE", [id], cl);
        if (!m) throw bad("Match not found", 404);
        if (m.status === "completed" || m.status === "cancelled") throw bad("Finished matches cannot be edited");
        const n = await one("SELECT count(*)::int AS n FROM match_players WHERE match_id=$1", [id], cl);
        if (f.maxPlayers < n!.n) throw bad(`Max players cannot be below joined players (${n!.n})`);
        if (n!.n > 0 && paise(f.entryFee) !== paise(m.entry_fee)) throw bad("Entry fee cannot be changed after players have joined");
        const gid = c.body.gameId ? int(c.body.gameId, "Game") : m.game_id;
        await q(
          `UPDATE matches SET game_id=$2,title=$3,type=$4,version=$5,map=$6,entry_fee=$7,prize_pool=$8,win_prize=$9,per_kill=$10,max_players=$11,start_at=$12,banner_img=COALESCE($13,banner_img) WHERE id=$1`,
          [id, gid, f.title, f.type, f.version, f.map, f.entryFee, f.prizePool, f.winPrize, f.perKill, f.maxPlayers, f.startAt, banner],
          cl
        );
      });
      await audit(A(c), "match_update", `#${id} ${f.title}`);
      return ok(null, "Match updated");
    },
  },
  {
    method: "DELETE", path: "/admin/matches/:id", auth: "admin",
    handler: async (c) => {
      const id = int(c.params.id, "Match");
      await deleteMatch(id);
      await audit(A(c), "match_delete", `#${id}`);
      return ok(null, "Match deleted (entry fees refunded if it was open)");
    },
  },
  {
    method: "POST", path: "/admin/matches/:id/duplicate", auth: "admin",
    handler: async (c) => {
      const id = int(c.params.id, "Match");
      const m = await one(
        `INSERT INTO matches(game_id,title,banner_img,type,version,map,entry_fee,prize_pool,win_prize,per_kill,max_players,start_at)
         SELECT game_id, title || ' (Copy)', banner_img, type, version, map, entry_fee, prize_pool, win_prize, per_kill, max_players, GREATEST(start_at, now() + interval '1 hour')
         FROM matches WHERE id=$1 RETURNING id`,
        [id]
      );
      if (!m) throw bad("Match not found", 404);
      await audit(A(c), "match_duplicate", `#${id} -> #${m.id}`);
      return ok({ id: m.id }, "Match duplicated – edit the date/time");
    },
  },
  {
    method: "POST", path: "/admin/matches/:id/status", auth: "admin",
    handler: async (c) => {
      const id = int(c.params.id, "Match");
      const st = c.body.status;
      if (!["upcoming", "ongoing"].includes(st)) throw bad("Use Submit Result to complete or Cancel to cancel a match");
      const r = await one("UPDATE matches SET status=$2 WHERE id=$1 AND status IN ('upcoming','ongoing') RETURNING id", [id, st]);
      if (!r) throw bad("Match not found or already finished");
      await audit(A(c), "match_status", `#${id} -> ${st}`);
      return ok(null, "Status updated");
    },
  },
  {
    method: "POST", path: "/admin/matches/:id/room", auth: "admin",
    handler: async (c) => {
      const id = int(c.params.id, "Match");
      const roomId = clean(c.body.roomId, 40);
      const pw = clean(c.body.roomPassword, 40);
      const released = bool(c.body.released);
      if (released && !roomId) throw bad("Enter the Room ID before releasing");
      await tx(async (cl) => {
        const m = await one("SELECT * FROM matches WHERE id=$1 FOR UPDATE", [id], cl);
        if (!m) throw bad("Match not found", 404);
        if (m.status === "completed" || m.status === "cancelled") throw bad("Match is finished");
        await q("UPDATE matches SET room_id=$2, room_password=$3, room_released=$4 WHERE id=$1", [id, roomId, pw, released], cl);
        if (released && !m.room_released) {
          const ps = await q("SELECT user_id FROM match_players WHERE match_id=$1", [id], cl);
          for (const p of ps) await notify(p.user_id, "Room details released", `Room ID & password for ${m.title} (Match #${id}) are now available on the match card.`, cl);
        }
      });
      await audit(A(c), "match_room", `#${id} released=${released}`);
      return ok(null, released ? "Room details released to players" : "Room details saved (hidden from players)");
    },
  },
  {
    method: "GET", path: "/admin/matches/:id/players", auth: "admin",
    handler: async (c) => {
      const id = int(c.params.id, "Match");
      const m = await one(`${MATCH_SELECT} WHERE m.id=$1`, [id]);
      if (!m) throw bad("Match not found", 404);
      const rows = await q(
        `SELECT p.*, u.name AS user_name, u.mobile FROM match_players p JOIN users u ON u.id=p.user_id WHERE p.match_id=$1 ORDER BY p.id`,
        [id]
      );
      return {
        match: adminMatch(m),
        players: rows.map((p) => ({ id: p.id, userId: p.user_id, userName: p.user_name, mobile: p.mobile, uid: p.uid, ign: p.ign, joinedAt: p.joined_at, kills: p.kills, winner: p.is_winner, prize: p.prize })),
      };
    },
  },
  {
    method: "DELETE", path: "/admin/matches/:id/players/:pid", auth: "admin",
    handler: async (c) => {
      const r = await removePlayer(int(c.params.id, "Match"), int(c.params.pid, "Player"), clean(c.body.reason, 100));
      await audit(A(c), "match_remove_player", `match #${c.params.id} player #${c.params.pid} refund ₹${r.refunded}`);
      return ok(r, `Player removed. ₹${r.refunded} refunded`);
    },
  },
  {
    method: "POST", path: "/admin/matches/:id/result", auth: "admin",
    handler: async (c) => {
      const id = int(c.params.id, "Match");
      const r = await submitResult(id, c.body.entries);
      await audit(A(c), "match_result", `#${id} winners=${r.winners} paid ₹${r.totalPaid}`);
      return ok(r, `Result submitted. ₹${r.totalPaid} credited to ${r.paidPlayers} player(s)`);
    },
  },
  {
    method: "POST", path: "/admin/matches/:id/cancel", auth: "admin",
    handler: async (c) => {
      const id = int(c.params.id, "Match");
      const r = await cancelMatch(id, clean(c.body.reason, 100));
      await audit(A(c), "match_cancel", `#${id} refunded ₹${r.refunded} to ${r.players}`);
      return ok(r, `Match cancelled. ₹${r.refunded} refunded to ${r.players} player(s)`);
    },
  },

  /* ---------------------------------------------------------- users */
  {
    method: "GET", path: "/admin/users", auth: "admin",
    handler: async (c) => {
      const sp = c.url.searchParams;
      const qs = (sp.get("q") || "").trim();
      const filter = sp.get("filter") || "all";
      const rows = await q(
        `SELECT u.*, (SELECT count(*)::int FROM match_players p WHERE p.match_id IS NOT NULL AND p.user_id=u.id) AS matches
           FROM users u
          WHERE ($1='' OR u.name ILIKE $2 OR u.mobile LIKE $2 OR u.referral_code ILIKE $2 OR u.id::text=$1)
            AND ($3='all' OR ($3='banned' AND u.banned) OR ($3='active' AND NOT u.banned))
          ORDER BY u.id DESC LIMIT 31 OFFSET $4`,
        [qs, like(qs), filter, page(c) * 30]
      );
      const tot = await one("SELECT count(*)::int AS n FROM users");
      return {
        total: tot!.n, more: rows.length > 30,
        users: rows.slice(0, 30).map((u) => ({ id: u.id, name: u.name, mobile: u.mobile, deposit: u.deposit_balance, winning: u.winning_balance, banned: u.banned, matches: u.matches, createdAt: u.created_at, lastActiveAt: u.last_active_at, code: u.referral_code })),
      };
    },
  },
  {
    method: "GET", path: "/admin/users/:id", auth: "admin",
    handler: async (c) => {
      const id = int(c.params.id, "User");
      const u = await one("SELECT * FROM users WHERE id=$1", [id]);
      if (!u) throw bad("User not found", 404);
      const ledger = await q("SELECT * FROM wallet_txns WHERE user_id=$1 ORDER BY id DESC LIMIT 100", [id]);
      const matches = await q(
        `SELECT m.id, m.title, m.status, m.start_at, m.entry_fee, p.uid, p.ign, p.kills, p.prize FROM match_players p JOIN matches m ON m.id=p.match_id WHERE p.user_id=$1 ORDER BY m.start_at DESC LIMIT 50`,
        [id]
      );
      const refs = await q("SELECT r.earned, r.created_at, x.name, x.mobile FROM referrals r JOIN users x ON x.id=r.referred_id WHERE r.referrer_id=$1 ORDER BY r.id DESC LIMIT 100", [id]);
      const by = u.referred_by ? await one("SELECT id, name, mobile FROM users WHERE id=$1", [u.referred_by]) : null;
      const deposits = await q("SELECT * FROM deposits WHERE user_id=$1 ORDER BY id DESC LIMIT 30", [id]);
      const wds = await q("SELECT * FROM withdrawals WHERE user_id=$1 ORDER BY id DESC LIMIT 30", [id]);
      return {
        user: { id: u.id, name: u.name, mobile: u.mobile, deposit: u.deposit_balance, winning: u.winning_balance, banned: u.banned, banReason: u.ban_reason, code: u.referral_code, createdAt: u.created_at, lastActiveAt: u.last_active_at, lastUid: u.last_uid, lastIgn: u.last_ign, deviceId: u.device_id },
        referredBy: by,
        ledger: ledger.map((t) => ({ id: t.id, type: t.type, amount: t.amount, dep: t.dep_delta, win: t.win_delta, depAfter: t.dep_after, winAfter: t.win_after, matchId: t.match_id, note: t.note, at: t.created_at })),
        matches, referrals: refs,
        deposits: deposits.map((d) => ({ orderId: d.order_id, amount: d.amount, status: d.status, at: d.created_at })),
        withdrawals: wds.map((w) => ({ id: w.id, amount: w.amount, final: w.final_amount, status: w.status, at: w.created_at })),
      };
    },
  },
  {
    method: "POST", path: "/admin/users/:id/ban", auth: "admin",
    handler: async (c) => {
      const id = int(c.params.id, "User");
      const banned = bool(c.body.banned);
      const r = await one("UPDATE users SET banned=$2, ban_reason=$3 WHERE id=$1 RETURNING id", [id, banned, banned ? clean(c.body.reason, 100) : ""]);
      if (!r) throw bad("User not found", 404);
      await audit(A(c), banned ? "user_block" : "user_unblock", `#${id} ${clean(c.body.reason, 100)}`);
      return ok(null, banned ? "User blocked" : "User unblocked");
    },
  },
  {
    method: "POST", path: "/admin/users/:id/balance", auth: "admin",
    handler: async (c) => {
      const id = int(c.params.id, "User");
      const action = c.body.action === "deduct" ? "deduct" : "add";
      const bucket = c.body.bucket === "winning" ? "winning" : "deposit";
      const amount = amt(c.body.amount, "Amount", false);
      const reason = reqStr(c.body.reason, "Reason", 3, 150);
      const sign = action === "add" ? 1 : -1;
      const r = await tx(async (cl) => {
        const u = await one("SELECT id FROM users WHERE id=$1 FOR UPDATE", [id], cl);
        if (!u) throw bad("User not found", 404);
        return applyWallet(cl, id, {
          type: action === "add" ? "admin_credit" : "admin_debit",
          dep: bucket === "deposit" ? sign * amount : 0,
          win: bucket === "winning" ? sign * amount : 0,
          ref: `ADM-${A(c)}`,
          note: `Admin ${action} (${bucket}): ${reason}`,
        });
      });
      await audit(A(c), "user_balance", `#${id} ${action} ₹${amount} ${bucket}: ${reason}`);
      return ok(r, `Balance ${action === "add" ? "added" : "deducted"}`);
    },
  },
  {
    method: "POST", path: "/admin/users/:id/reset-password", auth: "admin",
    handler: async (c) => {
      const id = int(c.params.id, "User");
      const pw = vPassword(c.body.password);
      const r = await one("UPDATE users SET password_hash=$2, token_version=token_version+1 WHERE id=$1 RETURNING id", [id, await hashPw(pw)]);
      if (!r) throw bad("User not found", 404);
      await audit(A(c), "user_reset_password", `#${id}`);
      return ok(null, "Password reset. Share the new password with the user.");
    },
  },
  {
    method: "DELETE", path: "/admin/users/:id", auth: "admin",
    handler: async (c) => {
      const id = int(c.params.id, "User");
      await tx(async (cl) => {
        const u = await one("SELECT * FROM users WHERE id=$1 FOR UPDATE", [id], cl);
        if (!u) throw bad("User not found", 404);
        if (u.deposit_balance > 0 || u.winning_balance > 0) throw bad("User still has wallet balance. Deduct it (with a reason) before deleting.");
        const open = await one("SELECT count(*)::int AS n FROM match_players p JOIN matches m ON m.id=p.match_id WHERE p.user_id=$1 AND m.status IN ('upcoming','ongoing')", [id], cl);
        if (open!.n > 0) throw bad("User has joined open matches. Remove them from those matches first.");
        const pend = await one("SELECT count(*)::int AS n FROM withdrawals WHERE user_id=$1 AND status IN ('pending','approved')", [id], cl);
        if (pend!.n > 0) throw bad("User has an unfinished withdrawal.");
        await q("DELETE FROM match_players WHERE user_id=$1", [id], cl);
        await q("DELETE FROM notifications WHERE user_id=$1", [id], cl);
        await q("DELETE FROM referrals WHERE referred_id=$1 OR referrer_id=$1", [id], cl);
        await q("UPDATE users SET referred_by=NULL WHERE referred_by=$1", [id], cl);
        await q("DELETE FROM users WHERE id=$1", [id], cl);
        await audit(A(c), "user_delete", `#${id} ${u.mobile}`, cl);
      });
      return ok(null, "User deleted (ledger history is preserved)");
    },
  },

  /* ---------------------------------------------------------- deposits */
  {
    method: "GET", path: "/admin/deposits", auth: "admin",
    handler: async (c) => {
      const sp = c.url.searchParams;
      const qs = (sp.get("q") || "").trim();
      const rows = await q(
        `SELECT d.*, u.name, u.mobile FROM deposits d JOIN users u ON u.id=d.user_id
          WHERE ($1='all' OR d.status=$1) AND ($2='' OR d.order_id ILIKE $3 OR u.mobile LIKE $3 OR d.utr ILIKE $3 OR u.name ILIKE $3)
          ORDER BY d.id DESC LIMIT 31 OFFSET $4`,
        [sp.get("status") || "all", qs, like(qs), page(c) * 30]
      );
      return {
        more: rows.length > 30,
        deposits: rows.slice(0, 30).map((d) => ({ id: d.id, orderId: d.order_id, userId: d.user_id, name: d.name, mobile: d.mobile, amount: d.amount, status: d.status, utrStatus: d.utr_status, utr: d.utr, note: d.note, at: d.created_at, paidAt: d.paid_at, credited: d.credited })),
      };
    },
  },
  {
    method: "POST", path: "/admin/deposits/:id/refresh", auth: "admin",
    handler: async (c) => {
      const d = await one("SELECT order_id FROM deposits WHERE id=$1", [int(c.params.id, "Deposit")]);
      if (!d) throw bad("Deposit not found", 404);
      const r = await syncDeposit(d.order_id);
      await audit(A(c), "deposit_refresh", `${d.order_id} -> ${r.status}`);
      return ok({ status: r.status, utrStatus: r.utr_status }, `Status: ${r.status} (UTR: ${r.utr_status})`);
    },
  },
  {
    method: "POST", path: "/admin/deposits/:id/approve", auth: "admin",
    handler: async (c) => {
      const d = await one("SELECT order_id, credited FROM deposits WHERE id=$1", [int(c.params.id, "Deposit")]);
      if (!d) throw bad("Deposit not found", 404);
      if (d.credited) throw bad("Already credited");
      const r = await creditDeposit(d.order_id, clean(c.body.utr, 40), `Manually approved by ${A(c)}`);
      await audit(A(c), "deposit_approve", d.order_id);
      return ok(r, r.credited ? "Deposit approved and wallet credited" : "Already credited");
    },
  },
  {
    method: "POST", path: "/admin/deposits/:id/reject", auth: "admin",
    handler: async (c) => {
      const reason = clean(c.body.reason, 100) || "Rejected by admin";
      const r = await one(
        "UPDATE deposits SET status='rejected', note=$2, updated_at=now() WHERE id=$1 AND credited=false AND status IN ('pending','expired','failed') RETURNING order_id",
        [int(c.params.id, "Deposit"), `${reason} (by ${A(c)})`]
      );
      if (!r) throw bad("Deposit cannot be rejected (already credited or finalised)");
      await audit(A(c), "deposit_reject", `${r.order_id}: ${reason}`);
      return ok(null, "Deposit rejected");
    },
  },

  /* ---------------------------------------------------------- withdrawals */
  {
    method: "GET", path: "/admin/withdrawals", auth: "admin",
    handler: async (c) => {
      const sp = c.url.searchParams;
      const qs = (sp.get("q") || "").trim();
      const rows = await q(
        `SELECT w.*, u.name, u.mobile AS user_mobile FROM withdrawals w JOIN users u ON u.id=w.user_id
          WHERE ($1='all' OR w.status=$1) AND ($2='' OR u.mobile LIKE $3 OR u.name ILIKE $3 OR w.upi_id ILIKE $3 OR w.account_no LIKE $3 OR w.id::text=$2)
          ORDER BY w.id DESC LIMIT 31 OFFSET $4`,
        [sp.get("status") || "all", qs, like(qs), page(c) * 30]
      );
      return {
        more: rows.length > 30,
        withdrawals: rows.slice(0, 30).map((w) => ({
          id: w.id, userId: w.user_id, name: w.name, userMobile: w.user_mobile, method: w.method, holder: w.holder_name, accountNo: w.account_no, ifsc: w.ifsc, mobile: w.mobile, upi: w.upi_id,
          amount: w.amount, gstPercent: w.gst_percent, gst: w.gst_amount, finalAmount: w.final_amount, status: w.status, payoutRef: w.payout_ref, reason: w.reason, at: w.created_at,
        })),
      };
    },
  },
  {
    method: "GET", path: "/admin/withdrawals/export", auth: "admin",
    handler: async (c) => {
      const st = c.url.searchParams.get("status") || "all";
      const rows = await q(
        `SELECT w.*, u.name, u.mobile AS user_mobile FROM withdrawals w JOIN users u ON u.id=w.user_id WHERE ($1='all' OR w.status=$1) ORDER BY w.id DESC LIMIT 5000`,
        [st]
      );
      const esc = (v: unknown) => {
        let s = String(v ?? "");
        if (/^[=+\-@]/.test(s)) s = "'" + s; // CSV injection guard
        return `"${s.replace(/"/g, '""')}"`;
      };
      const head = ["ID", "Date (IST)", "User", "User Mobile", "Method", "Holder", "Account No", "IFSC", "Payout Mobile", "UPI", "Amount", "GST %", "GST", "Final Payable", "Status", "Payout Ref", "Reason"];
      const lines = [head.join(",")];
      for (const w of rows) {
        const d = new Date(w.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
        lines.push([w.id, d, w.name, w.user_mobile, w.method, w.holder_name, w.account_no, w.ifsc, w.mobile, w.upi_id, w.amount, w.gst_percent, w.gst_amount, w.final_amount, w.status, w.payout_ref, w.reason].map(esc).join(","));
      }
      await audit(A(c), "withdrawals_export", st);
      return new Response(lines.join("\n"), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=withdrawals.csv", "Cache-Control": "no-store" } });
    },
  },
  {
    method: "POST", path: "/admin/withdrawals/:id/:action", auth: "admin",
    handler: async (c) => {
      const id = int(c.params.id, "Withdrawal");
      const action = c.params.action;
      if (!["approve", "paid", "reject"].includes(action)) throw bad("Invalid action");
      const payoutRef = clean(c.body.payoutRef, 60);
      const reason = clean(c.body.reason, 120);
      if (action === "paid" && payoutRef.length < 3) throw bad("Enter the payout reference / UTR");
      if (action === "reject" && reason.length < 3) throw bad("Enter a rejection reason");
      const msg = await tx(async (cl) => {
        const w = await one("SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE", [id], cl);
        if (!w) throw bad("Withdrawal not found", 404);
        if (action === "approve") {
          if (w.status !== "pending") throw bad(`Already ${w.status}`);
          await q("UPDATE withdrawals SET status='approved', updated_at=now() WHERE id=$1", [id], cl);
          await notify(w.user_id, "Withdrawal approved", `Your withdrawal of ₹${w.amount} is approved and will be paid soon.`, cl);
          return "Withdrawal approved";
        }
        if (action === "paid") {
          if (!["pending", "approved"].includes(w.status)) throw bad(`Already ${w.status}`);
          await q("UPDATE withdrawals SET status='paid', payout_ref=$2, updated_at=now() WHERE id=$1", [id, payoutRef], cl);
          await notify(w.user_id, "Withdrawal paid", `₹${w.final_amount} has been paid to you. Ref: ${payoutRef}`, cl);
          return "Marked as paid";
        }
        if (!["pending", "approved"].includes(w.status)) throw bad(`Already ${w.status}`);
        await q("UPDATE withdrawals SET status='rejected', reason=$2, updated_at=now() WHERE id=$1", [id, reason], cl);
        await applyWallet(cl, w.user_id, { type: "withdrawal_refund", win: w.amount, ref: `WD-${id}-R`, note: `Withdrawal #${id} rejected – refunded${reason ? ": " + reason : ""}` });
        await notify(w.user_id, "Withdrawal rejected", `Your withdrawal of ₹${w.amount} was rejected (${reason}). Amount refunded to your winning balance.`, cl);
        return "Rejected and refunded to winning balance";
      });
      await audit(A(c), `withdrawal_${action}`, `#${id} ${payoutRef || reason}`);
      return ok(null, msg);
    },
  },

  /* ---------------------------------------------------------- referrals */
  {
    method: "GET", path: "/admin/referrals", auth: "admin",
    handler: async () => {
      const t = await one("SELECT count(*)::int AS n, COALESCE(sum(earned),0) AS earned, count(*) FILTER (WHERE earned>0)::int AS paid FROM referrals");
      const top = await q(
        `SELECT u.id, u.name, u.mobile, count(*)::int AS referred, COALESCE(sum(r.earned),0) AS earned
           FROM referrals r JOIN users u ON u.id=r.referrer_id GROUP BY u.id ORDER BY referred DESC, earned DESC LIMIT 50`
      );
      const recent = await q(
        `SELECT r.earned, r.created_at, a.name AS referrer, a.mobile AS referrer_mobile, b.name AS referred, b.mobile AS referred_mobile
           FROM referrals r JOIN users a ON a.id=r.referrer_id JOIN users b ON b.id=r.referred_id ORDER BY r.id DESC LIMIT 100`
      );
      return { totals: { referrals: t!.n, earned: t!.earned, bonusPaid: t!.paid }, top, recent };
    },
  },

  /* ---------------------------------------------------------- settings */
  {
    method: "GET", path: "/admin/settings", auth: "admin",
    handler: async (c) => {
      const s = await getSettings();
      const out: Record<string, string | boolean> = { ...s };
      for (const k of SECRET_KEYS) {
        out[k] = "";
        out[k + "_set"] = !!s[k];
        out[k + "_hint"] = s[k] ? "••••" + s[k].slice(-4) : "";
      }
      const origin = await siteUrl(c.req);
      const logo = parseInt(s.app_logo, 10);
      return { settings: out, logo: Number.isFinite(logo) ? imgUrl(logo) : "", webhookUrl: `${origin}/api/payment/webhook`, redirectUrl: `${origin}/index.html#wallet` };
    },
  },
  {
    method: "PUT", path: "/admin/settings", auth: "admin",
    handler: async (c) => {
      const inb = (c.body.settings || {}) as Row;
      const cur = await getSettings();
      const next: Record<string, string> = {};
      const numKeys = ["gst_percent", "min_deposit", "max_deposit", "min_withdraw", "max_withdraw", "ref_signup_referrer", "ref_signup_referred", "ref_percent", "ref_min_deposit", "ref_max_cap"];
      const textKeys = ["app_name", "app_tagline", "support_whatsapp", "support_telegram", "support_email", "dev_link"];
      const urlKeys = ["otp_base", "pay_base", "site_url"];
      for (const k of numKeys) if (k in inb) next[k] = String(amt(inb[k], k));
      for (const k of textKeys) if (k in inb) next[k] = clean(inb[k], 200);
      for (const k of urlKeys) {
        if (!(k in inb)) continue;
        const v = clean(inb[k], 200);
        if (v && !/^https?:\/\/[^\s]+$/i.test(v)) throw bad(`${k} must be a valid http(s) URL`);
        next[k] = v;
      }
      for (const k of ["support_whatsapp", "support_telegram", "dev_link"]) if (next[k] && !/^https?:\/\//i.test(next[k])) throw bad("Support / developer links must start with http:// or https://");
      if (next.support_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.support_email)) throw bad("Support email is invalid");
      for (const k of ["withdraw_enabled", "maintenance"]) if (k in inb) next[k] = bool(inb[k]) ? "1" : "0";
      if ("ref_percent_mode" in inb) next.ref_percent_mode = inb.ref_percent_mode === "every" ? "every" : "first";
      if ("pay_username" in inb) next.pay_username = clean(inb.pay_username, 100);
      for (const k of SECRET_KEYS) if (typeof inb[k] === "string" && inb[k].trim()) next[k] = clean(inb[k], 200);
      if (!(next.app_name ?? cur.app_name)) throw bad("App name is required");
      const g = parseFloat(next.gst_percent ?? cur.gst_percent);
      if (g > 50) throw bad("GST % cannot exceed 50");
      if (parseFloat(next.ref_percent ?? cur.ref_percent) > 100) throw bad("Referral % cannot exceed 100");
      if (parseFloat(next.min_deposit ?? cur.min_deposit) > parseFloat(next.max_deposit ?? cur.max_deposit)) throw bad("Min deposit cannot exceed max deposit");
      if (parseFloat(next.min_withdraw ?? cur.min_withdraw) > parseFloat(next.max_withdraw ?? cur.max_withdraw)) throw bad("Min withdraw cannot exceed max withdraw");
      if (c.body.logo) next.app_logo = String(await saveImage(c.body.logo, 300 * 1024));
      if (c.body.removeLogo) next.app_logo = "";
      await setSettings(next);
      await audit(A(c), "settings_update", Object.keys(next).map((k) => (SECRET_KEYS.includes(k) ? `${k}=***` : k)).join(", "));
      return ok(null, "Settings saved");
    },
  },

  /* ---------------------------------------------------------- banners / promotions / announcements */
  {
    method: "GET", path: "/admin/banners", auth: "admin",
    handler: async () => {
      const rows = await q("SELECT * FROM banners ORDER BY sort_order, id");
      return { banners: rows.map((b) => ({ id: b.id, image: imgUrl(b.img), link: b.link, sortOrder: b.sort_order, active: b.active })) };
    },
  },
  {
    method: "POST", path: "/admin/banners", auth: "admin",
    handler: async (c) => {
      if (!c.body.image) throw bad("Upload a banner image");
      const img = await saveImage(c.body.image);
      const link = clean(c.body.link, 300);
      if (link && !/^https?:\/\//i.test(link)) throw bad("Link must start with http:// or https://");
      await q("INSERT INTO banners(img,link,sort_order) VALUES($1,$2,$3)", [img, link, int(c.body.sortOrder ?? 0, "Sort order", 0, 9999)]);
      await audit(A(c), "banner_create");
      return ok(null, "Banner added");
    },
  },
  {
    method: "PUT", path: "/admin/banners/:id", auth: "admin",
    handler: async (c) => {
      const link = clean(c.body.link, 300);
      if (link && !/^https?:\/\//i.test(link)) throw bad("Link must start with http:// or https://");
      const img = await optImage(c.body.image);
      const r = await one("UPDATE banners SET link=$2, sort_order=$3, active=$4, img=COALESCE($5,img) WHERE id=$1 RETURNING id", [int(c.params.id, "Banner"), link, int(c.body.sortOrder ?? 0, "Sort order", 0, 9999), c.body.active !== false, img]);
      if (!r) throw bad("Banner not found", 404);
      await audit(A(c), "banner_update", c.params.id);
      return ok(null, "Banner updated");
    },
  },
  {
    method: "DELETE", path: "/admin/banners/:id", auth: "admin",
    handler: async (c) => {
      await q("DELETE FROM banners WHERE id=$1", [int(c.params.id, "Banner")]);
      await audit(A(c), "banner_delete", c.params.id);
      return ok(null, "Banner deleted");
    },
  },
  {
    method: "GET", path: "/admin/promotions", auth: "admin",
    handler: async () => {
      const rows = await q("SELECT * FROM promotions ORDER BY sort_order, id DESC");
      return { promotions: rows.map((p) => ({ id: p.id, title: p.title, body: p.body, image: imgUrl(p.img), link: p.link, sortOrder: p.sort_order, active: p.active })) };
    },
  },
  {
    method: "POST", path: "/admin/promotions", auth: "admin",
    handler: async (c) => {
      const link = clean(c.body.link, 300);
      if (link && !/^https?:\/\//i.test(link)) throw bad("Link must start with http:// or https://");
      const img = await optImage(c.body.image);
      await q("INSERT INTO promotions(title,body,img,link,sort_order) VALUES($1,$2,$3,$4,$5)", [reqStr(c.body.title, "Title", 2, 80), clean(c.body.body, 600), img, link, int(c.body.sortOrder ?? 0, "Sort order", 0, 9999)]);
      await audit(A(c), "promotion_create", clean(c.body.title, 60));
      return ok(null, "Promotion added");
    },
  },
  {
    method: "PUT", path: "/admin/promotions/:id", auth: "admin",
    handler: async (c) => {
      const link = clean(c.body.link, 300);
      if (link && !/^https?:\/\//i.test(link)) throw bad("Link must start with http:// or https://");
      const img = await optImage(c.body.image);
      const r = await one("UPDATE promotions SET title=$2, body=$3, link=$4, sort_order=$5, active=$6, img=COALESCE($7,img) WHERE id=$1 RETURNING id", [int(c.params.id, "Promotion"), reqStr(c.body.title, "Title", 2, 80), clean(c.body.body, 600), link, int(c.body.sortOrder ?? 0, "Sort order", 0, 9999), c.body.active !== false, img]);
      if (!r) throw bad("Promotion not found", 404);
      await audit(A(c), "promotion_update", c.params.id);
      return ok(null, "Promotion updated");
    },
  },
  {
    method: "DELETE", path: "/admin/promotions/:id", auth: "admin",
    handler: async (c) => {
      await q("DELETE FROM promotions WHERE id=$1", [int(c.params.id, "Promotion")]);
      await audit(A(c), "promotion_delete", c.params.id);
      return ok(null, "Promotion deleted");
    },
  },
  {
    method: "GET", path: "/admin/announcements", auth: "admin",
    handler: async () => ({ announcements: await q("SELECT id, title, body, active, created_at FROM announcements ORDER BY id DESC LIMIT 100") }),
  },
  {
    method: "POST", path: "/admin/announcements", auth: "admin",
    handler: async (c) => {
      const title = reqStr(c.body.title, "Title", 2, 100);
      const body = clean(c.body.body, 1000);
      await tx(async (cl) => {
        await q("INSERT INTO announcements(title,body) VALUES($1,$2)", [title, body], cl);
        if (bool(c.body.notifyAll)) await q("INSERT INTO notifications(user_id,title,body) SELECT id,$1,$2 FROM users WHERE banned=false", [title, body], cl);
      });
      await audit(A(c), "announcement_create", title);
      return ok(null, bool(c.body.notifyAll) ? "Announcement published and pushed to all users" : "Announcement published");
    },
  },
  {
    method: "PUT", path: "/admin/announcements/:id", auth: "admin",
    handler: async (c) => {
      const r = await one("UPDATE announcements SET title=$2, body=$3, active=$4 WHERE id=$1 RETURNING id", [int(c.params.id, "Announcement"), reqStr(c.body.title, "Title", 2, 100), clean(c.body.body, 1000), c.body.active !== false]);
      if (!r) throw bad("Announcement not found", 404);
      await audit(A(c), "announcement_update", c.params.id);
      return ok(null, "Announcement updated");
    },
  },
  {
    method: "DELETE", path: "/admin/announcements/:id", auth: "admin",
    handler: async (c) => {
      await q("DELETE FROM announcements WHERE id=$1", [int(c.params.id, "Announcement")]);
      await audit(A(c), "announcement_delete", c.params.id);
      return ok(null, "Announcement deleted");
    },
  },

  /* ---------------------------------------------------------- leaderboard */
  {
    method: "GET", path: "/admin/leaderboard", auth: "admin",
    handler: async (c) => {
      const p = ["daily", "weekly", "all"].includes(c.url.searchParams.get("period") || "") ? (c.url.searchParams.get("period") as string) : "daily";
      const s = await getSettings();
      return { period: p, rows: await leaderboardRows(p), dailyResetAt: s.lb_daily_reset_at || null };
    },
  },
  {
    method: "POST", path: "/admin/leaderboard/reset-daily", auth: "admin",
    handler: async (c) => {
      await setSettings({ lb_daily_reset_at: new Date().toISOString() });
      await audit(A(c), "leaderboard_reset_daily");
      return ok(null, "Daily leaderboard reset (wallet history is untouched)");
    },
  },

  /* ---------------------------------------------------------- logs */
  {
    method: "GET", path: "/admin/logs/ledger", auth: "admin",
    handler: async (c) => {
      const sp = c.url.searchParams;
      const qs = (sp.get("q") || "").trim();
      const type = sp.get("type") || "all";
      const rows = await q(
        `SELECT t.*, u.name, u.mobile FROM wallet_txns t LEFT JOIN users u ON u.id=t.user_id
          WHERE ($1='all' OR t.type=$1) AND ($2='' OR u.mobile LIKE $3 OR u.name ILIKE $3 OR t.ref ILIKE $3 OR t.note ILIKE $3 OR t.user_id::text=$2 OR t.match_id::text=$2)
          ORDER BY t.id DESC LIMIT 51 OFFSET $4`,
        [type, qs, like(qs), page(c) * 50]
      );
      return {
        more: rows.length > 50,
        rows: rows.slice(0, 50).map((t) => ({ id: t.id, userId: t.user_id, name: t.name, mobile: t.mobile, type: t.type, amount: t.amount, dep: t.dep_delta, win: t.win_delta, depAfter: t.dep_after, winAfter: t.win_after, matchId: t.match_id, ref: t.ref, note: t.note, at: t.created_at })),
      };
    },
  },
  {
    method: "GET", path: "/admin/logs/audit", auth: "admin",
    handler: async (c) => {
      const qs = (c.url.searchParams.get("q") || "").trim();
      const rows = await q("SELECT * FROM audit_logs WHERE ($1='' OR action ILIKE $2 OR details ILIKE $2 OR admin ILIKE $2) ORDER BY id DESC LIMIT 51 OFFSET $3", [qs, like(qs), page(c) * 50]);
      return { more: rows.length > 50, rows: rows.slice(0, 50) };
    },
  },
  {
    method: "GET", path: "/admin/logs/otp", auth: "admin",
    handler: async (c) => {
      const qs = (c.url.searchParams.get("q") || "").trim();
      const rows = await q("SELECT * FROM otp_logs WHERE ($1='' OR mobile LIKE $2 OR ip LIKE $2) ORDER BY id DESC LIMIT 51 OFFSET $3", [qs, like(qs), page(c) * 50]);
      return { more: rows.length > 50, rows: rows.slice(0, 50) };
    },
  },
];

// referenced to avoid unused import lint noise when mobile validation is extended
void vMobile;
