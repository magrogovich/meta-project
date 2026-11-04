import { Router } from "express";
import multer from "multer";
import { eq, and, desc, or } from "drizzle-orm";
import { db } from "../db/client.js";
import * as s from "../db/schema.js";
import { authMw } from "./auth.js";
import { scoreCall } from "../lib/muse.js";
import { saveAudio, synthWav } from "../lib/util.js";

export const miscRouter = Router();

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
    // Scoring context: active guidelines (full or mandatory-only by token budget)
    // + the approved criteria set (defaults if none approved yet).
    const { estimateTokens } = await import("../lib/guidelines.js");
    const BUDGET = Number(process.env.GUIDELINE_TOKEN_BUDGET || 60000);
    const gDocs = await db.select().from(s.guidelines).where(and(eq(s.guidelines.orgId, call.orgId), eq(s.guidelines.status, "active")));
    let guidelinesText = "", guidelineRefs: Record<string, number> = {};
    if (gDocs.length) {
      const parts: { title: string; markdown: string }[] = [];
      let tokens = 0;
      for (const d of gDocs) {
        const vers = await db.select().from(s.guidelineVersions).where(eq(s.guidelineVersions.guidelineId, d.id));
        vers.sort((a, b) => b.version - a.version);
        const md = vers[0]?.markdown || "";
        guidelineRefs[d.id] = d.currentVersion;
        const t = estimateTokens(md);
        tokens += t;
        parts.push({ title: d.title, markdown: md, mandatory: d.mandatorySections } as any);
      }
      if (tokens <= BUDGET) {
        guidelinesText = parts.map((p) => `# ${p.title}\n${p.markdown}`).join("\n\n---\n\n");
      } else {
        // mandatory-only mode: keep must-have sections (+ their headings for context)
        const { splitSections } = await import("../lib/guidelines.js");
        guidelinesText = parts.map((p: any) => {
          const secs = splitSections(p.markdown);
          const keep = secs.filter((x) => (p.mandatory as string[]).includes(x.id));
          const src = keep.length ? keep : secs.slice(0, 2);
          return `# ${p.title} (mandatory excerpt)\n` + src.map((x) => `${"#".repeat(x.level)} ${x.title}\n${x.body}`).join("\n\n");
        }).join("\n\n---\n\n");
      }
    }
    const critSets = await db.select().from(s.criteriaSets).where(eq(s.criteriaSets.orgId, call.orgId));
    critSets.sort((a, b) => b.version - a.version);
    const approved = critSets.find((x) => x.status === "approved") || null;
    let criteria: any[], criteriaVersion = 1;
    if (approved) { criteria = approved.criteria as any[]; criteriaVersion = approved.version; }
    else criteria = (await import("../lib/muse.js")).DEFAULT_CRITERIA;
    const analysis: any = await scoreCall(transcript, criteria, call.language, guidelinesText);
    await db.delete(s.criterionResults).where(eq(s.criterionResults.callId, callId));
    for (const r of analysis.results) {
      await db.insert(s.criterionResults).values({ callId, criterionId: r.criterionId, criterionName: r.criterionName || r.criterionId, result: r.result, score: r.score, evidenceQuote: r.evidenceQuote, evidenceStart: r.evidenceStart || 0, guidelineRef: r.guidelineRef || "" });
    }
    const { computeConversationMetrics } = await import("../lib/conversation.js");
    const conv = computeConversationMetrics(transcript, call.durationSec || Math.max(1, Math.round(transcript.reduce((m: number, l: any) => Math.max(m, l.end || 0), 0))));
    await db.update(s.calls).set({
      status: "done", score: analysis.total, summary: analysis.summary || "",
      wentWell: analysis.wentWell || [], wentWrong: analysis.wentWrong || [], tags: analysis.tags || [],
      criteriaVersion, guidelineRefs,
      sentimentStart: analysis.customerSentimentStart || "", sentimentEnd: analysis.customerSentimentEnd || "",
      sentimentStartQuote: analysis.customerSentimentStartQuote || "", sentimentEndQuote: analysis.customerSentimentEndQuote || "",
      sentimentStartAt: analysis.customerSentimentStartAt || 0, sentimentEndAt: analysis.customerSentimentEndAt || 0,
      issueResolved: analysis.issueResolved || "", issueResolvedQuote: analysis.issueResolvedQuote || "", issueResolvedAt: analysis.issueResolvedAt || 0,
      supervisorRequested: !!analysis.customerRequestedSupervisor, supervisorQuote: analysis.supervisorQuote || "", supervisorAt: analysis.supervisorAt || 0,
      talkRatio: conv.talkRatio, deadAirPct: conv.deadAirPct, interruptions: conv.interruptions, agentWpm: conv.agentWpm,
    }).where(eq(s.calls.id, callId));
  } catch (e: any) {
    await db.update(s.calls).set({ status: "failed" }).where(eq(s.calls.id, callId));
  }
}

