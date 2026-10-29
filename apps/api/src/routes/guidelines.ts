import { Router } from "express";
import multer from "multer";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import * as s from "../db/schema.js";
import { authMw } from "./auth.js";
import { hashContent, splitSections, validateMarkdownUpload, estimateTokens, MAX_MD_BYTES } from "../lib/guidelines.js";

export const guideRouter = Router();
guideRouter.use(authMw);
const isAdmin = (req: any) => req.user.role === "admin";
const TOKEN_BUDGET = Number(process.env.GUIDELINE_TOKEN_BUDGET || 60000);

async function markCriteriaStale(orgId: string) {
  const sets = await db.select().from(s.criteriaSets).where(eq(s.criteriaSets.orgId, orgId));
  for (const set of sets.filter((x) => x.status === "approved")) {
    await db.update(s.criteriaSets).set({ stale: true }).where(eq(s.criteriaSets.id, set.id));
  }
}

async function saveVersion(guidelineId: string, orgId: string, markdown: string, by: string, activeBump: boolean) {
  const docs = await db.select().from(s.guidelines).where(and(eq(s.guidelines.id, guidelineId), eq(s.guidelines.orgId, orgId)));
  if (!docs.length) throw new Error("not found");
  const doc = docs[0];
  const version = doc.currentVersion + 1;
  const sections = splitSections(markdown).map(({ id, path, level, title }) => ({ id, path, level, title }));
  await db.insert(s.guidelineVersions).values({ guidelineId, version, markdown, contentHash: hashContent(markdown), sections, createdBy: by });
  await db.update(s.guidelines).set({ currentVersion: version, updatedAt: new Date() }).where(eq(s.guidelines.id, guidelineId));
  if (activeBump && doc.status === "active") await markCriteriaStale(orgId);
  return version;
}

// ---- documents ----
guideRouter.get("/", async (req: any, res) => {
  const docs = await db.select().from(s.guidelines).where(eq(s.guidelines.orgId, req.user.orgId));
  const sets = await db.select().from(s.criteriaSets).where(eq(s.criteriaSets.orgId, req.user.orgId));
  const approved = sets.filter((x) => x.status === "approved").sort((a, b) => b.version - a.version)[0] || null;
  const out = [];
  for (const d of docs) {
    const vers = await db.select().from(s.guidelineVersions).where(eq(s.guidelineVersions.guidelineId, d.id));
    vers.sort((a, b) => b.version - a.version);
    out.push({ ...d, versions: vers.map((v) => ({ version: v.version, hash: v.contentHash, by: v.createdBy, at: v.createdAt })), latestBy: vers[0]?.createdBy || "", latestAt: vers[0]?.createdAt || d.updatedAt });
  }
  out.sort((a, b) => +new Date(b.updatedAt || 0) - +new Date(a.updatedAt || 0));
  res.json({ docs: out, approvedCriteria: approved ? { version: approved.version, stale: approved.stale } : null });
});

guideRouter.post("/", async (req: any, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "admins only" });
  const { title, markdown } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: "title required" });
  if (!markdown?.trim()) return res.status(400).json({ error: "content required" });
  if (Buffer.byteLength(markdown, "utf8") > MAX_MD_BYTES) return res.status(400).json({ error: "content exceeds 1 MB" });
  const [d] = await db.insert(s.guidelines).values({ orgId: req.user.orgId, title: title.trim(), status: "draft", currentVersion: 1, createdBy: req.user.email }).returning();
  const sections = splitSections(markdown).map(({ id, path, level, title }) => ({ id, path, level, title }));
  await db.insert(s.guidelineVersions).values({ guidelineId: d.id, version: 1, markdown, contentHash: hashContent(markdown), sections, createdBy: req.user.email });
  res.json(d);
});

