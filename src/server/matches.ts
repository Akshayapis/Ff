/**
 * Match engine: join, result (win-split + per-kill), cancel, remove-player.
 * Every operation is a single DB transaction with the match row locked (FOR UPDATE),
 * so double join / double result / double refund are impossible.
 */
import { bad, one, q, tx, notify, imgUrl, paise, rupees, clean, type Row } from "./core";
import { applyWallet, spendEntryFee, refundEntryFee } from "./wallet";

export const STATUS_GROUPS: Record<string, string[]> = {
  upcoming: ["upcoming"],
  ongoing: ["ongoing"],
  completed: ["completed", "cancelled"],
};

/** Equal split rounded DOWN to 2 decimals. 100 / 3 => 33.33 */
export function splitPrize(total: number, winners: number): number {
  if (winners <= 0) return 0;
  return rupees(Math.floor(paise(total) / winners));
}

export function matchDTO(m: Row, mine?: boolean) {
  const joined = Number(m.joined ?? 0);
  return {
    id: m.id,
    gameId: m.game_id,
    gameName: m.game_name,
    title: m.title,
    banner: imgUrl(m.banner_img),
    type: m.type,
    version: m.version,
    map: m.map,
    entryFee: m.entry_fee,
    prizePool: m.prize_pool,
    winPrize: m.win_prize,
    perKill: m.per_kill,
    maxPlayers: m.max_players,
    joined,
    spotsLeft: Math.max(0, m.max_players - joined),
    startAt: m.start_at,
    status: m.status,
    joinedByMe: !!mine,
    room: mine && m.room_released && m.room_id ? { roomId: m.room_id, password: m.room_password } : null,
    roomPending: !!mine && !(m.room_released && m.room_id) && (m.status === "upcoming" || m.status === "ongoing"),
  };
}

export async function joinMatch(userId: number, matchId: number, uidIn: unknown, ignIn: unknown) {
  const uid = clean(uidIn, 20);
  const ign = clean(ignIn, 30);
  if (!/^\d{5,15}$/.test(uid)) throw bad("Enter a valid Free Fire UID (5-15 digits)");
  if (ign.length < 2) throw bad("Enter your in-game name (min 2 characters)");
  return tx(async (c) => {
    const m = await one("SELECT * FROM matches WHERE id=$1 FOR UPDATE", [matchId], c);
    if (!m) throw bad("Match not found", 404);
    if (m.status !== "upcoming" || new Date(m.start_at).getTime() <= Date.now()) throw bad("Joining is closed for this match");
    const already = await one("SELECT id FROM match_players WHERE match_id=$1 AND user_id=$2", [matchId, userId], c);
    if (already) throw bad("You have already joined this match");
    const dupUid = await one("SELECT id FROM match_players WHERE match_id=$1 AND uid=$2", [matchId, uid], c);
    if (dupUid) throw bad("This UID has already joined this match");
    const cnt = await one("SELECT count(*)::int AS n FROM match_players WHERE match_id=$1", [matchId], c);
    if (cnt!.n >= m.max_players) throw bad("Match is full");
    await spendEntryFee(c, userId, m.entry_fee, matchId, `Entry fee – ${m.title} (Match #${matchId})`);
    await q("INSERT INTO match_players(match_id,user_id,uid,ign) VALUES($1,$2,$3,$4)", [matchId, userId, uid, ign], c);
    await q("UPDATE users SET last_uid=$2, last_ign=$3 WHERE id=$1", [userId, uid, ign], c);
    const bal = await one("SELECT deposit_balance, winning_balance FROM users WHERE id=$1", [userId], c);
    return { joined: cnt!.n + 1, balance: bal!.deposit_balance + bal!.winning_balance };
  });
}

export interface ResultEntry {
  playerId: number;
  kills: number;
  winner: boolean;
}