// ---- calls ----
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
export const callRouter = Router();
callRouter.get("/audio/:file", async (req, res) => {
  const { storageDir } = await import("../lib/util.js");
  const { join } = await import("path");
  const { existsSync, readFileSync, writeFileSync } = await import("fs");
  // ?mix=mono serves a centered mono mix (agent + customer in both ears).
  // The stored split-track stereo is untouched — the pipeline still labels
  // speakers by channel. Mixed output is cached next to the original.
  if (req.query.mix === "mono") {
    try {
      const dir = storageDir();
      const cached = `${req.params.file}.mono.wav`;
      if (!existsSync(join(dir, cached))) {
        const { parseWav, encodeWav } = await import("../lib/audio.js");
        const info = parseWav(readFileSync(join(dir, req.params.file)));
        if (info.channels !== 2 || info.bits !== 16) throw new Error("not stereo PCM");
        const n = Math.floor(info.data.length / 4);
        const mixed = Buffer.alloc(n * 2);
        for (let i = 0; i < n; i++) {
          const l = info.data.readInt16LE(i * 4), r = info.data.readInt16LE(i * 4 + 2);
          mixed.writeInt16LE(Math.round((l + r) / 2), i * 2);
        }
        writeFileSync(join(dir, cached), encodeWav(mixed, info.sampleRate, 1, 16));
      }
      return res.sendFile(cached, { root: dir });
    } catch {
      // Anything unexpected (e.g. non-PCM upload): fall back to the original.
    }
  }
  res.sendFile(req.params.file, { root: storageDir() });
});
callRouter.use(authMw);
callRouter.get("/search", async (req: any, res) => {
  const { from, to, employeeId, dept, lang, min, max, critical, failed, failCrit, page, limit, sort, order } = req.query as any;
  const orgId = req.user.orgId;
  let emps = await db.select().from(s.employees).where(eq(s.employees.orgId, orgId));
  if (dept) emps = emps.filter((e) => e.department === dept);
  const empIds = new Set(emps.map((e) => e.id));
  const empName: Record<string, string> = {};
  const empDept: Record<string, string> = {};
  for (const e of emps) { empName[e.id] = e.name; empDept[e.id] = e.department; }
  let rows = await db.select().from(s.calls).where(eq(s.calls.orgId, orgId));
  rows = rows.filter((c) => empIds.has(c.employeeId));
  if (from) rows = rows.filter((c) => new Date(c.startedAt || 0) >= new Date(from));
  if (to) rows = rows.filter((c) => new Date(c.startedAt || 0) <= new Date(to));
  if (employeeId) rows = rows.filter((c) => c.employeeId === employeeId);
  if (lang) rows = rows.filter((c) => c.language === lang);
  if (min !== undefined && min !== "") rows = rows.filter((c) => c.score >= Number(min));
  if (max !== undefined && max !== "") rows = rows.filter((c) => c.score <= Number(max));
  if (failed === "1" || failed === "true") rows = rows.filter((c) => c.status === "failed");
  // critical = done + fail on a must-pass criterion
  const { mustPassIds } = await import("../lib/context.js");
  const mustIds = await mustPassIds(orgId);
  const crit = await db.select().from(s.criterionResults);
  const critByCall: Record<string, typeof crit> = {};
  for (const r of crit) (critByCall[r.callId] = critByCall[r.callId] || []).push(r);
  const isCritical = (cid: string) => (critByCall[cid] || []).some((r) => r.result === "fail" && mustIds.has(r.criterionId));
  if (critical === "1" || critical === "true") rows = rows.filter((c) => c.status === "done" && isCritical(c.id));
  if (failCrit) rows = rows.filter((c) => (critByCall[c.id] || []).some((r) => r.criterionId === failCrit && r.result === "fail"));
  if (employeeId && failCrit) rows = rows.filter((c) => c.employeeId === employeeId);
  const withFlags = rows.map((c) => ({
    ...c,
    employeeName: empName[c.employeeId] || "—",
    department: empDept[c.employeeId] || "—",
    flags: [
      ...(c.status === "failed" ? ["failed"] : []),
      ...(c.status === "done" && isCritical(c.id) ? ["critical"] : []),
      ...(c.status === "done" && c.score < 60 ? ["low"] : []),
    ],
  }));
  const key = sort === "score" ? "score" : sort === "duration" ? "durationSec" : "startedAt";
  const dir = order === "asc" ? 1 : -1;
  withFlags.sort((a: any, b: any) => {
    const av = key === "startedAt" ? +new Date(a[key] || 0) : a[key];
    const bv = key === "startedAt" ? +new Date(b[key] || 0) : b[key];
    return (av - bv) * dir;
  });
  const pg = Math.max(1, Number(page) || 1);
  const lim = Math.min(100, Math.max(5, Number(limit) || 20));
  res.json({ total: withFlags.length, page: pg, limit: lim, rows: withFlags.slice((pg - 1) * lim, pg * lim) });
});
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
// re-run analysis over a date range (e.g. after guidelines change)
callRouter.post("/rerun-range", async (req: any, res) => {
  const { from, to, employeeId } = req.body || {};
  let rows = await db.select().from(s.calls).where(eq(s.calls.orgId, req.user.orgId));
  if (from) rows = rows.filter((c) => new Date(c.startedAt || 0) >= new Date(from));
  if (to) rows = rows.filter((c) => new Date(c.startedAt || 0) <= new Date(to));
  if (employeeId) rows = rows.filter((c) => c.employeeId === employeeId);
  for (const c of rows) {
    await db.update(s.calls).set({ status: "uploaded" }).where(eq(s.calls.id, c.id));
    await processCall(c.id);
  }
  res.json({ ok: true, count: rows.length });
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
// Key auth: HMAC lookup tag (new encrypted keys) with legacy sha256 fallback.
// Revoked keys get a distinct error so the agent shows a clear error state.
// The key grants upload rights for that employee's calls ONLY — no read access.
async function findEmployeeByKey(key: string) {
  const { keyTag } = await import("../lib/keys.js");
  const { sha256 } = await import("../lib/util.js");
  const rows = await db.select().from(s.employees).where(or(eq(s.employees.sessionKeyHmac, keyTag(key || "")), eq(s.employees.sessionKeyHash, sha256(key || ""))));
  return rows[0] || null;
}
agentRouter.post("/validate", async (req, res) => {
  const key = (req.headers["x-session-key"] as string) || req.body?.sessionKey;
  if (!key) return res.status(401).json({ error: "no key" });
  const emp = await findEmployeeByKey(key);
  if (!emp) return res.status(401).json({ error: "bad key" });
  if (emp.sessionKeyRevoked) return res.status(403).json({ error: "key_revoked", message: "This session key was revoked by an admin. Ask for a new key." });
  res.json({ ok: true, employee: { id: emp.id, name: emp.name, orgId: emp.orgId } });
});
// Heartbeat: agent status every 60s -> dashboard online/offline + last seen.
agentRouter.post("/heartbeat", async (req, res) => {
  const key = (req.headers["x-session-key"] as string) || req.body?.sessionKey;
  const emp = await findEmployeeByKey(key || "");
  if (!emp) return res.status(401).json({ error: "bad key" });
  if (emp.sessionKeyRevoked) return res.status(403).json({ error: "key_revoked" });
  const { status, version, queueSize } = req.body || {};
  await db.update(s.employees).set({
    lastSeen: new Date(),
    agentStatus: status === "paused" ? "offline" : "online",
    agentVersion: version || emp.agentVersion || "",
    agentQueue: Math.max(0, Number(queueSize) || 0),
  }).where(eq(s.employees.id, emp.id));
  res.json({ ok: true });
});

// Two-track call upload (Opus or WAV per track) + metadata, idempotent on call_id.
// Merges to stereo WAV (Agent=L, Customer=R) and creates the Call as "uploaded"
// so the existing pipeline picks it up.
const tracksUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 32 * 1024 * 1024 } });
agentRouter.post("/calls", tracksUpload.fields([{ name: "agent_track", maxCount: 1 }, { name: "customer_track", maxCount: 1 }]), async (req, res) => {
  const key = (req.headers["x-session-key"] as string) || req.body?.sessionKey;
  const emp = await findEmployeeByKey(key || "");
  if (!emp) return res.status(401).json({ error: "bad key" });
  if (emp.sessionKeyRevoked) return res.status(403).json({ error: "key_revoked", message: "This session key was revoked by an admin. Ask for a new key." });
  let meta: any = {};
  try { meta = JSON.parse(req.body?.metadata || "{}"); } catch { return res.status(400).json({ error: "bad metadata JSON" }); }
  if (!meta.call_id) return res.status(400).json({ error: "metadata.call_id required" });
  const files = (req as any).files || {};
  const agentTrack = files.agent_track?.[0]?.buffer, customerTrack = files.customer_track?.[0]?.buffer;
  if (!agentTrack || !customerTrack) return res.status(400).json({ error: "agent_track + customer_track required" });
  const dup = await db.select().from(s.calls).where(eq(s.calls.clientCallId, String(meta.call_id)));
  if (dup.length) return res.json({ done: true, duplicate: true, callId: dup[0].id });
  let stereo: Buffer;
  try {
    const { tracksToStereo } = await import("../lib/audio.js");
    stereo = tracksToStereo(agentTrack, customerTrack);
  } catch (e: any) {
    // No ffmpeg and non-WAV input: store the agent track raw; the pipeline
    // falls back to its mock transcript path (labeled in the UI).
    stereo = agentTrack;
  }
  const file = saveAudio(stereo, `call_${Date.now()}.wav`);
  const dur = Math.max(1, Math.round(Number(meta.duration_sec) || 0));
  const [c] = await db.insert(s.calls).values({
    orgId: emp.orgId, employeeId: emp.id, language: meta.language || "en", audioFile: file,
    status: "uploaded", transcript: [], durationSec: dur,
    startedAt: meta.start_time ? new Date(meta.start_time * 1000) : new Date(),
    clientCallId: String(meta.call_id),
  }).returning();
  await db.update(s.employees).set({ lastSeen: new Date(), agentStatus: "online", agentVersion: meta.agent_version || emp.agentVersion || "" }).where(eq(s.employees.id, emp.id));
  processCall(c.id);
  res.json({ done: true, duplicate: false, callId: c.id });
});

