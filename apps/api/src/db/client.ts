import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

// Timestamp-without-tz columns must be read as UTC instants. Previously pg
// parsed e.g. "10:46" (stored by a Postgres whose timezone was
// America/New_York) as API-local time (CET), so JS age math
// (Date.now() - created_at) was off by the tz gap — coaching sessions were
// instantly judged "expired" (age ~6h > join timeout) and expired on first
// read, before the coach bot could ever join. Pinning the session to UTC and
// parsing naive timestamps as UTC makes DB time and JS time the same domain.
pg.types.setTypeParser(1114, (v: string) => new Date(v.replace(" ", "T") + "Z"));
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || "postgres://postgres:toor@localhost:5432/arocall",
  options: "-c timezone=UTC",
});
export const db = drizzle(pool);
export { pool };
