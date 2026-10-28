// Load .env from the nearest location, so the API works whether you start it
// from the repo root (`pnpm --filter @arocall/api dev`) or inside apps/api.
// Real environment variables always win (dotenv never overrides existing vars).
import dotenv from "dotenv";
import { existsSync } from "fs";
import { join, resolve } from "path";

const candidates = [
  join(process.cwd(), "..", "..", ".env"),
  join(process.cwd(), "..", ".env"),
  join(process.cwd(), ".env"),
];
for (const p of candidates.map((x) => resolve(x))) {
  if (existsSync(p)) dotenv.config({ path: p });
}
