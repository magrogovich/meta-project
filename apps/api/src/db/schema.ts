import { pgTable, uuid, text, timestamp, integer, real, jsonb, boolean } from "drizzle-orm/pg-core";

export const orgs = pgTable("orgs", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  settings: jsonb("settings").$type<{ coaching?: { scoreBelow?: number; dropPoints?: number; criticalCount?: number; qaTarget?: number; passThreshold?: number }; quality?: { qaTarget?: number; passThreshold?: number; scoreBelow?: number; dropPoints?: number; criticalCount?: number }; languages?: string[]; retentionDays?: number }>().notNull().default({}),
  createdAt: timestamp("created_at").defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id").notNull().references(() => orgs.id),
  email: text("email").notNull(),
  name: text("name").notNull().default(""),
  passwordHash: text("password_hash").notNull().default(""),
  role: text("role").notNull().default("admin"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const invites = pgTable("invites", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id").notNull().references(() => orgs.id),
  email: text("email").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const employees = pgTable("employees", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id").notNull().references(() => orgs.id),
  name: text("name").notNull(),
  photo: text("photo").notNull().default(""),
  department: text("department").notNull().default("Support"),
  languages: jsonb("languages").$type<string[]>().notNull().default([]),
  startDate: text("start_date").notNull().default(""),
  sessionKeyHash: text("session_key_hash").notNull().default(""),
  sessionKeyPrefix: text("session_key_prefix").notNull().default(""),
  sessionKeyEnc: text("session_key_enc").notNull().default(""),
  sessionKeyHmac: text("session_key_hmac").notNull().default(""),
  sessionKeyRevoked: boolean("session_key_revoked").notNull().default(false),
  status: text("status").notNull().default("active"),
  overallScore: real("overall_score").notNull().default(0),
  agentStatus: text("agent_status").notNull().default("never"),
  agentQueue: integer("agent_queue").notNull().default(0),
  lastSeen: timestamp("last_seen"),
  agentVersion: text("agent_version").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
});

export const calls = pgTable("calls", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id").notNull().references(() => orgs.id),
  employeeId: uuid("employee_id").notNull().references(() => employees.id),
  startedAt: timestamp("started_at").defaultNow(),
  durationSec: integer("duration_sec").notNull().default(0),
  language: text("language").notNull().default("en"),
  audioFile: text("audio_file").notNull().default(""),
  status: text("status").notNull().default("uploaded"),
  transcript: jsonb("transcript").$type<{ speaker: string; text: string; start: number; end: number }[]>().notNull().default([]),
  score: real("score").notNull().default(0),
  criteriaVersion: integer("criteria_version").notNull().default(1),
  clientCallId: text("client_call_id"),
  guidelineRefs: jsonb("guideline_refs").$type<Record<string, number>>().notNull().default({}),
  summary: text("summary").notNull().default(""),
  wentWell: jsonb("went_well").$type<string[]>().notNull().default([]),
  wentWrong: jsonb("went_wrong").$type<string[]>().notNull().default([]),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  sentimentStart: text("sentiment_start").notNull().default(""),
  sentimentEnd: text("sentiment_end").notNull().default(""),
  sentimentStartQuote: text("sentiment_start_quote").notNull().default(""),
  sentimentEndQuote: text("sentiment_end_quote").notNull().default(""),
  sentimentStartAt: real("sentiment_start_at").notNull().default(0),
  sentimentEndAt: real("sentiment_end_at").notNull().default(0),
  issueResolved: text("issue_resolved").notNull().default(""),
  issueResolvedQuote: text("issue_resolved_quote").notNull().default(""),
  issueResolvedAt: real("issue_resolved_at").notNull().default(0),
  supervisorRequested: boolean("supervisor_requested").notNull().default(false),
  supervisorQuote: text("supervisor_quote").notNull().default(""),
  supervisorAt: real("supervisor_at").notNull().default(0),
  talkRatio: real("talk_ratio"),
  deadAirPct: real("dead_air_pct"),
  interruptions: integer("interruptions").notNull().default(0),
  agentWpm: real("agent_wpm"),
});

export const criterionResults = pgTable("criterion_results", {
  id: uuid("id").defaultRandom().primaryKey(),
  callId: uuid("call_id").notNull().references(() => calls.id),
  criterionId: text("criterion_id").notNull(),
  criterionName: text("criterion_name").notNull().default(""),
  result: text("result").notNull(),
  score: real("score").notNull().default(0),
  evidenceQuote: text("evidence_quote").notNull().default(""),
  evidenceStart: real("evidence_start").notNull().default(0),
  guidelineRef: text("guideline_ref").notNull().default(""),
});

export const memos = pgTable("memos", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id").notNull().references(() => orgs.id),
  employeeId: uuid("employee_id").notNull().references(() => employees.id),
  periodFrom: text("period_from").notNull().default(""),
  periodTo: text("period_to").notNull().default(""),
  content: jsonb("content").$type<any>().notNull().default({}),
  createdAt: timestamp("created_at").defaultNow(),
});

