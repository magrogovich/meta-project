import "dotenv/config";
import express from "express";
import cors from "cors";
import pino from "pino";
import pinoHttp from "pino-http";
import { pool } from "./db/client.js";
import { ensureSchema } from "./db/migrate.js";
import * as schema from "./db/schema.js";
import { authRouter } from "./routes/auth.js";
import { empRouter } from "./routes/employees.js";
import { miscRouter } from "./routes/calls.js";

const log = pino({ level: "info" });
const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(pinoHttp({ logger: log }));

// auto-migrate: create tables if missing (MVP; drizzle-kit for diffs)
await ensureSchema();

app.get("/api/health", (_req, res) => res.json({ ok: true, mock: (process.env.MUSE_MOCK || "true") }));
app.use("/api/auth", authRouter);
app.use("/api/employees", empRouter);
app.use("/api", miscRouter);

const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, () => log.info(`api on :${PORT}`));
