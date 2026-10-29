import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import * as s from "../db/schema.js";
import { authMw } from "./auth.js";

export const settingsRouter = Router();
settingsRouter.use(authMw);
const isAdmin = (req: any) => req.user.role === "admin";

settingsRouter.get("/", async (req: any, res) => {
  const orgs = await db.select().from(s.orgs).where(eq(s.orgs.id, req.user.orgId));
  const users = await db.select().from(s.users).where(eq(s.users.orgId, req.user.orgId));
  const emps = await db.select().from(s.employees).where(eq(s.employees.orgId, req.user.orgId));
  const calls = await db.select().from(s.calls).where(eq(s.calls.orgId, req.user.orgId));
  res.json({
    org: { id: orgs[0]?.id, name: orgs[0]?.name, settings: orgs[0]?.settings || {} },
    counts: { users: users.length, employees: emps.length, calls: calls.length },
  });
});

settingsRouter.patch("/org", async (req: any, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "admins only" });
  const { name } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: "name required" });
  await db.update(s.orgs).set({ name: name.trim() }).where(eq(s.orgs.id, req.user.orgId));
  res.json({ ok: true });
});

// App preferences: allowed languages + retention window (days, 0 = keep forever).
settingsRouter.patch("/preferences", async (req: any, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "admins only" });
  const { languages, retentionDays } = req.body || {};
  const rows = await db.select().from(s.orgs).where(eq(s.orgs.id, req.user.orgId));
  const cur = (rows[0]?.settings as any) || {};
  const next = {
    ...cur,
    ...(languages && { languages: languages.filter((l: string) => ["en", "fr", "de", "es"].includes(l)) }),
    ...(retentionDays !== undefined && { retentionDays: Math.max(0, Number(retentionDays) || 0) }),
  };
  await db.update(s.orgs).set({ settings: next }).where(eq(s.orgs.id, req.user.orgId));
  res.json({ settings: next });
});

// ---- team ----
settingsRouter.get("/team", async (req: any, res) => {
  const users = await db.select().from(s.users).where(eq(s.users.orgId, req.user.orgId));
  res.json(users.map(({ passwordHash, ...u }) => u));
});

settingsRouter.delete("/team/:id", async (req: any, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "admins only" });
  if (req.params.id === req.user.id) return res.status(400).json({ error: "cannot remove yourself" });
  const users = await db.select().from(s.users).where(eq(s.users.orgId, req.user.orgId));
  if (users.filter((u) => u.role === "admin").length <= 1 && users.find((u) => u.id === req.params.id)?.role === "admin")
    return res.status(400).json({ error: "cannot remove the last admin" });
  await db.delete(s.users).where(and(eq(s.users.id, req.params.id), eq(s.users.orgId, req.user.orgId)));
  res.json({ ok: true });
});

// ---- audit log ----
settingsRouter.get("/audit", async (req: any, res) => {
  const rows = await db.select().from(s.auditLog).where(eq(s.auditLog.orgId, req.user.orgId));
  rows.sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0));
  const users = await db.select().from(s.users).where(eq(s.users.orgId, req.user.orgId));
  const emps = await db.select().from(s.employees).where(eq(s.employees.orgId, req.user.orgId));
  const uName: Record<string, string> = {};
  for (const u of users) uName[u.id] = `${u.name} <${u.email}>`;
  const eName: Record<string, string> = {};
  for (const e of emps) eName[e.id] = e.name;
  res.json(rows.slice(0, 200).map((r) => ({ ...r, userLabel: uName[r.userId] || r.userId, targetLabel: eName[r.callId] || r.callId })));
});

// ---- retention: delete calls (and their results/audio refs) older than N days ----
settingsRouter.post("/retention/run", async (req: any, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "admins only" });
  const orgs = await db.select().from(s.orgs).where(eq(s.orgs.id, req.user.orgId));
  const days = Math.max(1, Number(req.body?.days) || Number((orgs[0]?.settings as any)?.retentionDays) || 0);
  if (!days) return res.status(400).json({ error: "no retention window configured" });
  const cutoff = Date.now() - days * 864e5;
  const old = (await db.select().from(s.calls).where(eq(s.calls.orgId, req.user.orgId)))
    .filter((c) => +new Date(c.startedAt || 0) < cutoff);
  for (const c of old) {
    await db.delete(s.criterionResults).where(eq(s.criterionResults.callId, c.id));
    await db.delete(s.calls).where(eq(s.calls.id, c.id));
  }
  await db.insert(s.auditLog).values({ orgId: req.user.orgId, userId: req.user.id, action: "retention_run", callId: `${old.length} calls older than ${days}d` });
  res.json({ ok: true, deleted: old.length });
});
