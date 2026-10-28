import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import * as s from "../db/schema.js";

const JWT = process.env.JWT_SECRET || "dev-secret-change-me";
export const authMw: any = (req: any, res: any, next: any) => {
  const h = req.headers.authorization || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ error: "unauthorized" });
  try { (req as any).user = jwt.verify(tok, JWT) as any; next(); } catch { return res.status(401).json({ error: "bad token" }); }
};
export const sign = (u: any) => jwt.sign({ id: u.id, orgId: u.orgId, email: u.email, role: u.role }, JWT, { expiresIn: "7d" });

export const authRouter = Router();
authRouter.post("/signup", async (req, res) => {
  const { email, password, name, orgName } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email + password required" });
  const existing = await db.select().from(s.users).where(eq(s.users.email, email));
  if (existing.length) return res.status(400).json({ error: "email taken" });
  const [org] = await db.insert(s.orgs).values({ name: orgName || `${email.split("@")[0]}'s org` }).returning();
  const hash = await bcrypt.hash(password, 10);
  const [user] = await db.insert(s.users).values({ orgId: org.id, email, name: name || email.split("@")[0], passwordHash: hash, role: "admin" }).returning();
  await db.insert(s.scorecards).values({ orgId: org.id, version: 1, criteria: (await import("../lib/muse.js")).DEFAULT_CRITERIA, sourceText: "Default QA scorecard" });
  res.json({ token: sign(user), user: { id: user.id, email: user.email, role: user.role, orgId: org.id } });
});
authRouter.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  const rows = await db.select().from(s.users).where(eq(s.users.email, email));
  if (!rows.length || !(await bcrypt.compare(password, rows[0].passwordHash || ""))) return res.status(401).json({ error: "bad credentials" });
  res.json({ token: sign(rows[0]), user: { id: rows[0].id, email: rows[0].email, role: rows[0].role, orgId: rows[0].orgId } });
});
// "Continue with Google" — real OAuth needs GOOGLE_CLIENT_ID; MVP mock accepts email+name and labels it.
authRouter.post("/google", async (req, res) => {
  const { email, name } = req.body || {};
  if (!email) return res.status(400).json({ error: "email required" });
  let rows = await db.select().from(s.users).where(eq(s.users.email, email));
  if (!rows.length) {
    const [org] = await db.insert(s.orgs).values({ name: `${email.split("@")[0]}'s org` }).returning();
    const [u] = await db.insert(s.users).values({ orgId: org.id, email, name: name || email.split("@")[0], role: "admin" }).returning();
    await db.insert(s.scorecards).values({ orgId: org.id, version: 1, criteria: (await import("../lib/muse.js")).DEFAULT_CRITERIA, sourceText: "Default QA scorecard" });
    rows = [u];
  }
  res.json({ token: sign(rows[0]), mock: !process.env.GOOGLE_CLIENT_ID, user: { id: rows[0].id, email: rows[0].email, role: rows[0].role, orgId: rows[0].orgId } });
});
authRouter.post("/invite", authMw, async (req: any, res) => {
  const { email } = req.body || {};
  const token = "inv_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  await db.insert(s.invites).values({ orgId: req.user.orgId, email, token });
  res.json({ inviteLink: `/accept-invite?token=${token}`, token });
});
authRouter.post("/accept-invite", async (req, res) => {
  const { token, email, password, name } = req.body || {};
  const rows = await db.select().from(s.invites).where(eq(s.invites.token, token));
  if (!rows.length) return res.status(400).json({ error: "bad invite" });
  const hash = await bcrypt.hash(password || "temp", 10);
  const [u] = await db.insert(s.users).values({ orgId: rows[0].orgId, email: email || rows[0].email, name: name || "Evaluator", passwordHash: hash, role: "evaluator" }).returning();
  res.json({ token: sign(u) });
});
