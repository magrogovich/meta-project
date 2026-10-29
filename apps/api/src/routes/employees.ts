import { Router } from "express";
import multer from "multer";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import * as s from "../db/schema.js";
import { authMw } from "./auth.js";
import { newSessionKey, encryptKey, decryptKey, keyTag } from "../lib/keys.js";
import { sha256 } from "../lib/util.js";

export const empRouter = Router();
empRouter.use(authMw);

const isAdmin = (req: any) => req.user.role === "admin";
const ONLINE_MS = 15 * 60 * 1000;
export const agentOnline = (e: any) => !!(e.lastSeen && Date.now() - +new Date(e.lastSeen) < ONLINE_MS);
export const agentStatusOf = (e: any) => (e.agentStatus === "never" && !e.lastSeen ? "never" : agentOnline(e) ? "online" : "offline");

async function ensureDepartment(orgId: string, name: string) {
  const n = (name || "").trim() || "Support";
  const rows = await db.select().from(s.departments).where(and(eq(s.departments.orgId, orgId), eq(s.departments.name, n)));
  if (!rows.length) await db.insert(s.departments).values({ orgId, name: n });
  return n;
}

function stripSecrets(e: any) {
  const { sessionKeyEnc, sessionKeyHmac, sessionKeyHash, ...rest } = e;
  return { ...rest, hasKey: !!(sessionKeyHmac || sessionKeyHash) && !e.sessionKeyRevoked, keyRevoked: !!e.sessionKeyRevoked };
}

empRouter.get("/", async (req: any, res) => {
  const rows = await db.select().from(s.employees).where(eq(s.employees.orgId, req.user.orgId));
  const callRows = await db.select().from(s.calls).where(eq(s.calls.orgId, req.user.orgId));
  const byEmp: Record<string, { score: number; at: number }[]> = {};
  for (const c of callRows) { (byEmp[c.employeeId] = byEmp[c.employeeId] || []).push({ score: c.score, at: +new Date(c.startedAt || 0) }); }
  res.json(rows.map((e) => {
    const pts = (byEmp[e.id] || []).sort((a, b) => a.at - b.at).map((p) => p.score);
    const scores = pts;
    const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10 : 0;
    const half = Math.floor(scores.length / 2);
    const prev = scores.slice(0, half), cur = scores.slice(half);
    const avgOf = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : avg);
    const trend = scores.length > 1 ? Math.round((avgOf(cur) - avgOf(prev)) * 10) / 10 : 0;
    return { ...stripSecrets(e), overallScore: avg, trend, agentStatus: agentStatusOf(e) };
  }));
});

// Enriched table for the Employees page: search + filters + period stats.
empRouter.get("/table", async (req: any, res) => {
  const { q, dept, lang, status, agent } = req.query as any;
  const { from, to } = req.query as any;
  let rows = await db.select().from(s.employees).where(eq(s.employees.orgId, req.user.orgId));
  if (q) rows = rows.filter((e) => e.name.toLowerCase().includes(String(q).toLowerCase()));
  if (dept) rows = rows.filter((e) => e.department === dept);
  if (lang) rows = rows.filter((e) => ((e.languages as string[]) || []).includes(lang));
  if (status) rows = rows.filter((e) => e.status === status);
  let callRows = await db.select().from(s.calls).where(eq(s.calls.orgId, req.user.orgId));
  if (from) callRows = callRows.filter((c) => new Date(c.startedAt || 0) >= new Date(from));
  if (to) callRows = callRows.filter((c) => new Date(c.startedAt || 0) <= new Date(to));
  const byEmp: Record<string, typeof callRows> = {};
  for (const c of callRows) (byEmp[c.employeeId] = byEmp[c.employeeId] || []).push(c);
  let out = rows.map((e) => {
    const mine = (byEmp[e.id] || []).filter((c) => c.status === "done").sort((a, b) => +new Date(a.startedAt || 0) - +new Date(b.startedAt || 0));
    const avg = mine.length ? Math.round(mine.reduce((a, c) => a + c.score, 0) / mine.length * 10) / 10 : null;
    const half = Math.floor(mine.length / 2);
    const avgOf = (a: typeof mine) => (a.length ? a.reduce((x, c) => x + c.score, 0) / a.length : 0);
    const trend = mine.length > 1 ? Math.round((avgOf(mine.slice(half)) - avgOf(mine.slice(0, half))) * 10) / 10 : 0;
    const last = mine.length ? mine[mine.length - 1].startedAt : null;
    return {
      ...stripSecrets(e), overallScore: avg, trend, callsThisPeriod: mine.length, lastCall: last,
      agentStatus: agentStatusOf(e),
      coachingStatus: avg == null ? "no data" : avg < 70 ? "needs coaching" : avg < 80 ? "watch" : "on track",
    };
  });
  if (agent) out = out.filter((e) => e.agentStatus === agent);
  res.json(out);
});

