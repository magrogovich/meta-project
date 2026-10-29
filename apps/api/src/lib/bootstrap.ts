import { db } from "../db/client.js";
import * as s from "../db/schema.js";
import { STARTER_TEMPLATE, hashContent, splitSections } from "./guidelines.js";
import { generateCriteria } from "./muse.js";

// New-organization bootstrap: active guidelines doc + approved criteria set.
export async function bootstrapOrg(orgId: string, by: string) {
  const [d] = await db.insert(s.guidelines).values({ orgId, title: "Call Handling Guidelines", status: "active", currentVersion: 1, createdBy: by }).returning();
  const sections = splitSections(STARTER_TEMPLATE).map(({ id, path, level, title }) => ({ id, path, level, title }));
  await db.insert(s.guidelineVersions).values({ guidelineId: d.id, version: 1, markdown: STARTER_TEMPLATE, contentHash: hashContent(STARTER_TEMPLATE), sections, createdBy: by });
  const { criteria } = await generateCriteria([{ guidelineId: d.id, version: 1, markdown: STARTER_TEMPLATE }]);
  if (criteria.length) {
    await db.insert(s.criteriaSets).values({ orgId, version: 1, status: "approved", criteria, guidelineRefs: { [d.id]: 1 }, stale: false });
  }
}