export async function submitResult(matchId: number, entriesIn: unknown) {
  if (!Array.isArray(entriesIn)) throw bad("Invalid result data");
  return tx(async (c) => {
    const m = await one("SELECT * FROM matches WHERE id=$1 FOR UPDATE", [matchId], c);
    if (!m) throw bad("Match not found", 404);
    if (m.result_submitted || m.status === "completed") throw bad("Result already submitted for this match");
    if (m.status === "cancelled") throw bad("This match was cancelled");
    const players = await q("SELECT * FROM match_players WHERE match_id=$1 ORDER BY id FOR UPDATE", [matchId], c);
    if (players.length === 0) throw bad("No players joined this match");
    const byId = new Map<number, Row>(players.map((p) => [p.id, p]));
    const entries = new Map<number, ResultEntry>();
    for (const e of entriesIn as Row[]) {
      const pid = Number(e?.playerId);
      if (!byId.has(pid)) throw bad("Result contains a player who is not in this match");
      const kills = Number(e?.kills ?? 0);
      if (!Number.isInteger(kills) || kills < 0 || kills > 200) throw bad("Kills must be a whole number between 0 and 200");
      entries.set(pid, { playerId: pid, kills, winner: e?.winner === true });
    }
    const winners = [...entries.values()].filter((e) => e.winner);
    if (m.win_prize > 0 && winners.length === 0) throw bad("Select at least one winner for the win prize");
    const share = m.win_prize > 0 ? splitPrize(m.win_prize, winners.length) : 0;

    let totalPaid = 0;
    const lines: { userId: number; prize: number }[] = [];
    for (const p of players) {
      const e = entries.get(p.id);
      const kills = e?.kills ?? 0;
      const isWinner = !!e?.winner;
      const prizeP = (isWinner ? paise(share) : 0) + kills * paise(m.per_kill);
      const prize = rupees(prizeP);
      await q("UPDATE match_players SET kills=$2, is_winner=$3, prize=$4 WHERE id=$1", [p.id, kills, isWinner, prize], c);
      if (prizeP > 0) {
        const parts: string[] = [];
        if (isWinner && share > 0) parts.push(`win ₹${share}`);
        if (kills > 0 && m.per_kill > 0) parts.push(`${kills} kills × ₹${m.per_kill}`);
        await applyWallet(c, p.user_id, {
          type: "win",
          win: prize,
          matchId,
          ref: `M${matchId}`,
          note: `Winnings – ${m.title} (Match #${matchId}): ${parts.join(" + ")}`,
        });
        totalPaid += prizeP;
        await notify(p.user_id, "🏆 You won!", `You won ₹${prize} in ${m.title} (Match #${matchId}). Added to your winning balance.`, c);
      } else {
        await notify(p.user_id, "Result declared", `Result of ${m.title} (Match #${matchId}) is out. Check the Completed tab.`, c);
      }
      lines.push({ userId: p.user_id, prize });
    }
    await q("UPDATE matches SET status='completed', result_submitted=true WHERE id=$1", [matchId], c);
    return { winners: winners.length, sharePerWinner: share, totalPaid: rupees(totalPaid), paidPlayers: lines.filter((l) => l.prize > 0).length };
  });
}

/** Cancel a match and refund every entry fee. */
export async function cancelMatch(matchId: number, reason: string) {
  return tx(async (c) => {
    const m = await one("SELECT * FROM matches WHERE id=$1 FOR UPDATE", [matchId], c);
    if (!m) throw bad("Match not found", 404);
    if (m.status === "completed" || m.result_submitted) throw bad("Completed matches cannot be cancelled");
    if (m.status === "cancelled") throw bad("Match is already cancelled");
    const players = await q("SELECT * FROM match_players WHERE match_id=$1 FOR UPDATE", [matchId], c);
    let refunded = 0;
    for (const p of players) {
      const r = await refundEntryFee(c, p.user_id, matchId, `Refund – ${m.title} (Match #${matchId}) cancelled`);
      refunded += paise(r);
      await notify(p.user_id, "Match cancelled", `${m.title} (Match #${matchId}) was cancelled${reason ? ": " + reason : ""}. Entry fee refunded.`, c);
    }
    await q("UPDATE matches SET status='cancelled', room_released=false WHERE id=$1", [matchId], c);
    return { players: players.length, refunded: rupees(refunded) };
  });
}

export async function removePlayer(matchId: number, playerId: number, reason: string) {
  return tx(async (c) => {
    const m = await one("SELECT * FROM matches WHERE id=$1 FOR UPDATE", [matchId], c);
    if (!m) throw bad("Match not found", 404);
    if (m.status === "completed" || m.result_submitted) throw bad("Cannot remove players after the result is submitted");
    if (m.status === "cancelled") throw bad("Match is cancelled (all fees already refunded)");
    const p = await one("SELECT * FROM match_players WHERE id=$1 AND match_id=$2 FOR UPDATE", [playerId, matchId], c);
    if (!p) throw bad("Player not found", 404);
    const refunded = await refundEntryFee(c, p.user_id, matchId, `Refund – removed from ${m.title} (Match #${matchId})`);
    await q("DELETE FROM match_players WHERE id=$1", [playerId], c);
    await notify(p.user_id, "Removed from match", `You were removed from ${m.title} (Match #${matchId})${reason ? ": " + reason : ""}. Entry fee refunded.`, c);
    return { refunded };
  });
}

/** Delete a match; open matches with players are refunded first. */
export async function deleteMatch(matchId: number) {
  return tx(async (c) => {
    const m = await one("SELECT * FROM matches WHERE id=$1 FOR UPDATE", [matchId], c);
    if (!m) throw bad("Match not found", 404);
    if (m.status === "upcoming" || m.status === "ongoing") {
      const players = await q("SELECT * FROM match_players WHERE match_id=$1 FOR UPDATE", [matchId], c);
      for (const p of players) {
        await refundEntryFee(c, p.user_id, matchId, `Refund – ${m.title} (Match #${matchId}) deleted`);
        await notify(p.user_id, "Match cancelled", `${m.title} (Match #${matchId}) was removed. Entry fee refunded.`, c);
      }
    }
    await q("DELETE FROM match_players WHERE match_id=$1", [matchId], c);
    await q("DELETE FROM matches WHERE id=$1", [matchId], c);
  });
}