empRouter.post("/", async (req: any, res) => {
  const { name, department, languages, startDate, photo } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const dept = await ensureDepartment(req.user.orgId, department);
  const key = newSessionKey();
  const [e] = await db.insert(s.employees).values({
    orgId: req.user.orgId, name, department: dept,
    languages: Array.isArray(languages) ? languages : ["en"],
    startDate: startDate || new Date().toISOString().slice(0, 10),
    photo: photo || "", sessionKeyHash: "", sessionKeyPrefix: key.slice(0, 8),
    sessionKeyEnc: encryptKey(key), sessionKeyHmac: keyTag(key), sessionKeyRevoked: false,
    status: "active",
  }).returning();
  await db.insert(s.auditLog).values({ orgId: req.user.orgId, userId: req.user.id, action: "employee_create", callId: e.id });
  res.json({ employee: stripSecrets(e), sessionKey: key });
});

// CSV import: header name,department,languages (languages separated by ; or |)
empRouter.post("/import", multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } }).single("file"), async (req: any, res) => {
  const raw = (req as any).file?.buffer?.toString("utf8") || req.body?.csv || "";
  if (!raw.trim()) return res.status(400).json({ error: "empty CSV" });
  const lines = raw.split(/\r?\n/).filter((l: string) => l.trim());
  const header = lines[0].toLowerCase();
  if (!header.includes("name")) return res.status(400).json({ error: "CSV needs a header row with name,department,languages" });
  const created: { name: string; sessionKey: string }[] = [];
  const errors: string[] = [];
  for (const line of lines.slice(1, 51)) {
    const [name, department, langs] = line.split(",").map((x: string) => (x || "").trim());
    if (!name) { errors.push(`skipped empty row`); continue; }
    try {
      const dept = await ensureDepartment(req.user.orgId, department);
      const key = newSessionKey();
      const [e] = await db.insert(s.employees).values({
        orgId: req.user.orgId, name, department: dept,
        languages: (langs || "en").split(/[;|]/).map((x: string) => x.trim()).filter(Boolean),
        startDate: new Date().toISOString().slice(0, 10),
        sessionKeyHash: "", sessionKeyPrefix: key.slice(0, 8),
        sessionKeyEnc: encryptKey(key), sessionKeyHmac: keyTag(key), sessionKeyRevoked: false, status: "active",
      }).returning();
      await db.insert(s.auditLog).values({ orgId: req.user.orgId, userId: req.user.id, action: "employee_create", callId: e.id });
      created.push({ name, sessionKey: key });
    } catch (err: any) { errors.push(`${name}: ${err.message}`); }
  }
  res.json({ created, errors });
});

empRouter.patch("/:id", async (req: any, res) => {
  const { name, department, languages, photo, status } = req.body || {};
  const patch: any = { ...(name && { name }), ...(languages && { languages }), ...(photo !== undefined && { photo }), ...(status && { status }) };
  if (department) patch.department = await ensureDepartment(req.user.orgId, department);
  await db.update(s.employees).set(patch)
    .where(and(eq(s.employees.id, req.params.id), eq(s.employees.orgId, req.user.orgId)));
  res.json({ ok: true });
});