agentRouter.post("/upload-chunk", upload.single("chunk"), async (req, res) => {  const key = (req.headers["x-session-key"] as string) || req.body?.sessionKey;
  const { uploadId, index, total, employeeId, language, startedAt, transcript } = req.body || {};
  const emp = await findEmployeeByKey(key || "");
  if (!emp) return res.status(401).json({ error: "bad key" });
  if (emp.sessionKeyRevoked) return res.status(403).json({ error: "key_revoked", message: "This session key was revoked by an admin. Ask for a new key." });
  // The key is scoped: it may only upload for its own employee.
  if (employeeId && employeeId !== emp.id) return res.status(403).json({ error: "key scoped to another employee" });
  const rows = [emp];
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
    await db.update(s.employees).set({ lastSeen: new Date(), agentStatus: "online", agentVersion: (req.headers["x-agent-version"] as string) || "" }).where(eq(s.employees.id, employeeId || rows[0].id));
    chunks.delete(id);
    processCall(c.id);
    return res.json({ done: true, callId: c.id });
  }
  res.json({ done: false, received: arr.filter(Boolean).length });
});

// ---- dashboard summary: replaced by routes/dashboard.ts (dedicated endpoints) ----
export const dashRouter = Router();

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
memoRouter.get("/", async (req: any, res) => {
  const { employeeId } = req.query as any;
  let rows = await db.select().from(s.memos).where(eq(s.memos.orgId, req.user.orgId));
  if (employeeId) rows = rows.filter((m) => m.employeeId === employeeId);
  rows.sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0));
  res.json(rows);
});
memoRouter.patch("/:id", async (req: any, res) => {
  const { content } = req.body || {};
  const rows = await db.select().from(s.memos).where(eq(s.memos.id, req.params.id));
  if (!rows.length || rows[0].orgId !== req.user.orgId) return res.status(404).json({ error: "not found" });
  const [m] = await db.update(s.memos).set({ content: { ...(rows[0].content as object), ...(content || {}) } }).where(eq(s.memos.id, req.params.id)).returning();
  res.json(m);
});
memoRouter.get("/:id", async (req: any, res) => {
  const rows = await db.select().from(s.memos).where(eq(s.memos.id, req.params.id));
  if (!rows.length || rows[0].orgId !== req.user.orgId) return res.status(404).json({ error: "not found" });
  res.json(rows[0]);
});

// ---- coaching sessions (Meet transport + inapp fallback) ----
export const coachRouter = Router();

