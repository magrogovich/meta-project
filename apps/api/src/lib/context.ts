import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import * as s from "../db/schema.js";

// Must-pass criterion ids from the approved criteria set (default: compliance).
export async function mustPassIds(orgId: string): Promise<Set<string>> {
  const sets = await db.select().from(s.criteriaSets).where(eq(s.criteriaSets.orgId, orgId));
  sets.sort((a, b) => b.version - a.version);
  const approved = sets.find((x) => x.status === "approved");
  if (approved) return new Set(((approved.criteria as any[]) || []).filter((c) => c.mustPass).map((c) => c.id));
  return new Set(["compliance"]);
}
