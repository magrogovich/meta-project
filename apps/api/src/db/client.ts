import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || "postgres://postgres:toor@localhost:5432/arocall" });
export const db = drizzle(pool);
export { pool };
