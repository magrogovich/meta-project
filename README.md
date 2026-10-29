# Arocall (MVP)
AI QA for 100% of call-center calls. Stack: pnpm workspaces · Express 5 + esbuild + Pino · PostgreSQL + Drizzle · React 19 + Vite 7 + Tailwind 4 + Wouter + React Query · Radix dialog + shadcn-style classes · Zod. All Muse reasoning behind `apps/api/src/lib/muse.ts` (mock when no keys).

## Quickstart
1. `createdb arocall` (or it uses postgres://postgres:toor@localhost:5432/arocall from `.env`)
2. `pnpm install` (in root, apps/api, apps/web)
3. `pnpm --filter @arocall/api test` — scoring tests (schema, verbatim quotes, weighted score)
4. `pnpm --filter @arocall/api seed` — demo org login `demo@arocall.ai / demo1234`, 5 employees × 8 calls
5. `pnpm dev` — starts API :4000 + dashboard :5173 together (logs prefixed `[api]` / `[web]`)

Demo flow: login → walkthrough (Help) → Guidelines (Phase 6: Markdown; until then QA scorecard page is hidden) → Employees (add via wizard, copy/reveal the persistent session key) → employee profile → call detail (audio + transcript click-to-seek + evidence quotes) → coaching memos + AI coaching voice session.
Agent: `cd agent && npm run setup` (paste key) then `npm start`; drop a .wav into `agent/inbox/` to simulate a recorded call — it chunk-uploads and appears analyzed. Keys are persistent and revealable (masked + eye icon, copy logged); regenerate/revoke from the employee Agent tab. Revoked keys make the agent show a clear error and pause uploads.

## Database / migrations
No manual schema push needed: the API runs `ensureSchema()` (`apps/api/src/db/migrate.ts`) on boot and the seed script runs it too, creating all tables with `CREATE TABLE IF NOT EXISTS`. Just create the empty database and start the API.
If you change `apps/api/src/db/schema.ts`, apply the diff with drizzle-kit: `pnpm --filter @arocall/api db:push` (uses `drizzle.config.ts` + `DATABASE_URL`).

## Env
See `.env.example`. All Muse calls live in `apps/api/src/lib/muse.ts` (swap models by config):
- `MODEL_API_KEY` — one Meta Model API key for everything. Unset (or `MUSE_MOCK=true`) = deterministic mock paths, labeled "MOCK"/"mock Muse" in the UI.
- `MUSE_LLM_MODEL` (default `muse-spark-1.3-contributor`) — reasoning: scorecard extraction, call scoring/reports, coaching replies. Chat Completions API, temp 0.1, JSON mode; evidence quotes verified verbatim and totals computed in code.
- `MUSE_STT_MODEL` (default `muse-voice-transcribe-1.0`) — transcription via `POST /v1/asr/transcribe`. Stereo recordings are split (Agent=L, Customer=R) and each channel transcribed with ENDPOINTING for turn timestamps; mixed mono uses DIARIZATION. `languageBias` is set from the call language (en/fr/de/es); domain keyword bias: "Arocall".
- TTS: Muse offers no speech-synthesis model, so the coach speaks via browser `speechSynthesis`; captions/STT in the session use the Web Speech API (the realtime `wss://.../asr/realtime` endpoint is available when a native live-caption client is built).
Google login without `GOOGLE_CLIENT_ID` = mock email passthrough (labeled). Audio stored locally in `STORAGE_DIR` (object-storage interface: swap `saveAudio` for S3). No TODO stubs in core flows.
