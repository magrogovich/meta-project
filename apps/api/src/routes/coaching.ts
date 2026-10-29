import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import * as s from "../db/schema.js";
import { authMw } from "./auth.js";

export const coachRouter2 = Router();
coachRouter2.use(authMw);

export type CoachRules = { scoreBelow: number; dropPoints: number; criticalCount: number };
export async function getRules(orgId: string): Promise<CoachRules> {
  const rows = await db.select().from(s.orgs).where(eq(s.orgs.id, orgId));
  const c = (rows[0]?.settings as any)?.coaching || {};
  return {
    scoreBelow: Number(c.scoreBelow) || 70,
    dropPoints: Number(c.dropPoints) || 10,
    criticalCount: Number(c.criticalCount) || 3,
  };
}

coachRouter2.get("/rules", async (req: any, res) => {
  res.json(await getRules(req.user.orgId));
});
coachRouter2.patch("/rules", async (req: any, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "admins only" });
  const { scoreBelow, dropPoints, criticalCount } = req.body || {};
  const rows = await db.select().from(s.orgs).where(eq(s.orgs.id, req.user.orgId));
  const settings = { ...(rows[0]?.settings as object || {}), coaching: { scoreBelow, dropPoints, criticalCount } };
  await db.update(s.orgs).set({ settings }).where(eq(s.orgs.id, req.user.orgId));
  res.json(await getRules(req.user.orgId));
});

// Needs-coaching queue: reason per employee, reused rules.
coachRouter2.get("/queue", async (req: any, res) => {
  const orgId = req.user.orgId;
  const rules = await getRules(orgId);
  const emps = await db.select().from(s.employees).where(eq(s.employees.orgId, orgId));
  const callRows = (await db.select().from(s.calls).where(eq(s.calls.orgId, orgId))).filter((c) => c.status === "done");
  const { mustPassIds } = await import("../lib/context.js");
  const mustIds = await mustPassIds(orgId);
  const crit = await db.select().from(s.criterionResults);
  const queue: any[] = [];
  for (const e of emps) {
    const mine = callRows.filter((c) => c.employeeId === e.id).sort((a, b) => +new Date(a.startedAt || 0) - +new Date(b.startedAt || 0));
    if (!mine.length) continue;
    const recent = mine.slice(-10), prev = mine.slice(-20, -10);
    const avgOf = (a: typeof mine) => a.reduce((x, c) => x + c.score, 0) / a.length;
    const score = Math.round(avgOf(recent) * 10) / 10;
    const reasons: string[] = [];
    if (score < rules.scoreBelow) reasons.push(`score ${score} below ${rules.scoreBelow}`);
    if (prev.length) {
      const drop = Math.round((avgOf(recent) - avgOf(prev)) * 10) / 10;
      if (drop <= -rules.dropPoints) reasons.push(`score fell ${-drop} points`);
    }
    const recentIds = new Set(recent.map((c) => c.id));
    const critFails = crit.filter((r) => recentIds.has(r.callId) && r.result === "fail" && mustIds.has(r.criterionId));
    const byCrit: Record<string, number> = {};
    for (const r of critFails) byCrit[r.criterionName] = (byCrit[r.criterionName] || 0) + 1;
    for (const [name, n] of Object.entries(byCrit)) if (n >= rules.criticalCount) reasons.push(`failed ${name} ${n} times`);
    if (reasons.length) queue.push({ employeeId: e.id, name: e.name, department: e.department, score, reasons });
  }
  queue.sort((a, b) => a.score - b.score);
  res.json({ rules, queue });
});

// sessions list (per employee) for the profile Coaching tab
coachRouter2.get("/sessions", async (req: any, res) => {
  const { employeeId } = req.query as any;
  let rows = await db.select().from(s.coachingSessions).where(eq(s.coachingSessions.orgId, req.user.orgId));
  if (employeeId) rows = rows.filter((x) => x.employeeId === employeeId);
  rows.sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0));
  res.json(rows);
});

// action items
coachRouter2.get("/actions", async (req: any, res) => {
  const { employeeId, status } = req.query as any;
  let rows = await db.select().from(s.actionItems).where(eq(s.actionItems.orgId, req.user.orgId));
  if (employeeId) rows = rows.filter((x) => x.employeeId === employeeId);
  if (status) rows = rows.filter((x) => x.status === status);
  rows.sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0));
  res.json(rows);
});
coachRouter2.post("/actions", async (req: any, res) => {
  const { employeeId, text, source } = req.body || {};
  if (!employeeId || !text?.trim()) return res.status(400).json({ error: "employeeId + text required" });
  const emps = await db.select().from(s.employees).where(and(eq(s.employees.id, employeeId), eq(s.employees.orgId, req.user.orgId)));
  if (!emps.length) return res.status(404).json({ error: "employee not found" });
  const [a] = await db.insert(s.actionItems).values({ orgId: req.user.orgId, employeeId, text: text.trim(), source: source || "manual" }).returning();
  res.json(a);
});
coachRouter2.patch("/actions/:id", async (req: any, res) => {
  const { status, text } = req.body || {};
  const rows = await db.select().from(s.actionItems).where(eq(s.actionItems.id, req.params.id));
  if (!rows.length || rows[0].orgId !== req.user.orgId) return res.status(404).json({ error: "not found" });
  const [a] = await db.update(s.actionItems)
    .set({ ...(status && { status }), ...(text && { text }) })
    .where(eq(s.actionItems.id, req.params.id)).returning();
  res.json(a);
});
coachRouter2.delete("/actions/:id", async (req: any, res) => {
  const rows = await db.select().from(s.actionItems).where(eq(s.actionItems.id, req.params.id));
  if (!rows.length || rows[0].orgId !== req.user.orgId) return res.status(404).json({ error: "not found" });
  await db.delete(s.actionItems).where(eq(s.actionItems.id, req.params.id));
  res.json({ ok: true });
});