// ---- session keys: persistent + revealable. Admins only. ----
const revealHits = new Map<string, number[]>();
function checkRevealRate(key: string): boolean {
  const now = Date.now();
  const arr = (revealHits.get(key) || []).filter((t) => now - t < 60_000);
  if (arr.length >= 10) return false;
  arr.push(now); revealHits.set(key, arr);
  return true;
}
async function loadEmp(req: any, res: any) {
  const rows = await db.select().from(s.employees).where(and(eq(s.employees.id, req.params.id), eq(s.employees.orgId, req.user.orgId)));
  if (!rows.length) { res.status(404).json({ error: "not found" }); return null; }
  return rows[0];
}

empRouter.get("/:id/key", async (req: any, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "admins only" });
  if (!checkRevealRate(`${req.user.orgId}:${req.user.id}`)) return res.status(429).json({ error: "too many reveal requests, slow down" });
  const e = await loadEmp(req, res);
  if (!e) return;
  if (e.sessionKeyRevoked) return res.status(409).json({ error: "key revoked — regenerate a new one" });
  if (!e.sessionKeyEnc) return res.status(409).json({ error: "legacy key cannot be revealed — regenerate a new one" });
  await db.insert(s.auditLog).values({ orgId: req.user.orgId, userId: req.user.id, action: "key_reveal", callId: e.id });
  res.json({ sessionKey: decryptKey(e.sessionKeyEnc), prefix: e.sessionKeyPrefix });
});

empRouter.post("/:id/key/copied", async (req: any, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "admins only" });
  const e = await loadEmp(req, res);
  if (!e) return;
  await db.insert(s.auditLog).values({ orgId: req.user.orgId, userId: req.user.id, action: "key_copy", callId: e.id });
  res.json({ ok: true });
});

empRouter.post("/:id/key/regenerate", async (req: any, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "admins only" });
  const e = await loadEmp(req, res);
  if (!e) return;
  const key = newSessionKey();
  await db.update(s.employees).set({
    sessionKeyHash: "", sessionKeyPrefix: key.slice(0, 8),
    sessionKeyEnc: encryptKey(key), sessionKeyHmac: keyTag(key), sessionKeyRevoked: false,
  }).where(and(eq(s.employees.id, e.id), eq(s.employees.orgId, req.user.orgId)));
  await db.insert(s.auditLog).values({ orgId: req.user.orgId, userId: req.user.id, action: "key_regenerate", callId: e.id });
  res.json({ sessionKey: key });
});

empRouter.post("/:id/key/revoke", async (req: any, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "admins only" });
  const e = await loadEmp(req, res);
  if (!e) return;
  await db.update(s.employees).set({ sessionKeyRevoked: true })
    .where(and(eq(s.employees.id, e.id), eq(s.employees.orgId, req.user.orgId)));
  await db.insert(s.auditLog).values({ orgId: req.user.orgId, userId: req.user.id, action: "key_revoke", callId: e.id });
  res.json({ ok: true });
});

// legacy single-shot regenerate (kept for compat) -> now persistent + revealable
empRouter.post("/:id/key", async (req: any, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "admins only" });
  const e = await loadEmp(req, res);
  if (!e) return;
  const key = newSessionKey();
  await db.update(s.employees).set({
    sessionKeyHash: "", sessionKeyPrefix: key.slice(0, 8),
    sessionKeyEnc: encryptKey(key), sessionKeyHmac: keyTag(key), sessionKeyRevoked: false,
  }).where(and(eq(s.employees.id, e.id), eq(s.employees.orgId, req.user.orgId)));
  await db.insert(s.auditLog).values({ orgId: req.user.orgId, userId: req.user.id, action: "key_regenerate", callId: e.id });
  res.json({ sessionKey: key });
});

empRouter.delete("/:id", async (req: any, res) => {
  const eid = req.params.id;
  await db.delete(s.coachingSessions).where(and(eq(s.coachingSessions.employeeId, eid), eq(s.coachingSessions.orgId, req.user.orgId)));
  await db.delete(s.memos).where(and(eq(s.memos.employeeId, eid), eq(s.memos.orgId, req.user.orgId)));
  await db.delete(s.actionItems).where(and(eq(s.actionItems.employeeId, eid), eq(s.actionItems.orgId, req.user.orgId)));
  await db.delete(s.auditLog).where(and(eq(s.auditLog.callId, eid), eq(s.auditLog.orgId, req.user.orgId)));
  const callIds = (await db.select().from(s.calls).where(and(eq(s.calls.employeeId, eid), eq(s.calls.orgId, req.user.orgId)))).map((c) => c.id);
  for (const cid of callIds) await db.delete(s.criterionResults).where(eq(s.criterionResults.callId, cid));
  await db.delete(s.calls).where(and(eq(s.calls.employeeId, eid), eq(s.calls.orgId, req.user.orgId)));
  await db.delete(s.employees).where(and(eq(s.employees.id, eid), eq(s.employees.orgId, req.user.orgId)));
  res.json({ ok: true });
});