// Validate an upload and return content for editor review (not saved yet).
guideRouter.post("/upload", multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MD_BYTES + 1024 } }).single("file"), async (req: any, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "admins only" });
  const f = (req as any).file;
  if (!f) return res.status(400).json({ error: "no file" });
  try {
    const markdown = validateMarkdownUpload({ name: f.originalname, mime: f.mimetype, size: f.size, buffer: f.buffer });
    res.json({ fileName: f.originalname, title: f.originalname.replace(/\.(md|markdown)$/i, ""), markdown });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

guideRouter.get("/:id", async (req: any, res) => {
  const docs = await db.select().from(s.guidelines).where(and(eq(s.guidelines.id, req.params.id), eq(s.guidelines.orgId, req.user.orgId)));
  if (!docs.length) return res.status(404).json({ error: "not found" });
  const vers = await db.select().from(s.guidelineVersions).where(eq(s.guidelineVersions.guidelineId, docs[0].id));
  vers.sort((a, b) => b.version - a.version);
  const sections = splitSections(vers[0]?.markdown || "");
  const mandatory = (docs[0].mandatorySections as string[]) || [];
  res.json({ ...docs[0], markdown: vers[0]?.markdown || "", sections: sections.map((x) => ({ ...x, mandatory: mandatory.includes(x.id) })), versions: vers.map((v) => ({ version: v.version, hash: v.contentHash, by: v.createdBy, at: v.createdAt })) });
});

guideRouter.get("/:id/versions", async (req: any, res) => {
  const docs = await db.select().from(s.guidelines).where(and(eq(s.guidelines.id, req.params.id), eq(s.guidelines.orgId, req.user.orgId)));
  if (!docs.length) return res.status(404).json({ error: "not found" });
  const vers = await db.select().from(s.guidelineVersions).where(eq(s.guidelineVersions.guidelineId, req.params.id));
  vers.sort((a, b) => a.version - b.version);
  res.json(vers);
});

guideRouter.patch("/:id", async (req: any, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "admins only" });
  const { title, status } = req.body || {};
  const docs = await db.select().from(s.guidelines).where(and(eq(s.guidelines.id, req.params.id), eq(s.guidelines.orgId, req.user.orgId)));
  if (!docs.length) return res.status(404).json({ error: "not found" });
  if (status && !["draft", "active", "archived"].includes(status)) return res.status(400).json({ error: "bad status" });
  await db.update(s.guidelines).set({ ...(title && { title }), ...(status && { status }), updatedAt: new Date() }).where(eq(s.guidelines.id, req.params.id));
  res.json({ ok: true });
});

guideRouter.post("/:id/save", async (req: any, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "admins only" });
  const { markdown } = req.body || {};
  if (!markdown?.trim()) return res.status(400).json({ error: "content required" });
  if (Buffer.byteLength(markdown, "utf8") > MAX_MD_BYTES) return res.status(400).json({ error: "content exceeds 1 MB" });
  try {
    const version = await saveVersion(req.params.id, req.user.orgId, markdown, req.user.email, true);
    res.json({ ok: true, version });
  } catch { res.status(404).json({ error: "not found" }); }
});

guideRouter.post("/:id/restore", async (req: any, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "admins only" });
  const { version } = req.body || {};
  const vers = await db.select().from(s.guidelineVersions).where(eq(s.guidelineVersions.guidelineId, req.params.id));
  const src = vers.find((v) => v.version === Number(version));
  if (!src) return res.status(404).json({ error: "version not found" });
  const docs = await db.select().from(s.guidelines).where(and(eq(s.guidelines.id, req.params.id), eq(s.guidelines.orgId, req.user.orgId)));
  if (!docs.length) return res.status(404).json({ error: "not found" });
  const v = await saveVersion(req.params.id, req.user.orgId, src.markdown, req.user.email, true);
  res.json({ ok: true, version: v });
});

guideRouter.delete("/:id", async (req: any, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "admins only" });
  await db.delete(s.guidelineVersions).where(eq(s.guidelineVersions.guidelineId, req.params.id));
  await db.delete(s.guidelines).where(and(eq(s.guidelines.id, req.params.id), eq(s.guidelines.orgId, req.user.orgId)));
  res.json({ ok: true });
});

