// One-way migration: legacy QA scorecards -> Markdown guidelines + approved criteria.
// Preserves every criterion (as a guideline section + a criterion citing it).
// Run: pnpm --filter @arocall/api migrate
import "./lib/env.js";
import { eq } from "drizzle-orm";
import { db, pool } from "./db/client.js";
import * as s from "./db/schema.js";
import { ensureSchema } from "./db/migrate.js";
import { hashContent, splitSections } from "./lib/guidelines.js";

await ensureSchema();
const orgs = await db.select().from(s.orgs);
for (const org of orgs) {
  const existing = await db.select().from(s.guidelines).where(eq(s.guidelines.orgId, org.id));
  if (existing.length) { console.log(`${org.name}: guidelines already present, skip`); continue; }
  const sc = await db.select().from(s.scorecards).where(eq(s.scorecards.orgId, org.id));
  sc.sort((a, b) => b.version - a.version);
  const criteria = (sc[0]?.criteria as any[]) || [];
  const md = criteria.length
    ? `# Imported QA Scorecard\n\nMigrated from scorecard v${sc[0].version}. Edit freely — this document is now the source of truth for scoring.\n\n` +
      criteria.map((c) => `## ${c.name}\n\n${c.description || ""}\n\n- Weight: ${c.weight}${c.mustPass ? " (must-pass)" : ""}\n- Pass guidance: ${c.guidance || "—"}\n`).join("\n")
    : `# Call Handling Guidelines\n\nReplace this starter content with company policy.\n\n## Greeting\n\nGreet every caller with name and company.\n`;
  const [d] = await db.insert(s.guidelines).values({ orgId: org.id, title: "Call Handling Guidelines", status: "active", currentVersion: 1, createdBy: "migration" }).returning();
  const sections = splitSections(md).map(({ id, path, level, title }) => ({ id, path, level, title }));
  await db.insert(s.guidelineVersions).values({ guidelineId: d.id, version: 1, markdown: md, contentHash: hashContent(md), sections, createdBy: "migration" });
  const crit = criteria.map((c: any) => {
    const sec = sections.find((x) => x.title.toLowerCase().includes(String(c.name).toLowerCase().split(" ")[0])) || sections[0];
    return { id: String(c.id), name: c.name, description: c.description || "", weight: Number(c.weight) || 10, mustPass: !!c.mustPass, guidance: c.guidance || "", guidelineRefs: [`${d.id}:${sec.id}`] };
  });
  if (crit.length) {
    await db.insert(s.criteriaSets).values({ orgId: org.id, version: 1, status: "approved", criteria: crit, guidelineRefs: { [d.id]: 1 }, stale: false });
  }
  console.log(`${org.name}: migrated ${criteria.length} criteria -> guideline + approved set v1`);
}
await pool.query("DROP TABLE IF EXISTS scorecards");
console.log("dropped legacy scorecards table");
await pool.end();
