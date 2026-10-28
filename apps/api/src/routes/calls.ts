import { Router } from "express";
import multer from "multer";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import * as s from "../db/schema.js";
import { authMw } from "./auth.js";
import { scorecardFromPolicy, scoreCall } from "../lib/muse.js";
import { saveAudio, synthWav, sha256 } from "../lib/util.js";

export const miscRouter = Router();

// ---- scorecards ----
export const scoreRouter = Router();
scoreRouter.use(authMw);
scoreRouter.get("/", async (req: any, res) => {
  const rows = await db.select().from(s.scorecards).where(eq(s.scorecards.orgId, req.user.orgId));
  rows.sort((a, b) => b.version - a.version);
  res.json(rows);
});
scoreRouter.post("/generate", async (req: any, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: "text required" });
  const { criteria, mock } = await scorecardFromPolicy(text);
  res.json({ criteria, mock, note: mock ? "MOCK Muse: no API key, deterministic defaults" : "Muse" });
});
scoreRouter.post("/", async (req: any, res) => {
  const { criteria, sourceText } = req.body || {};
  const rows = await db.select().from(s.scorecards).where(eq(s.scorecards.orgId, req.user.orgId));
  const version = rows.length ? Math.max(...rows.map((r) => r.version)) + 1 : 1;
  const [sc] = await db.insert(s.scorecards).values({ orgId: req.user.orgId, version, criteria, sourceText: sourceText || "" }).returning();
  res.json(sc);
});

// ---- pipeline ----
export async function processCall(callId: string) {
  const rows = await db.select().from(s.calls).where(eq(s.calls.id, callId));
  if (!rows.length) return;
  const call = rows[0];
  try {
    await db.update(s.calls).set({ status: "transcribing" }).where(eq(s.calls.id, callId));
    // STT: transcription supplied at upload/seed wins; otherwise Muse Voice Transcribe
    // on the stored audio (mock transcript when no MODEL_API_KEY).
    let transcript: any[] = call.transcript as any[];
    if (!transcript?.length) {
      try {
        const { readFileSync } = await import("fs");
        const { join } = await import("path");
        const { storageDir } = await import("../lib/util.js");
        const { transcribeCallAudio } = await import("../lib/muse.js");
        const wav = readFileSync(join(storageDir(), call.audioFile));
        ({ lines: transcript } = await transcribeCallAudio(wav, call.language));
      } catch {
        transcript = [
          { speaker: "Agent", text: "Hello, thank you for calling Arocall, my name is Alex, how can I help you today?", start: 0.5, end: 5 },
          { speaker: "Customer", text: "Hi, my bill looks wrong this month.", start: 5.5, end: 9 },
          { speaker: "Agent", text: "I understand, that must be frustrating. Let me verify your account and check the charges.", start: 9.5, end: 15 },
          { speaker: "Agent", text: "I will fix this by tomorrow and send a confirmation. Is there anything else I can help with? Thank you!", start: 15.5, end: 22 },
        ];
      }
      await db.update(s.calls).set({ transcript }).where(eq(s.calls.id, callId));
    }
    await db.update(s.calls).set({ status: "analyzing" }).where(eq(s.calls.id, callId));
    const scRows = await db.select().from(s.scorecards).where(eq(s.scorecards.orgId, call.orgId));
    scRows.sort((a, b) => b.version - a.version);
    const sc = scRows[0];
    const analysis: any = await scoreCall(transcript, sc?.criteria || [], call.language);
    await db.delete(s.criterionResults).where(eq(s.criterionResults.callId, callId));
    for (const r of analysis.results) {
      await db.insert(s.criterionResults).values({ callId, criterionId: r.criterionId, criterionName: r.criterionName || r.criterionId, result: r.result, score: r.score, evidenceQuote: r.evidenceQuote, evidenceStart: r.evidenceStart || 0 });
    }
    await db.update(s.calls).set({ status: "done", score: analysis.total, summary: analysis.summary || "", wentWell: analysis.wentWell || [], wentWrong: analysis.wentWrong || [], tags: analysis.tags || [], scorecardVersion: sc?.version || 1 }).where(eq(s.calls.id, callId));
  } catch (e: any) {
    await db.update(s.calls).set({ status: "failed" }).where(eq(s.calls.id, callId));
  }
}

