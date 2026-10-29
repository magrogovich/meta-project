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
    await db.update(s.calls).set({ status: "done", score: analysis.total, summary: analysis.summary || "", wentWell: analysis.wentWell || [], wentWrong: analysis.wentWrong || [], tags: analysis.tags || [], criteriaVersion, guidelineRefs }).where(eq(s.calls.id, callId));
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
callRouter.get("/search", async (req: any, res) => {
  const { from, to, employeeId, dept, lang, min, max, critical, failed, page, limit, sort, order } = req.query as any;
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
agentRouter.post("/upload-chunk", upload.single("chunk"), async (req, res) => {
  const key = (req.headers["x-session-key"] as string) || req.body?.sessionKey;
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

// ---- dashboard summary: "what needs my attention right now?" ----
export const dashRouter = Router();
dashRouter.use(authMw);
dashRouter.get("/summary", async (req: any, res) => {
  const { from, to, dept, lang } = req.query as any;
  const orgId = req.user.orgId;
  let emps = await db.select().from(s.employees).where(eq(s.employees.orgId, orgId));
  if (dept) emps = emps.filter((e) => e.department === dept);
  const empIds = new Set(emps.map((e) => e.id));
  let callRows = await db.select().from(s.calls).where(eq(s.calls.orgId, orgId));
  callRows = callRows.filter((c) => empIds.has(c.employeeId));
  if (from) callRows = callRows.filter((c) => new Date(c.startedAt || 0) >= new Date(from));
  if (to) callRows = callRows.filter((c) => new Date(c.startedAt || 0) <= new Date(to));
  if (lang) callRows = callRows.filter((c) => c.language === lang);
  const mid = from && to ? (+new Date(from) + +new Date(to)) / 2 : 0;
  const prev = mid ? callRows.filter((c) => +new Date(c.startedAt || 0) < mid) : [];
  const cur = mid ? callRows.filter((c) => +new Date(c.startedAt || 0) >= mid) : callRows;
  const done = callRows.filter((c) => c.status === "done");
  const doneCur = cur.filter((c) => c.status === "done");
  const donePrev = prev.filter((c) => c.status === "done");
  const avg = (a: typeof done) => (a.length ? a.reduce((x, c) => x + c.score, 0) / a.length : 0);
  // must-pass criteria from the approved set
  const { mustPassIds } = await import("../lib/context.js");
  const mustIds = await mustPassIds(orgId);
  const callIds = new Set(callRows.map((c) => c.id));
  const crit = (await db.select().from(s.criterionResults)).filter((r) => callIds.has(r.callId));
  const critFail = (cid: string) => crit.some((r) => r.callId === cid && r.result === "fail" && mustIds.has(r.criterionId));
  const critical = callRows.filter((c) => c.status === "done" && critFail(c.id));
  const failed = callRows.filter((c) => c.status === "failed");
  // per-employee current vs previous avg -> drops / improvers
  const perEmp = emps.map((e) => {    const mine = doneCur.filter((c) => c.employeeId === e.id).map((c) => c.score);
    const minePrev = donePrev.filter((c) => c.employeeId === e.id).map((c) => c.score);
    const a = mine.length ? mine.reduce((x, y) => x + y, 0) / mine.length : 0;
    const b = minePrev.length ? minePrev.reduce((x, y) => x + y, 0) / minePrev.length : 0;
    return { id: e.id, name: e.name, department: e.department, score: Math.round(a * 10) / 10 || null, delta: mine.length && minePrev.length ? Math.round((a - b) * 10) / 10 : 0, calls: mine.length };
  });
  const { getRules } = await import("./coaching.js");
  const rules = await getRules(orgId);
  const drops = perEmp.filter((e) => e.delta <= -rules.dropPoints && e.calls > 0).sort((a, b) => a.delta - b.delta);
  const improvers = perEmp.filter((e) => e.delta > 0 && e.calls > 0).sort((a, b) => b.delta - a.delta).slice(0, 5);
  const declines = perEmp.filter((e) => e.delta < 0 && e.calls > 0).sort((a, b) => a.delta - b.delta).slice(0, 5);
  const needCoach = perEmp.filter((e) => (e.score ?? 100) < rules.scoreBelow && e.calls > 0);
  // human-flagged sessions
  const sessions = await db.select().from(s.coachingSessions).where(eq(s.coachingSessions.orgId, orgId));
  const flagged = sessions.filter((x) => x.humanFlag).slice(-5);
  // agents: online if seen in last 15 min
  const online = emps.filter((e) => e.lastSeen && Date.now() - +new Date(e.lastSeen) < 15 * 60e3).length;
  const offline = emps.filter((e) => e.agentStatus !== "never" && !(e.lastSeen && Date.now() - +new Date(e.lastSeen) < 15 * 60e3));
  // action items follow-through
  const items = await db.select().from(s.actionItems).where(eq(s.actionItems.orgId, orgId));
  const follow = items.length ? Math.round(items.filter((i) => i.status === "done").length / items.length * 100) : null;
  // charts
  const byDay: Record<string, number[]> = {};
  for (const c of done) { const d = new Date(c.startedAt || 0).toISOString().slice(0, 10); (byDay[d] = byDay[d] || []).push(c.score); }
  const trend = Object.entries(byDay).sort().map(([t, vs]) => ({ t, score: Math.round(vs.reduce((a, b) => a + b, 0) / vs.length * 10) / 10 }));
  const byCrit: Record<string, { name: string; fails: number; total: number }> = {};
  for (const r of crit) {
    const k = byCrit[r.criterionId] = byCrit[r.criterionId] || { name: r.criterionName, fails: 0, total: 0 };
    k.total++; if (r.result === "fail") k.fails++;
  }
  const failedCrit = Object.values(byCrit).sort((a, b) => b.fails - a.fails).slice(0, 6);
  const buckets = [0, 0, 0, 0, 0]; // <50,50-60,60-70,70-85,85+
  for (const c of done) buckets[c.score < 50 ? 0 : c.score < 60 ? 1 : c.score < 70 ? 2 : c.score < 85 ? 3 : 4]++;
  const delta = (a: number, b: number) => (b ? Math.round((a - b) * 10) / 10 : 0);
  res.json({
    kpis: {
      calls: { value: done.length, delta: doneCur.length - donePrev.length },
      avg: { value: done.length ? Math.round(avg(done) * 10) / 10 : null, delta: delta(avg(doneCur), avg(donePrev)) },
      critical: { value: critical.length, delta: 0 },
      needCoach: { value: needCoach.length, delta: 0 },
      coverage: { value: callRows.length ? Math.round(done.length / callRows.length * 100) : null, agentsOnline: online, agentsTotal: emps.length },
      follow: { value: follow, delta: 0 },
    },
    attention: {
      drops: drops.slice(0, 5).map((e) => ({ kind: "drop", employeeId: e.id, text: `${e.name} dropped ${e.delta} points`, link: `/employees/${e.id}` })),
      critical: critical.slice(0, 5).map((c) => ({ kind: "critical", callId: c.id, text: `Critical failure: ${c.score} on ${new Date(c.startedAt || 0).toLocaleDateString()}`, link: `/calls/${c.id}` })),
      flagged: flagged.map((x: any) => ({ kind: "flag", sessionId: x.id, text: `Human evaluator requested`, link: `/coach/${x.id}?token=${x.token}` })),
      failed: failed.slice(0, 5).map((c) => ({ kind: "failed", callId: c.id, text: `Processing failed (${c.language})`, link: `/calls/${c.id}` })),
      offline: offline.slice(0, 5).map((e) => ({ kind: "offline", employeeId: e.id, text: `${e.name}'s desktop agent offline`, link: `/employees/${e.id}` })),
    },
    charts: { trend, failedCrit, buckets },
    improvers, declines,
    recent: callRows.slice().sort((a, b) => +new Date(b.startedAt || 0) - +new Date(a.startedAt || 0)).slice(0, 5),
    employees: emps.map((e) => ({ id: e.id, name: e.name })),
  });
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
  const sys = coachSystemPrompt({ employee: emps[0]?.name || "agent", scores: callRows.slice(0, 5).map((c) => c.score).join(", "), memo: cs.topics || "", evidence, policy: "Follow the active call-handling guidelines; be supportive and specific." });
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

miscRouter.use("/dashboard", dashRouter);
miscRouter.use("/calls", callRouter);
miscRouter.use("/agent", agentRouter);
miscRouter.use("/memos", memoRouter);
miscRouter.use("/coach", coachRouter);
