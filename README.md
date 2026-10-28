# Arocall (MVP)
AI QA for 100% of call-center calls. Stack: pnpm workspaces · Express 5 + esbuild + Pino · PostgreSQL + Drizzle · React 19 + Vite 7 + Tailwind 4 + Wouter + React Query · Radix dialog + shadcn-style classes · Zod. All Muse reasoning behind `apps/api/src/lib/muse.ts` (mock when no keys).

## Quickstart
1. `createdb arocall` (or it uses postgres://postgres:toor@localhost:5432/arocall from `.env`)
2. `pnpm install` (in root, apps/api, apps/web)
3. `pnpm --filter @arocall/api test` — scoring tests (schema, verbatim quotes, weighted score)
4. `pnpm --filter @arocall/api seed` — demo org login `demo@arocall.ai / demo1234`, 5 employees × 8 calls
5. `pnpm --filter @arocall/api dev` — API :4000
6. `pnpm --filter @arocall/web dev` — dashboard :5173

Demo flow: signup/login → walkthrough (Help) → Scorecard paste policy → Employees add (copy session key ONCE) → employee profile shows seeded calls → call detail (audio + transcript click-to-seek + evidence quotes) → Generate memo → Print/PDF → Start AI coaching → open link → voice/text coach (Web Speech + speechSynthesis; mock-labeled without MUSE keys).
Agent: `cd agent && npm run setup` (paste key) then `npm start`; drop a .wav into `agent/inbox/` to simulate a recorded call — it chunk-uploads and appears analyzed.

## Env
See `.env.example`. `MUSE_API_URL` + `MUSE_API_KEY` unset = deterministic mock everywhere (labeled "MOCK"/"mock Muse" in UI). Google login without `GOOGLE_CLIENT_ID` = mock email passthrough (labeled). Audio stored locally in `STORAGE_DIR` (object-storage interface: swap `saveAudio` for S3). No TODO stubs in core flows.