// Create: admin only. Autonomous flow — auto-creates the Meet space (with token
// refresh), stores the employee email, sends the invite email with both links,
// and queues the bot (instant) or parks until the scheduled time. Manual link
// is only a fallback. Transport from COACH_TRANSPORT unless overridden.
coachRouter.post("/", authMw, async (req: any, res) => {
  const { employeeId, memoId, topics, meetUrl: manualUrl, transport, email, scheduledAt, sendInvite } = req.body || {};
  if (!employeeId) return res.status(400).json({ error: "employeeId required" });
  const emps = await db.select().from(s.employees).where(and(eq(s.employees.id, employeeId), eq(s.employees.orgId, req.user.orgId)));
  if (!emps.length) return res.status(404).json({ error: "employee not found" });
  const { coachEnv, transportFor, resolveInitialStatus } = await import("../lib/coach.js");
  const { isValidEmail, sendCoachingInvite } = await import("../lib/mailer.js");
  const t = (transport || coachEnv.transport) as "meet" | "inapp";
  const token = "cs_" + Math.random().toString(36).slice(2, 10);
  // Employee email: explicit field wins, else stored employee email.
  const inviteTo = String(email || (emps[0] as any).email || "").trim();
  if (email !== undefined && isValidEmail(email)) {
    await db.update(s.employees).set({ email: email.trim() }).where(eq(s.employees.id, employeeId));
  }
  let meetUrl = String(manualUrl || "");
  let spaceName = "";
  let meetError = "";
  if (t === "meet" && !meetUrl) {
    // Auto-create via Meet REST API (refreshes expired tokens). Errors surface
    // to the UI instead of failing silently.
    try {
      const { orgAccessToken, createMeetSpace } = await import("../lib/meet.js");
      const access = await orgAccessToken(db, s, req.user.orgId);
      const r = await createMeetSpace(access);
      meetUrl = r.url; spaceName = r.name;
    } catch (e: any) {
      // Network/DNS failures surface as bare "fetch failed" — spell out the cause.
      const msg = String(e?.message || "meet_create_failed");
      meetError = (/fetch failed/i.test(msg)
        ? "network: API server could not reach meet.googleapis.com (no internet / DNS / firewall / proxy). Check outbound HTTPS from the API machine."
        : msg).slice(0, 400);
      console.error(`[meet] spaces.create failed: ${msg} ${e?.cause ? `cause=${JSON.stringify(String(e.cause)).slice(0, 200)}` : ""}`);
    }
  }
  const { status, at } = t === "meet" ? resolveInitialStatus(scheduledAt) : { status: "live" as const, at: null };
  const [cs] = await db.insert(s.coachingSessions).values({
    orgId: req.user.orgId, employeeId, memoId: memoId || null, topics: topics || "", token,
    transport: t, meetUrl, meetSpaceName: spaceName, meetError,
    status, scheduledAt: at, inviteEmail: inviteTo,
    startedAt: t === "inapp" ? new Date() : null,
  }).returning();
  // Invite email with the Meet link only (instant or scheduled). The coaching
  // room stays private to the platform — the employee never receives it.
  let invite: any = { sent: false, reason: "no_email" };
  const when = at ? at.toLocaleString() : "";
  if (t === "meet" && meetUrl && isValidEmail(inviteTo) && sendInvite !== false) {
    const orgName = (await db.select().from(s.orgs).where(eq(s.orgs.id, req.user.orgId)))[0]?.name || "Arocall";
    invite = await sendCoachingInvite(inviteTo, {
      employeeName: emps[0].name, orgName,
      meetUrl, when, topics: topics || "",
    });
    if (invite.sent) await db.update(s.coachingSessions).set({ inviteSentAt: new Date() }).where(eq(s.coachingSessions.id, cs.id));
  }
  try { transportFor(t).startSession(cs.id, meetUrl); } catch { /* queued */ }
  await db.insert(s.auditLog).values({ orgId: req.user.orgId, userId: req.user.id, action: `coach_start:${t}`, callId: employeeId });
  res.json({ ...cs, link: `/coach-room/${cs.id}`, needsMeetLink: t === "meet" && !meetUrl, invite });
});
// Resend the invite email for a session (admin).
coachRouter.post("/:id/invite", authMw, async (req: any, res) => {
  const { email } = req.body || {};
  const rows = await db.select().from(s.coachingSessions).where(eq(s.coachingSessions.id, req.params.id));
  if (!rows.length || (rows[0] as any).orgId !== req.user.orgId) return res.status(404).json({ error: "not found" });
  const cs: any = rows[0];
  if (!cs.meetUrl) return res.status(400).json({ error: "no Meet link yet" });
  const { isValidEmail, sendCoachingInvite } = await import("../lib/mailer.js");
  const to = String(email || cs.inviteEmail || "").trim();
  if (!isValidEmail(to)) return res.status(400).json({ error: "valid employee email required" });
  const orgName = (await db.select().from(s.orgs).where(eq(s.orgs.id, req.user.orgId)))[0]?.name || "Arocall";
  const emps = await db.select().from(s.employees).where(eq(s.employees.id, cs.employeeId));
  const invite = await sendCoachingInvite(to, {
    employeeName: emps[0]?.name || "there", orgName,
    meetUrl: cs.meetUrl,
    when: cs.scheduledAt ? new Date(cs.scheduledAt).toLocaleString() : "", topics: cs.topics || "",
  });
  if (invite.sent) await db.update(s.coachingSessions).set({ inviteSentAt: new Date(), inviteEmail: to }).where(eq(s.coachingSessions.id, cs.id));
  res.json({ invite });
});
// Bot auth helper (internal secret). Returns true when the caller is the bot.
async function botAuthed(req: any, res: any): Promise<boolean> {
  const { coachEnv } = await import("../lib/coach.js");
  if (req.header("x-bot-secret") !== coachEnv.botSecret) { res.status(403).json({ error: "forbidden" }); return false; }
  return true;
}

