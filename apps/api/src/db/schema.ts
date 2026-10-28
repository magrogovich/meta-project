import { pgTable, uuid, text, timestamp, integer, real, jsonb, boolean } from "drizzle-orm/pg-core";

export const orgs = pgTable("orgs", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
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
  status: text("status").notNull().default("active"),
  overallScore: real("overall_score").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export const scorecards = pgTable("scorecards", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id").notNull().references(() => orgs.id),
  version: integer("version").notNull(),
  criteria: jsonb("criteria").$type<{ id: string; name: string; description: string; weight: number; guidance: string }[]>().notNull(),
  sourceText: text("source_text").notNull().default(""),
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
  scorecardVersion: integer("scorecard_version").notNull().default(1),
  summary: text("summary").notNull().default(""),
  wentWell: jsonb("went_well").$type<string[]>().notNull().default([]),
  wentWrong: jsonb("went_wrong").$type<string[]>().notNull().default([]),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
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
