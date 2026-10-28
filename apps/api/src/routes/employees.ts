import { Router } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import * as s from "../db/schema.js";
import { authMw } from "./auth.js";
import { newSessionKey, sha256 } from "../lib/util.js";

export const empRouter = Router();
empRouter.use(authMw);
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
    return { ...e, overallScore: avg, trend };
  }));
});
empRouter.post("/", async (req: any, res) => {
  const { name, department, languages, startDate, photo } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const key = newSessionKey();
  const [e] = await db.insert(s.employees).values({
    orgId: req.user.orgId, name, department: department || "Support",
    languages: languages || ["en"], startDate: startDate || new Date().toISOString().slice(0, 10),
    photo: photo || "", sessionKeyHash: sha256(key), sessionKeyPrefix: key.slice(0, 8),
  }).returning();
  // shown ONCE at creation
  res.json({ employee: e, sessionKey: key });
});
empRouter.patch("/:id", async (req: any, res) => {
  const { name, department, languages, photo, status } = req.body || {};
  await db.update(s.employees).set({ ...(name && { name }), ...(department && { department }), ...(languages && { languages }), ...(photo !== undefined && { photo }), ...(status && { status }) })
    .where(and(eq(s.employees.id, req.params.id), eq(s.employees.orgId, req.user.orgId)));
  res.json({ ok: true });
});
empRouter.post("/:id/key", async (req: any, res) => {
  const key = newSessionKey();
  await db.update(s.employees).set({ sessionKeyHash: sha256(key), sessionKeyPrefix: key.slice(0, 8) })
    .where(and(eq(s.employees.id, req.params.id), eq(s.employees.orgId, req.user.orgId)));
  res.json({ sessionKey: key });
});
empRouter.delete("/:id", async (req: any, res) => {
  const eid = req.params.id;
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
  res.json({ employee: { ...emps[0], overallScore: avg }, calls: callRows, trend: callRows.slice().reverse().map((c) => ({ t: c.startedAt, score: c.score })), strengths, weaknesses });
});
const avgOf = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