guideRouter.patch("/:id/mandatory", async (req: any, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "admins only" });
  const { sectionIds } = req.body || {};
  await db.update(s.guidelines).set({ mandatorySections: sectionIds || [], updatedAt: new Date() })
    .where(and(eq(s.guidelines.id, req.params.id), eq(s.guidelines.orgId, req.user.orgId)));
  res.json({ ok: true });
});

// Which scoring mode is active (full vs mandatory-only) + budget.
guideRouter.get("/status/mode", async (req: any, res) => {
  const docs = await db.select().from(s.guidelines).where(and(eq(s.guidelines.orgId, req.user.orgId), eq(s.guidelines.status, "active")));
  let tokens = 0;
  for (const d of docs) {
    const vers = await db.select().from(s.guidelineVersions).where(eq(s.guidelineVersions.guidelineId, d.id));
    vers.sort((a, b) => b.version - a.version);
    tokens += estimateTokens(vers[0]?.markdown || "");
  }
  res.json({ mode: tokens <= TOKEN_BUDGET ? "full" : "mandatory-only", totalTokens: tokens, budget: TOKEN_BUDGET, activeCount: docs.length });
});

// ---- evaluation criteria (derived layer) ----
guideRouter.get("/criteria/sets", async (req: any, res) => {
  const sets = await db.select().from(s.criteriaSets).where(eq(s.criteriaSets.orgId, req.user.orgId));
  sets.sort((a, b) => b.version - a.version);
  res.json(sets);
});

guideRouter.post("/criteria/generate", async (req: any, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "admins only" });
  const docs = await db.select().from(s.guidelines).where(and(eq(s.guidelines.orgId, req.user.orgId), eq(s.guidelines.status, "active")));
  if (!docs.length) return res.status(400).json({ error: "activate at least one guideline first" });
  const parts: { guidelineId: string; version: number; markdown: string }[] = [];
  for (const d of docs) {
    const vers = await db.select().from(s.guidelineVersions).where(eq(s.guidelineVersions.guidelineId, d.id));
    vers.sort((a, b) => b.version - a.version);
    parts.push({ guidelineId: d.id, version: d.currentVersion, markdown: vers[0]?.markdown || "" });
  }
  const { generateCriteria } = await import("../lib/muse.js");
  const { criteria } = await generateCriteria(parts);
  const sets = await db.select().from(s.criteriaSets).where(eq(s.criteriaSets.orgId, req.user.orgId));
  const version = sets.length ? Math.max(...sets.map((x) => x.version)) + 1 : 1;
  const refs: Record<string, number> = {};
  for (const p of parts) refs[p.guidelineId] = p.version;
  const [set] = await db.insert(s.criteriaSets).values({ orgId: req.user.orgId, version, status: "draft", criteria, guidelineRefs: refs, stale: false }).returning();
  res.json(set);
});

guideRouter.patch("/criteria/:id", async (req: any, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "admins only" });
  const { criteria, status } = req.body || {};
  const rows = await db.select().from(s.criteriaSets).where(eq(s.criteriaSets.id, req.params.id));
  if (!rows.length || rows[0].orgId !== req.user.orgId) return res.status(404).json({ error: "not found" });
  if (status && !["draft", "approved"].includes(status)) return res.status(400).json({ error: "bad status" });
  if (status === "approved") {
    const all = await db.select().from(s.criteriaSets).where(eq(s.criteriaSets.orgId, req.user.orgId));
    for (const o of all.filter((x) => x.status === "approved" && x.id !== req.params.id)) {
      await db.update(s.criteriaSets).set({ status: "draft" }).where(eq(s.criteriaSets.id, o.id));
    }
  }
  const [set] = await db.update(s.criteriaSets)
    .set({ ...(criteria && { criteria }), ...(status && { status, stale: false }) })
    .where(eq(s.criteriaSets.id, req.params.id)).returning();
  res.json(set);
});