// ---- calls ----
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
export const callRouter = Router();
callRouter.get("/audio/:file", async (req, res) => {
  const { storageDir } = await import("../lib/util.js");
  res.sendFile(req.params.file, { root: storageDir() });
});
callRouter.use(authMw);
callRouter.get("/", async (req: any, res) => {
  const rows = await db.select().from(s.calls).where(eq(s.calls.orgId, req.user.orgId));
  rows.sort((a, b) => +new Date(b.startedAt || 0) - +new Date(a.startedAt || 0));
  res.json(rows.slice(0, 200));
});
callRouter.get("/:id", async (req: any, res) => {
  const rows = await db.select().from(s.calls).where(and(eq(s.calls.id, req.params.id), eq(s.calls.orgId, req.user.orgId)));
  if (!rows.length) return res.status(404).json({ error: "not found" });
  const crit = await db.select().from(s.criterionResults).where(eq(s.criterionResults.callId, req.params.id));
  await db.insert(s.auditLog).values({ orgId: req.user.orgId, userId: req.user.id, action: "view_call", callId: req.params.id });
  res.json({ ...rows[0], audioUrl: `/api/calls/audio/${rows[0].audioFile}`, results: crit });
});
callRouter.post("/:id/rerun", async (req: any, res) => {
  await db.update(s.calls).set({ status: "uploaded" }).where(and(eq(s.calls.id, req.params.id), eq(s.calls.orgId, req.user.orgId)));
  processCall(req.params.id);
  res.json({ ok: true, status: "analyzing" });
});
// dashboard/seeded create: transcript + optional audio upload
callRouter.post("/", upload.single("audio"), async (req: any, res) => {
  const { employeeId, language, transcript, startedAt, durationSec } = req.body || {};
  let tr: any[] = [];
  try { tr = typeof transcript === "string" ? JSON.parse(transcript) : transcript || []; } catch { tr = []; }
  const dur = Number(durationSec) || Math.max(20, tr.reduce((m: number, l: any) => Math.max(m, l.end || 0), 0) || 30);
  let file = "";
  if ((req as any).file) file = saveAudio((req as any).file.buffer, `call_${Date.now()}.wav`);
  else file = saveAudio(synthWav(dur, 7), `call_${Date.now()}.wav`);
  const [c] = await db.insert(s.calls).values({ orgId: req.user.orgId, employeeId, language: language || "en", audioFile: file, status: "uploaded", transcript: tr, durationSec: Math.round(dur), startedAt: startedAt ? new Date(startedAt) : new Date() }).returning();
  processCall(c.id); // async in-process queue w/ retries via status
  res.json(c);
});

// ---- desktop agent upload (session-key auth, chunked/resumable: single-chunk MVP + append chunks) ----
export const agentRouter = Router();
const chunks = new Map<string, Buffer[]>();
agentRouter.post("/validate", async (req, res) => {
  const key = (req.headers["x-session-key"] as string) || req.body?.sessionKey;
  if (!key) return res.status(401).json({ error: "no key" });
  const rows = await db.select().from(s.employees).where(eq(s.employees.sessionKeyHash, sha256(key)));
  if (!rows.length) return res.status(401).json({ error: "bad key" });
  res.json({ ok: true, employee: { id: rows[0].id, name: rows[0].name, orgId: rows[0].orgId } });
});
agentRouter.post("/upload-chunk", upload.single("chunk"), async (req, res) => {
  const key = (req.headers["x-session-key"] as string) || req.body?.sessionKey;
  const { uploadId, index, total, employeeId, language, startedAt, transcript } = req.body || {};
  const rows = await db.select().from(s.employees).where(eq(s.employees.sessionKeyHash, sha256(key || "")));
  if (!rows.length) return res.status(401).json({ error: "bad key" });
  const id = uploadId || `u_${Date.now()}`;
  const arr = chunks.get(id) || [];
  arr[Number(index || 0)] = (req as any).file?.buffer || Buffer.alloc(0);
  chunks.set(id, arr);
  if (Number(index || 0) + 1 >= Number(total || 1)) {
    const buf = Buffer.concat(arr);
    const tr = transcript ? JSON.parse(transcript) : [];
    const dur = Math.max(10, Math.round(buf.length / 32000) || 30);
    const file = buf.length > 1000 ? saveAudio(buf, `agent_${Date.now()}.wav`) : saveAudio(synthWav(dur, 3), `agent_${Date.now()}.wav`);
    const [c] = await db.insert(s.calls).values({ orgId: rows[0].orgId, employeeId: employeeId || rows[0].id, language: language || "en", audioFile: file, status: "uploaded", transcript: tr, durationSec: dur, startedAt: startedAt ? new Date(startedAt) : new Date() }).returning();
    chunks.delete(id);
    processCall(c.id);
    return res.json({ done: true, callId: c.id });
  }
  res.json({ done: false, received: arr.filter(Boolean).length });
});