export const coachingSessions = pgTable("coaching_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id").notNull().references(() => orgs.id),
  employeeId: uuid("employee_id").notNull().references(() => employees.id),
  memoId: uuid("memo_id").references(() => memos.id),
  topics: text("topics").notNull().default(""),
  transcript: jsonb("transcript").$type<{ role: string; text: string; at: string }[]>().notNull().default([]),
  summary: text("summary").notNull().default(""),
  actionItems: jsonb("action_items").$type<string[]>().notNull().default([]),
  humanFlag: boolean("human_flag").notNull().default(false),
  token: text("token").notNull().default(""),
  transport: text("transport").notNull().default("meet"),
  meetSpaceName: text("meet_space_name").notNull().default(""),
  meetUrl: text("meet_url").notNull().default(""),
  status: text("status").notNull().default("waiting_for_employee"),
  startedAt: timestamp("started_at"),
  endedAt: timestamp("ended_at"),
  botError: text("bot_error").notNull().default(""),
  ttsChars: integer("tts_chars").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export const coachingTurns = pgTable("coaching_turns", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").notNull().references(() => coachingSessions.id),
  idx: integer("idx").notNull().default(0),
  role: text("role").notNull().default("employee"),
  text: text("text").notNull().default(""),
  interrupted: boolean("interrupted").notNull().default(false),
  audioMs: integer("audio_ms").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export const googleIntegrations = pgTable("google_integrations", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id").notNull().references(() => orgs.id).unique(),
  email: text("email").notNull().default(""),
  accessEnc: text("access_enc").notNull().default(""),
  refreshEnc: text("refresh_enc").notNull().default(""),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const departments = pgTable("departments", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id").notNull().references(() => orgs.id),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const guidelines = pgTable("guidelines", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id").notNull().references(() => orgs.id),
  title: text("title").notNull(),
  status: text("status").notNull().default("draft"),
  currentVersion: integer("current_version").notNull().default(1),
  mandatorySections: jsonb("mandatory_sections").$type<string[]>().notNull().default([]),
  createdBy: text("created_by").notNull().default(""),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const guidelineVersions = pgTable("guideline_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  guidelineId: uuid("guideline_id").notNull().references(() => guidelines.id),
  version: integer("version").notNull(),
  markdown: text("markdown").notNull(),
  contentHash: text("content_hash").notNull(),
  sections: jsonb("sections").$type<{ id: string; path: string; level: number; title: string }[]>().notNull().default([]),
  createdBy: text("created_by").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
});

export const criteriaSets = pgTable("criteria_sets", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id").notNull().references(() => orgs.id),
  version: integer("version").notNull(),
  status: text("status").notNull().default("draft"),
  criteria: jsonb("criteria").$type<{ id: string; name: string; description: string; weight: number; mustPass?: boolean; guidance: string; guidelineRefs?: string[] }[]>().notNull(),
  guidelineRefs: jsonb("guideline_refs").$type<Record<string, number>>().notNull().default({}),
  stale: boolean("stale").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const actionItems = pgTable("action_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id").notNull().references(() => orgs.id),
  employeeId: uuid("employee_id").notNull().references(() => employees.id),
  text: text("text").notNull(),
  status: text("status").notNull().default("open"),
  source: text("source").notNull().default("coach"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const auditLog = pgTable("audit_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id").notNull().references(() => orgs.id),
  userId: text("user_id").notNull().default(""),
  action: text("action").notNull(),
  callId: text("call_id").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
});
