import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  numeric,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

const money = (name: string) => numeric(name, { precision: 12, scale: 2 });
const ts = (name: string) => timestamp(name, { withTimezone: true });

/** key/value settings (admin editable). Secrets live here too, never sent to browsers. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull().default(""),
});

export const admins = pgTable("admins", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  tokenVersion: integer("token_version").notNull().default(0),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const images = pgTable("images", {
  id: serial("id").primaryKey(),
  mime: text("mime").notNull(),
  data: text("data").notNull(), // base64
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    mobile: text("mobile").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    avatar: text("avatar").notNull().default(""),
    referralCode: text("referral_code").notNull().unique(),
    referredBy: integer("referred_by"),
    depositBalance: money("deposit_balance").notNull().default("0"),
    winningBalance: money("winning_balance").notNull().default("0"),
    banned: boolean("banned").notNull().default(false),
    banReason: text("ban_reason").notNull().default(""),
    deviceId: text("device_id").notNull().default(""),
    lastUid: text("last_uid").notNull().default(""),
    lastIgn: text("last_ign").notNull().default(""),
    tokenVersion: integer("token_version").notNull().default(0),
    createdAt: ts("created_at").notNull().defaultNow(),
    lastActiveAt: ts("last_active_at").notNull().defaultNow(),
  },
  (t) => [index("users_device_idx").on(t.deviceId)]
);

/** Immutable ledger (UPDATE/DELETE blocked by DB trigger created in server init). */
export const walletTxns = pgTable(
  "wallet_txns",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    type: text("type").notNull(), // deposit|entry_fee|win|referral_bonus|withdrawal|withdrawal_refund|refund|admin_credit|admin_debit
    amount: money("amount").notNull(), // always positive
    depDelta: money("dep_delta").notNull().default("0"),
    winDelta: money("win_delta").notNull().default("0"),
    depAfter: money("dep_after").notNull().default("0"),
    winAfter: money("win_after").notNull().default("0"),
    matchId: integer("match_id"),
    ref: text("ref").notNull().default(""),
    note: text("note").notNull().default(""),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("wtx_user_idx").on(t.userId, t.createdAt),
    index("wtx_type_idx").on(t.type, t.createdAt),
  ]
);

export const games = pgTable("games", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  iconImg: integer("icon_img"),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const matches = pgTable(
  "matches",
  {
    id: serial("id").primaryKey(),
    gameId: integer("game_id").notNull(),
    title: text("title").notNull(),
    bannerImg: integer("banner_img"),
    type: text("type").notNull().default("Solo"),
    version: text("version").notNull().default("TPP"),
    map: text("map").notNull().default(""),
    entryFee: money("entry_fee").notNull().default("0"),
    prizePool: money("prize_pool").notNull().default("0"),
    winPrize: money("win_prize").notNull().default("0"),
    perKill: money("per_kill").notNull().default("0"),
    maxPlayers: integer("max_players").notNull().default(48),
    startAt: ts("start_at").notNull(),
    status: text("status").notNull().default("upcoming"), // upcoming|ongoing|completed|cancelled
    roomId: text("room_id").notNull().default(""),
    roomPassword: text("room_password").notNull().default(""),
    roomReleased: boolean("room_released").notNull().default(false),
    resultSubmitted: boolean("result_submitted").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("matches_game_idx").on(t.gameId, t.status)]
);

export const matchPlayers = pgTable(
  "match_players",
  {
    id: serial("id").primaryKey(),
    matchId: integer("match_id").notNull(),
    userId: integer("user_id").notNull(),
    uid: text("uid").notNull(),
    ign: text("ign").notNull(),
    kills: integer("kills").notNull().default(0),
    isWinner: boolean("is_winner").notNull().default(false),
    prize: money("prize").notNull().default("0"),
    joinedAt: ts("joined_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("mp_match_user").on(t.matchId, t.userId),
    uniqueIndex("mp_match_uid").on(t.matchId, t.uid),
    index("mp_user_idx").on(t.userId),
  ]
);

export const deposits = pgTable(
  "deposits",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    orderId: text("order_id").notNull().unique(),
    amount: money("amount").notNull(),
    status: text("status").notNull().default("pending"), // pending|success|failed|expired|rejected
    utrStatus: text("utr_status").notNull().default("none"),
    utr: text("utr").notNull().default(""),
    payUrl: text("pay_url").notNull().default(""),
    providerRaw: text("provider_raw").notNull().default(""),
    credited: boolean("credited").notNull().default(false),
    note: text("note").notNull().default(""),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    paidAt: ts("paid_at"),
  },
  (t) => [index("dep_user_idx").on(t.userId, t.createdAt)]
);

export const withdrawals = pgTable(
  "withdrawals",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    method: text("method").notNull(), // bank|upi
    holderName: text("holder_name").notNull().default(""),
    accountNo: text("account_no").notNull().default(""),
    ifsc: text("ifsc").notNull().default(""),
    mobile: text("mobile").notNull().default(""),
    upiId: text("upi_id").notNull().default(""),
    amount: money("amount").notNull(),
    gstPercent: numeric("gst_percent", { precision: 5, scale: 2 }).notNull().default("0"),
    gstAmount: money("gst_amount").notNull().default("0"),
    finalAmount: money("final_amount").notNull(),
    status: text("status").notNull().default("pending"), // pending|approved|paid|rejected
    payoutRef: text("payout_ref").notNull().default(""),
    reason: text("reason").notNull().default(""),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("wd_user_idx").on(t.userId, t.createdAt)]
);

export const referrals = pgTable("referrals", {
  id: serial("id").primaryKey(),
  referrerId: integer("referrer_id").notNull(),
  referredId: integer("referred_id").notNull().unique(),
  referrerBonusPaid: boolean("referrer_bonus_paid").notNull().default(false),
  earned: money("earned").notNull().default("0"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const banners = pgTable("banners", {
  id: serial("id").primaryKey(),
  img: integer("img").notNull(),
  link: text("link").notNull().default(""),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
});

export const promotions = pgTable("promotions", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  img: integer("img"),
  link: text("link").notNull().default(""),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const announcements = pgTable("announcements", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  active: boolean("active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const notifications = pgTable(
  "notifications",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    read: boolean("read").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("notif_user_idx").on(t.userId, t.createdAt)]
);

export const otpSessions = pgTable(
  "otp_sessions",
  {
    id: serial("id").primaryKey(),
    mobile: text("mobile").notNull(),
    purpose: text("purpose").notNull(), // register|reset
    sendCount: integer("send_count").notNull().default(0),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
    lastSentAt: ts("last_sent_at"),
    expiresAt: ts("expires_at"),
    attempts: integer("attempts").notNull().default(0),
  },
  (t) => [uniqueIndex("otp_mobile_purpose").on(t.mobile, t.purpose)]
);

export const otpLogs = pgTable("otp_logs", {
  id: serial("id").primaryKey(),
  mobile: text("mobile").notNull(),
  purpose: text("purpose").notNull(),
  action: text("action").notNull(), // send|verify
  success: boolean("success").notNull().default(false),
  ip: text("ip").notNull().default(""),
  raw: text("raw").notNull().default(""),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  admin: text("admin").notNull(),
  action: text("action").notNull(),
  details: text("details").notNull().default(""),
  createdAt: ts("created_at").notNull().defaultNow(),
});