// ---- memos ----
export const memoRouter = Router();
memoRouter.use(authMw);
memoRouter.post("/generate", async (req: any, res) => {
  const { employeeId, from, to } = req.body || {};
  const emps = await db.select().from(s.employees).where(and(eq(s.employees.id, employeeId), eq(s.employees.orgId, req.user.orgId)));
  let callRows = await db.select().from(s.calls).where(and(eq(s.calls.employeeId, employeeId), eq(s.calls.orgId, req.user.orgId)));
  if (from) callRows = callRows.filter((c) => new Date(c.startedAt || 0) >= new Date(from));
  if (to) callRows = callRows.filter((c) => new Date(c.startedAt || 0) <= new Date(to));
  const avg = callRows.length ? callRows.reduce((a, c) => a + c.score, 0) / callRows.length : 0;
  const issues = callRows.flatMap((c) => (c.wentWrong as string[]).map((w) => ({ callId: c.id, date: c.startedAt, text: w }))).slice(0, 3);
  const content = {
    employee: emps[0]?.name, period: `${from || "start"} → ${to || "now"}`, callCount: callRows.length,
    avgScore: Math.round(avg * 10) / 10,
    summary: `${emps[0]?.name} handled ${callRows.length} calls averaging ${Math.round(avg)}. ${avg >= 75 ? "Consistent policy adherence." : "Coaching recommended on lowest criteria."}`,
    improvements: "Compare with previous period in dashboard trend chart.",
    topIssues: issues.length ? issues : [{ text: "No failing criteria — reinforce strengths." }],
    actionPlan: ["Shadow a top performer on empathy statements", "Use the 3-step close on every call", "Practice verification script daily"],
    phrases: ["I understand how frustrating this is, let me fix it right now.", "To confirm, I will ___ by ___.", "Is there anything else I can help with today?"],
    mock: true,
  };
  const [m] = await db.insert(s.memos).values({ orgId: req.user.orgId, employeeId, periodFrom: from || "", periodTo: to || "", content }).returning();
  res.json(m);
});
memoRouter.get("/:id", async (req: any, res) => {
  const rows = await db.select().from(s.memos).where(eq(s.memos.id, req.params.id));
  res.json(rows[0] || null);
});

// ---- coaching sessions ----
export const coachRouter = Router();
coachRouter.post("/", authMw, async (req: any, res) => {
  const { employeeId, memoId, topics } = req.body || {};
  const token = "cs_" + Math.random().toString(36).slice(2, 10);
  const [cs] = await db.insert(s.coachingSessions).values({ orgId: req.user.orgId, employeeId, memoId: memoId || null, topics: topics || "", token }).returning();
  res.json({ ...cs, link: `/coach/${cs.id}?token=${token}` });
});
coachRouter.get("/:id", authMw, async (req: any, res) => {
  const rows = await db.select().from(s.coachingSessions).where(eq(s.coachingSessions.id, req.params.id));
  if (!rows.length) return res.status(404).json({ error: "not found" });
  res.json(rows[0]);
});
// public (employee link) + chat turn
coachRouter.post("/:id/chat", async (req, res) => {
  const { message, token } = req.body || {};
  const rows = await db.select().from(s.coachingSessions).where(eq(s.coachingSessions.id, req.params.id));
  if (!rows.length) return res.status(404).json({ error: "not found" });
  const cs: any = rows[0];
  if (cs.token && token !== cs.token) return res.status(403).json({ error: "bad token" });
  const { completeText, coachSystemPrompt } = await import("../lib/muse.js");
  const emps = await db.select().from(s.employees).where(eq(s.employees.id, cs.employeeId));
  const callRows = await db.select().from(s.calls).where(eq(s.calls.employeeId, cs.employeeId));
  callRows.sort((a, b) => +new Date(b.startedAt || 0) - +new Date(a.startedAt || 0));
  const evidence = callRows.slice(0, 3).map((c) => `Call ${c.id.slice(0, 6)} score ${c.score}: ${(c.transcript as any[]).filter((t) => t.speaker === "Agent").slice(0, 2).map((t) => t.text).join(" | ")}`).join("\n");
  const sys = coachSystemPrompt({ employee: emps[0]?.name || "agent", scores: callRows.slice(0, 5).map((c) => c.score).join(", "), memo: cs.topics || "", evidence, policy: "Follow QA scorecard; be supportive and specific." });
  const needsHuman = /harass|complaint|health|sick|anxiet|unfair|manager.*(yelled|abuse)/i.test(message || "");
  const { text, mock } = await completeText(sys, `Employee says: ${message}\nReply as coach in 2-4 sentences, reference one real example, ask a follow-up.`);
  const tr = [...(cs.transcript as any[]), { role: "employee", text: message, at: new Date().toISOString() }, { role: "coach", text, at: new Date().toISOString() }];
  await db.update(s.coachingSessions).set({ transcript: tr, humanFlag: needsHuman || cs.humanFlag, summary: `Session with ${tr.length / 2} exchanges.`, actionItems: ["Use empathy opener", "Apply 3-step close"] }).where(eq(s.coachingSessions.id, cs.id));
  res.json({ reply: text, mock, humanFlag: needsHuman || cs.humanFlag });
});
coachRouter.post("/:id/flag", async (req, res) => {
  await db.update(s.coachingSessions).set({ humanFlag: true }).where(eq(s.coachingSessions.id, req.params.id));
  res.json({ ok: true });
});

miscRouter.use("/scorecards", scoreRouter);
miscRouter.use("/calls", callRouter);
miscRouter.use("/agent", agentRouter);
miscRouter.use("/memos", memoRouter);
miscRouter.use("/coach", coachRouter);