// Bot: pending sessions (internal secret auth). Instant (waiting_for_employee)
// plus scheduled sessions whose time has come — the bot auto-joins both.
// Sessions nobody joined within the join timeout are expired here (lazily, so
// expiry does not depend on someone opening the coaching room), and sessions
// freshly claimed by a live bot are not handed out twice.
// Last time any bot polled /bot/pending (it polls every ~10s while idle).
// Surfaced to the coaching room so "bot simply isn't running" is a visible
// red banner, not silence — a waiting room with no bot and no error reads
// as "nobody is in the call".
export let lastBotSeenAt = 0;
coachRouter.get("/bot/pending", async (req, res) => {
  if (!(await botAuthed(req, res))) return;
  lastBotSeenAt = Date.now();
  const { coachEnv, isClaimStale } = await import("../lib/coach.js");
  const rows = await db.select().from(s.coachingSessions);
  const now = Date.now();
  const pending: any[] = [];
  for (const r of rows as any[]) {
    if (r.status === "waiting_for_employee" && r.createdAt && (now - +new Date(r.createdAt)) / 60000 > coachEnv.joinTimeoutMin) {
      await db.update(s.coachingSessions).set({ status: "expired", endedAt: new Date() }).where(eq(s.coachingSessions.id, r.id));
      continue;
    }
    const joinable = r.transport === "meet" && r.meetUrl && (
      r.status === "waiting_for_employee" ||
      (r.status === "scheduled" && r.scheduledAt && +new Date(r.scheduledAt) <= now)
    );
    if (joinable && isClaimStale(r.botClaimedAt, now)) pending.push(r);
  }
  pending.sort((a, b) => +new Date(a.createdAt || 0) - +new Date(b.createdAt || 0));
  res.json(pending);
});
// Bot claims a session before joining, so a second bot (or a restart loop)
// does not join the same Meet twice. Claims go stale after 90s (see coach.ts).
coachRouter.post("/bot/claim", async (req, res) => {
  if (!(await botAuthed(req, res))) return;
  const { sessionId } = req.body || {};
  const rows = await db.select().from(s.coachingSessions).where(eq(s.coachingSessions.id, sessionId));
  if (!rows.length) return res.status(404).json({ error: "not found" });
  const { isClaimStale } = await import("../lib/coach.js");
  const cs: any = rows[0];
  if (!["waiting_for_employee", "scheduled"].includes(cs.status)) return res.status(409).json({ error: `not claimable: ${cs.status}` });
  if (!isClaimStale(cs.botClaimedAt)) return res.status(409).json({ error: "already claimed" });
  await db.update(s.coachingSessions).set({ botClaimedAt: new Date(), botError: "" }).where(eq(s.coachingSessions.id, sessionId));
  res.json({ ok: true });
});
coachRouter.get("/bot/:id/status", async (req, res) => {
  if (!(await botAuthed(req, res))) return;
  const rows = await db.select().from(s.coachingSessions).where(eq(s.coachingSessions.id, req.params.id));
  if (!rows.length) return res.status(404).json({ error: "not found" });
  const cs: any = rows[0];
  res.json({ status: cs.status, humanFlag: cs.humanFlag, meetUrl: cs.meetUrl });
});
// Bot callbacks (internal secret): status, turn append, human flag, end w/ summary.
coachRouter.post("/bot/callback", async (req, res) => {
  const { coachEnv } = await import("../lib/coach.js");
  if (req.header("x-bot-secret") !== coachEnv.botSecret) return res.status(403).json({ error: "forbidden" });
  const { sessionId, status, turn, humanFlag, botError, ttsChars, summary, actionItems, interruptLastCoach } = req.body || {};
  const rows = await db.select().from(s.coachingSessions).where(eq(s.coachingSessions.id, sessionId));
  if (!rows.length) return res.status(404).json({ error: "not found" });
  const cs: any = rows[0];
  const patch: any = {};
  if (status) {
    patch.status = status;
    if (status === "live" && !cs.startedAt) patch.startedAt = new Date();
    if (["ended", "expired", "failed"].includes(status) && !cs.endedAt) patch.endedAt = new Date();
  }
  if (humanFlag !== undefined) patch.humanFlag = !!humanFlag;
  if (botError !== undefined) patch.botError = String(botError).slice(0, 500);
  if (ttsChars !== undefined) patch.ttsChars = Number(ttsChars) || 0;
  if (summary !== undefined) patch.summary = String(summary);
  if (actionItems !== undefined) patch.actionItems = actionItems;
  if (turn) {
    const count = await db.select().from(s.coachingTurns).where(eq(s.coachingTurns.sessionId, sessionId));
    await db.insert(s.coachingTurns).values({
      sessionId, idx: count.length, role: turn.role === "coach" ? "coach" : "employee",
      text: String(turn.text || "").slice(0, 4000), interrupted: !!turn.interrupted, audioMs: Number(turn.audioMs) || 0,
    });
    const tr = [...(cs.transcript as any[]), { role: turn.role, text: turn.text, at: new Date().toISOString(), ...(turn.interrupted ? { interrupted: true } : {}) }];
    patch.transcript = tr;
  }
  if (interruptLastCoach) {
    // Barge-in: flag the interrupted coach turn in both turn stores.
    const turns = (await db.select().from(s.coachingTurns).where(eq(s.coachingTurns.sessionId, sessionId))).sort((a, b) => b.idx - a.idx);
    const lastCoach = turns.find((t) => t.role === "coach");
    if (lastCoach) await db.update(s.coachingTurns).set({ interrupted: true }).where(eq(s.coachingTurns.id, lastCoach.id));
    const tr = [...(cs.transcript as any[])];
    for (let i = tr.length - 1; i >= 0; i--) if (tr[i].role === "coach") { tr[i] = { ...tr[i], interrupted: true }; break; }
    patch.transcript = tr;
  }
  if (Object.keys(patch).length) await db.update(s.coachingSessions).set(patch).where(eq(s.coachingSessions.id, sessionId));
  if (status && ["ended", "expired", "failed"].includes(status)) {
    // Persist agreed action items + audit (existing flow: summary + items on profile).
    const items: string[] = Array.isArray(actionItems) ? actionItems : [];
    for (const text of items.slice(0, 5)) {
      if (!String(text).trim()) continue;
      await db.insert(s.actionItems).values({ orgId: cs.orgId, employeeId: cs.employeeId, text: String(text).trim(), source: "coach" });
    }
    await db.insert(s.auditLog).values({ orgId: cs.orgId, userId: "bot", action: `coach_${status}`, callId: cs.employeeId });
  }
  if (humanFlag) await db.insert(s.auditLog).values({ orgId: cs.orgId, userId: "bot", action: "coach_human_flag", callId: cs.employeeId });
  res.json({ ok: true });
});
// ---- Bot conversation endpoints (secret auth) ----
// The bot owns audio only; all Muse reasoning stays behind lib/muse.ts here,
// so the bot needs no model keys and the coaching prompt/safety rules are
// built in exactly one place (same builder as the in-app fallback).
async function appendBotTurn(sessionId: string, cs: any, role: "employee" | "coach", text: string, audioMs = 0) {
  const count = await db.select().from(s.coachingTurns).where(eq(s.coachingTurns.sessionId, sessionId));
  await db.insert(s.coachingTurns).values({ sessionId, idx: count.length, role, text: String(text).slice(0, 4000), audioMs });
  const tr = [...(cs.transcript as any[]), { role, text, at: new Date().toISOString() }];
  await db.update(s.coachingSessions).set({ transcript: tr }).where(eq(s.coachingSessions.id, sessionId));
  return tr;
}
async function botSession(req: any, res: any) {
  if (!(await botAuthed(req, res))) return null;
  const rows = await db.select().from(s.coachingSessions).where(eq(s.coachingSessions.id, req.params.id));
  if (!rows.length) { res.status(404).json({ error: "not found" }); return null; }
  return rows[0] as any;
}
async function coachContext(cs: any) {
  const emps = await db.select().from(s.employees).where(eq(s.employees.id, cs.employeeId));
  const callRows = await db.select().from(s.calls).where(eq(s.calls.employeeId, cs.employeeId));
  callRows.sort((a, b) => +new Date(b.startedAt || 0) - +new Date(a.startedAt || 0));
  const evidence = callRows.slice(0, 3).map((c) => `Call ${c.id.slice(0, 6)} score ${c.score}: ${(c.transcript as any[]).filter((t) => t.speaker === "Agent").slice(0, 2).map((t) => t.text).join(" | ")}`).join("\n");
  const { coachSystemPrompt } = await import("../lib/muse.js");
  const sys = coachSystemPrompt({ employee: emps[0]?.name || "agent", scores: callRows.slice(0, 5).map((c) => c.score).join(", "), memo: cs.topics || "", evidence, policy: "Follow the active call-handling guidelines; be supportive and specific." });
  return { emp: emps[0], callRows, sys };
}
// Transcribe one employee utterance (16kHz mono WAV from the bot's VAD).
coachRouter.post("/bot/:id/transcribe", upload.single("audio"), async (req, res) => {
  const cs = await botSession(req, res); if (!cs) return;
  const buf = (req as any).file?.buffer;
  if (!buf?.length) return res.status(400).json({ error: "audio required" });
  try {
    const { transcribeCallAudio } = await import("../lib/muse.js");
    const { lines } = await transcribeCallAudio(buf, "en");
    res.json({ text: lines.map((l) => l.text).join(" ").trim() });
  } catch (e: any) {
    res.status(502).json({ error: `stt_failed: ${String(e?.message || e).slice(0, 200)}` });
  }
});
// Opening line: deterministic, grounded in a real recent call (never invented).
coachRouter.post("/bot/:id/greeting", async (req, res) => {
  const cs = await botSession(req, res); if (!cs) return;
  const { emp, callRows } = await coachContext(cs);
  const first = (emp?.name || "there").split(" ")[0];
  let example = "one real moment from your recent calls";
  const latest: any = callRows.find((c: any) => c.status === "done") || callRows[0];
  if (latest) {
    const crit = await db.select().from(s.criterionResults).where(eq(s.criterionResults.callId, latest.id));
    const worst = crit.filter((r) => r.result !== "pass").sort((a, b) => a.score - b.score)[0];
    if (worst?.evidenceQuote) example = `a recent call where ${worst.criterionName} scored ${worst.score} — you said: "${worst.evidenceQuote.slice(0, 120)}"`;
    else if ((latest.wentWrong as string[])?.[0]) example = `a recent call (score ${latest.score}) where this came up: ${(latest.wentWrong as string[])[0]}`;
    else example = `a recent call where you scored ${latest.score}`;
  }
  const text = `Hi ${first}, I'm Aro, your AI coach. This session is recorded and summarized for your profile. Let's look at ${example}. What felt hardest about that call from your side?`;
  await appendBotTurn(cs.id, cs, "coach", text);
  res.json({ text });
});
// One full turn: persist the employee utterance, reply with full history.
coachRouter.post("/bot/:id/reply", async (req, res) => {
  const cs = await botSession(req, res); if (!cs) return;
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "text required" });
  const { HUMAN_REGEX, GOODBYE_REGEX, trimHistory } = await import("../lib/coach.js");
  const { completeText } = await import("../lib/muse.js");
  const { sys } = await coachContext(cs);
  const humanFlag = HUMAN_REGEX.test(text) || cs.humanFlag;
  if (humanFlag && !cs.humanFlag) {
    await db.update(s.coachingSessions).set({ humanFlag: true }).where(eq(s.coachingSessions.id, cs.id));
    await db.insert(s.auditLog).values({ orgId: cs.orgId, userId: "bot", action: "coach_human_flag", callId: cs.employeeId });
  }
  await appendBotTurn(cs.id, cs, "employee", text, Number(req.body?.audioMs) || 0);
  const turns = (await db.select().from(s.coachingTurns).where(eq(s.coachingTurns.sessionId, cs.id))).sort((a, b) => a.idx - b.idx);
  const { turns: kept } = trimHistory(turns.map((t) => ({ role: t.role, text: t.text })));
  const history = kept.map((t) => `${t.role === "coach" ? "Coach" : "Employee"}: ${t.text}`).join("\n");
  const shouldEnd = GOODBYE_REGEX.test(text) && turns.length >= 2;
  try {
    const { text: reply, mock } = await completeText(sys, `${history}\nReply as coach in 1-3 SHORT sentences (keep it conversational and quick to speak), reference one real example from the evidence, end with one question.${shouldEnd ? " The employee is wrapping up: close warmly and confirm the agreed action items." : ""}${humanFlag ? " A human evaluator has been flagged; acknowledge that briefly." : ""}`);
    const csFresh: any = (await db.select().from(s.coachingSessions).where(eq(s.coachingSessions.id, cs.id)))[0];
    await appendBotTurn(cs.id, csFresh, "coach", reply);
    res.json({ reply, mock, humanFlag, shouldEnd });
  } catch (e: any) {
    res.status(502).json({ error: `llm_failed: ${String(e?.message || e).slice(0, 200)}` });
  }
});
// Streaming turn (SSE): same prompt/safety as /reply, but chunks are pushed
// as Muse generates them so the bot speaks the first sentence immediately
// instead of after the full reply (~30s -> a few seconds to first audio).
// Both turns are persisted when the stream completes; if the employee
// barges in and the bot aborts, the bot commits the played portion via
// /commit-turn instead.
coachRouter.post("/bot/:id/reply-stream", async (req, res) => {
  const cs = await botSession(req, res); if (!cs) return;
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "text required" });
  const { HUMAN_REGEX, GOODBYE_REGEX, trimHistory } = await import("../lib/coach.js");
  const { streamText } = await import("../lib/muse.js");
  const { sys } = await coachContext(cs);
  const humanFlag = HUMAN_REGEX.test(text) || cs.humanFlag;
  if (humanFlag && !cs.humanFlag) {
    await db.update(s.coachingSessions).set({ humanFlag: true }).where(eq(s.coachingSessions.id, cs.id));
    await db.insert(s.auditLog).values({ orgId: cs.orgId, userId: "bot", action: "coach_human_flag", callId: cs.employeeId });
  }
  const priorTurns = (await db.select().from(s.coachingTurns).where(eq(s.coachingTurns.sessionId, cs.id))).sort((a, b) => a.idx - b.idx);
  const { turns: kept } = trimHistory([...priorTurns.map((t) => ({ role: t.role, text: t.text })), { role: "employee", text }]);
  const history = kept.map((t) => `${t.role === "coach" ? "Coach" : "Employee"}: ${t.text}`).join("\n");
  const shouldEnd = GOODBYE_REGEX.test(text) && priorTurns.length >= 2;
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const ac = new AbortController();
  res.on("close", () => ac.abort());
  let full = "", mock = false, completed = false;
  try {
    ({ text: full, mock } = await streamText(sys, `${history}\nReply as coach in 1-3 SHORT sentences (keep it conversational and quick to speak), reference one real example from the evidence, end with one question.${shouldEnd ? " The employee is wrapping up: close warmly and confirm the agreed action items." : ""}${humanFlag ? " A human evaluator has been flagged; acknowledge that briefly." : ""}`,
      (chunk) => { try { res.write(`data: ${JSON.stringify({ chunk })}\n\n`); } catch {} }, ac.signal));
    completed = true;
  } catch (e: any) {
    if (!ac.signal.aborted) { try { res.write(`data: ${JSON.stringify({ error: String(e?.message || e).slice(0, 200) })}\n\n`); } catch {} }
  }
  if (completed && !ac.signal.aborted) {
    // Persist employee + coach turns (same as /reply, at stream end).
    const csFresh: any = (await db.select().from(s.coachingSessions).where(eq(s.coachingSessions.id, cs.id)))[0];
    const tr1 = await appendBotTurn(cs.id, csFresh, "employee", text, Number(req.body?.audioMs) || 0);
    const csFresh2: any = { ...(csFresh as any), transcript: tr1 };
    await appendBotTurn(cs.id, csFresh2, "coach", full);
    try { res.write(`data: ${JSON.stringify({ done: true, reply: full, mock, humanFlag, shouldEnd })}\n\n`); } catch {}
  }
  try { res.end(); } catch {}
});
// Bot commits the played portion of a barged/aborted streamed reply.
coachRouter.post("/bot/:id/commit-turn", async (req, res) => {
  const cs = await botSession(req, res); if (!cs) return;
  const employeeText = String(req.body?.employeeText || "").trim();
  const coachText = String(req.body?.coachText || "").trim();
  if (employeeText) {
    const turns = (await db.select().from(s.coachingTurns).where(eq(s.coachingTurns.sessionId, cs.id))).sort((a, b) => a.idx - b.idx);
    const lastEmp = [...turns].reverse().find((t) => t.role === "employee");
    if (lastEmp?.text !== employeeText) {
      const cs1: any = (await db.select().from(s.coachingSessions).where(eq(s.coachingSessions.id, cs.id)))[0];
      const tr = await appendBotTurn(cs.id, cs1, "employee", employeeText, Number(req.body?.audioMs) || 0);
      if (coachText) await appendBotTurn(cs.id, { ...cs1, transcript: tr }, "coach", coachText);
    }
  }
  res.json({ ok: true });
});
// Finish: summary + action items (existing flow), terminal status, audit.
coachRouter.post("/bot/:id/finish", async (req, res) => {
  const cs = await botSession(req, res); if (!cs) return;
  const reason = String(req.body?.reason || "ended");
  const status = reason === "failed" ? "failed" : reason === "expired" || reason === "no_show" ? "expired" : "ended";
  const turns = (await db.select().from(s.coachingTurns).where(eq(s.coachingTurns.sessionId, cs.id))).sort((a, b) => a.idx - b.idx);
  let summary = cs.summary || "", items: string[] = Array.isArray(cs.actionItems) ? cs.actionItems : [];
  if (turns.length >= 2 && status === "ended") {
    try {
      const { completeText } = await import("../lib/muse.js");
      const { text } = await completeText("You summarize a coaching session. Reply ONLY JSON {\"summary\":\"2-3 sentences\",\"actionItems\":[\"...\",\"...\"]}. Action items: 2-3 concrete, agreed behaviors; never invent call facts.", turns.map((t) => `${t.role}: ${t.text}`).join("\n").slice(0, 8000));
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || text);
      if (parsed.summary) summary = String(parsed.summary);
      if (Array.isArray(parsed.actionItems)) items = parsed.actionItems.map(String).filter(Boolean).slice(0, 3);
    } catch { /* fall through to defaults */ }
  }
  if (!summary) summary = reason === "employee_left" ? "Employee left the meeting; session ended early." : reason === "no_show" ? "Employee did not join in time." : `Session with ${Math.floor(turns.length / 2)} exchanges.`;
  if (status === "ended" && !items.length && turns.length >= 2) items = ["Use empathy opener", "Apply 3-step close"];
  if (status !== "ended") items = Array.isArray(cs.actionItems) ? cs.actionItems : [];
  await db.update(s.coachingSessions).set({ status, endedAt: new Date(), summary, actionItems: items, ttsChars: Number(req.body?.ttsChars) || cs.ttsChars || 0, botError: reason === "failed" ? String(req.body?.botError || cs.botError || "").slice(0, 500) : cs.botError }).where(eq(s.coachingSessions.id, cs.id));
  for (const t of items.slice(0, 5)) {
    const exists = (await db.select().from(s.actionItems).where(and(eq(s.actionItems.employeeId, cs.employeeId), eq(s.actionItems.orgId, cs.orgId)))).some((a) => a.text === t);
    if (!exists) await db.insert(s.actionItems).values({ orgId: cs.orgId, employeeId: cs.employeeId, text: t, source: "coach" });
  }
  await db.insert(s.auditLog).values({ orgId: cs.orgId, userId: "bot", action: `coach_${status}`, callId: cs.employeeId });
  res.json({ ok: true, status, summary, actionItems: items });
});

