import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import * as s from "../db/schema.js";
import { authMw } from "./auth.js";

export const coachRouter2 = Router();
coachRouter2.use(authMw);

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