// profile: header stats + calls + AI strengths/weaknesses
empRouter.get("/:id/profile", async (req: any, res) => {
  const { from, to, lang, min, max } = req.query as any;
  const emps = await db.select().from(s.employees).where(and(eq(s.employees.id, req.params.id), eq(s.employees.orgId, req.user.orgId)));
  if (!emps.length) return res.status(404).json({ error: "not found" });
  let callRows = await db.select().from(s.calls).where(and(eq(s.calls.employeeId, req.params.id), eq(s.calls.orgId, req.user.orgId)));
  if (from) callRows = callRows.filter((c) => new Date(c.startedAt || 0) >= new Date(from));
  if (to) callRows = callRows.filter((c) => new Date(c.startedAt || 0) <= new Date(to));
  if (lang) callRows = callRows.filter((c) => c.language === lang);
  if (min) callRows = callRows.filter((c) => c.score >= Number(min));
  if (max) callRows = callRows.filter((c) => c.score <= Number(max));
  callRows.sort((a, b) => +new Date(b.startedAt || 0) - +new Date(a.startedAt || 0));
  const scores = callRows.map((c) => c.score);
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10 : 0;
  const crit = await db.select().from(s.criterionResults);
  const byCrit: Record<string, number[]> = {};
  for (const c of callRows) for (const r of crit.filter((x) => x.callId === c.id)) (byCrit[r.criterionName] = byCrit[r.criterionName] || []).push(r.score);
  const strengths = Object.entries(byCrit).sort((a, b) => (avgOf(b[1]) - avgOf(a[1]))).slice(0, 2).map(([k, v]) => `${k} (avg ${Math.round(avgOf(v))})`);
  const weaknesses = Object.entries(byCrit).sort((a, b) => (avgOf(a[1]) - avgOf(b[1]))).slice(0, 2).map(([k, v]) => `${k} (avg ${Math.round(avgOf(v))})`);
  const breakdown = Object.entries(byCrit).map(([k, v]) => ({ name: k, avg: Math.round(avgOf(v) * 10) / 10, count: v.length })).sort((a, b) => b.avg - a.avg);
  res.json({ employee: { ...stripSecrets(emps[0]), overallScore: avg, agentStatus: agentStatusOf(emps[0]) }, calls: callRows, trend: callRows.slice().reverse().map((c) => ({ t: c.startedAt, score: c.score })), strengths, weaknesses, breakdown });
});
const avgOf = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

// ---- departments (managed entities) ----
export const deptRouter = Router();
deptRouter.use(authMw);
deptRouter.get("/", async (req: any, res) => {
  res.json(await db.select().from(s.departments).where(eq(s.departments.orgId, req.user.orgId)));
});
deptRouter.post("/", async (req: any, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "admins only" });
  const { name } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: "name required" });
  const [d] = await db.insert(s.departments).values({ orgId: req.user.orgId, name: name.trim() }).returning().catch(() => [null]);
  if (!d) return res.status(400).json({ error: "department exists" });
  res.json(d);
});
deptRouter.patch("/:id", async (req: any, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "admins only" });
  const { name } = req.body || {};
  const old = await db.select().from(s.departments).where(and(eq(s.departments.id, req.params.id), eq(s.departments.orgId, req.user.orgId)));
  if (!old.length) return res.status(404).json({ error: "not found" });
  await db.update(s.departments).set({ name: name.trim() }).where(eq(s.departments.id, req.params.id));
  await db.update(s.employees).set({ department: name.trim() }).where(and(eq(s.employees.department, old[0].name), eq(s.employees.orgId, req.user.orgId)));
  res.json({ ok: true });
});