coachRouter.get("/:id", authMw, async (req: any, res) => {
  const rows = await db.select().from(s.coachingSessions).where(eq(s.coachingSessions.id, req.params.id));
  if (!rows.length) return res.status(404).json({ error: "not found" });
  res.json(rows[0]);
});
// Room view: private admin monitor (auth required, org-scoped). The employee
// only ever receives the Google Meet link — never this page.
coachRouter.get("/:id/room", authMw, async (req: any, res) => {
  const rows = await db.select().from(s.coachingSessions).where(eq(s.coachingSessions.id, req.params.id));
  if (!rows.length || (rows[0] as any).orgId !== req.user.orgId) return res.status(404).json({ error: "not found" });
  const cs: any = rows[0];
  const turns = (await db.select().from(s.coachingTurns).where(eq(s.coachingTurns.sessionId, cs.id)))
    .sort((a, b) => a.idx - b.idx);
  // Expiry: instant waiting > join timeout -> expired (scheduled sessions wait
  // for their time and never expire here).
  const { coachEnv, joinableReason } = await import("../lib/coach.js");
  if (cs.status === "waiting_for_employee") {
    const ageMin = (Date.now() - +new Date(cs.createdAt || Date.now())) / 60000;
    if (ageMin > coachEnv.joinTimeoutMin) {
      await db.update(s.coachingSessions).set({ status: "expired", endedAt: new Date() }).where(eq(s.coachingSessions.id, cs.id));
      cs.status = "expired";
    }
  }
  res.json({ session: cs, turns, transportDefault: coachEnv.transport, joinable: joinableReason(cs as any), botOnline: Date.now() - lastBotSeenAt < 30000, botSeenAgoSec: lastBotSeenAt ? Math.round((Date.now() - lastBotSeenAt) / 1000) : null });
});
// End session (admin only, private room). Runs summary flow for inapp; meet
// summary comes from bot callback, but we finalize defensively here too.
coachRouter.post("/:id/end", authMw, async (req: any, res) => {
  const { summary } = req.body || {};
  const rows = await db.select().from(s.coachingSessions).where(eq(s.coachingSessions.id, req.params.id));
  if (!rows.length || (rows[0] as any).orgId !== req.user.orgId) return res.status(404).json({ error: "not found" });
  const cs: any = rows[0];
  const turns = await db.select().from(s.coachingTurns).where(eq(s.coachingTurns.sessionId, cs.id));
  const finalSummary = summary || cs.summary || `Session with ${Math.max(turns.length, (cs.transcript as any[]).length / 2, 0)} exchanges.`;
  const items: string[] = Array.isArray(cs.actionItems) && cs.actionItems.length ? cs.actionItems : ["Use empathy opener", "Apply 3-step close"];
  await db.update(s.coachingSessions).set({ status: "ended", endedAt: new Date(), summary: String(finalSummary) }).where(eq(s.coachingSessions.id, cs.id));
  for (const t of items.slice(0, 5)) {
    const exists = (await db.select().from(s.actionItems).where(and(eq(s.actionItems.employeeId, cs.employeeId), eq(s.actionItems.orgId, cs.orgId)))).some((a) => a.text === t);
    if (!exists) await db.insert(s.actionItems).values({ orgId: cs.orgId, employeeId: cs.employeeId, text: t, source: "coach" });
  }
  await db.insert(s.auditLog).values({ orgId: cs.orgId, userId: "room", action: "coach_end", callId: cs.employeeId });
  res.json({ ok: true, summary: finalSummary, actionItems: items });
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
  const sys = coachSystemPrompt({ employee: emps[0]?.name || "agent", scores: callRows.slice(0, 5).map((c) => c.score).join(", "), memo: cs.topics || "", evidence, policy: "Follow the active call-handling guidelines; be supportive and specific." });
  const needsHuman = /harass|complaint|health|sick|anxiet|unfair|manager.*(yelled|abuse)/i.test(message || "");
  const { text, mock } = await completeText(sys, `Employee says: ${message}\nReply as coach in 2-4 sentences, reference one real example, ask a follow-up.`);
  const tr = [...(cs.transcript as any[]), { role: "employee", text: message, at: new Date().toISOString() }, { role: "coach", text, at: new Date().toISOString() }];
  await db.update(s.coachingSessions).set({ transcript: tr, humanFlag: needsHuman || cs.humanFlag, summary: `Session with ${tr.length / 2} exchanges.`, actionItems: ["Use empathy opener", "Apply 3-step close"] }).where(eq(s.coachingSessions.id, cs.id));
  res.json({ reply: text, mock, humanFlag: needsHuman || cs.humanFlag });
});
coachRouter.post("/:id/flag", authMw, async (req: any, res) => {
  const rows = await db.select().from(s.coachingSessions).where(eq(s.coachingSessions.id, req.params.id));
  if (!rows.length || (rows[0] as any).orgId !== req.user.orgId) return res.status(404).json({ error: "not found" });
  const cs: any = rows[0];
  await db.update(s.coachingSessions).set({ humanFlag: true }).where(eq(s.coachingSessions.id, req.params.id));
  await db.insert(s.auditLog).values({ orgId: cs.orgId, userId: "room", action: "coach_human_flag", callId: cs.employeeId });
  res.json({ ok: true });
});
// Admin pastes a Meet link manually (fallback when Google not connected).
coachRouter.patch("/:id/meet-link", authMw, async (req: any, res) => {
  const { isValidMeetLink } = await import("../lib/mailer.js");
  const meetUrl = String(req.body?.meetUrl || "").trim();
  if (!isValidMeetLink(meetUrl)) return res.status(400).json({ error: "paste a real Meet link, e.g. https://meet.google.com/abc-defg-hij" });
  const rows = await db.select().from(s.coachingSessions).where(eq(s.coachingSessions.id, req.params.id));
  if (!rows.length || (rows[0] as any).orgId !== req.user.orgId) return res.status(404).json({ error: "not found" });
  // Restart the join window: expiry is measured from creation, so a freshly
  // pasted link gets a full window instead of instantly re-expiring.
  const [cs] = await db.update(s.coachingSessions).set({ meetUrl, transport: "meet", status: "waiting_for_employee", meetError: "", createdAt: new Date() }).where(eq(s.coachingSessions.id, req.params.id)).returning();
  res.json(cs);
});

miscRouter.use("/calls", callRouter);
miscRouter.use("/agent", agentRouter);
miscRouter.use("/memos", memoRouter);
miscRouter.use("/coach", coachRouter);
