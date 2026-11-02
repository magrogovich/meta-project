# Arocall (MVP)
AI QA for 100% of call-center calls. Stack: pnpm workspaces · Express 5 + esbuild + Pino · PostgreSQL + Drizzle · React 19 + Vite 7 + Tailwind 4 + Wouter + React Query · Radix dialog + shadcn-style classes · Zod. All Muse reasoning behind `apps/api/src/lib/muse.ts` (mock when no keys).

## Quickstart
1. `createdb arocall` (or it uses postgres://postgres:toor@localhost:5432/arocall from `.env`)
2. `pnpm install` (in root, apps/api, apps/web)
3. `pnpm --filter @arocall/api test` — scoring tests (schema, verbatim quotes, weighted score)
4. `pnpm --filter @arocall/api seed` — demo org login `demo@arocall.ai / demo1234`, 5 employees × 12 calls over 60 days (improver, decliner, strong, empathy-weak, average) + 2 failed + supervisor requests + human-flagged session
5. `pnpm dev` — starts API :4000 + dashboard :5173 together (logs prefixed `[api]` / `[web]`)

## Dashboard
Default range: last 30 days vs previous 30 days (custom ranges compare against the preceding equal-length period). Six KPI cards (QA score, pass rate, critical failure rate, sentiment, resolution, coverage — each with delta, sparkline, tooltip definition, click-through to Calls), severity-ranked Needs attention (critical / warning / info, 8 max), score trend with target line + volume bars (weekly when range > 60d, "Not enough data" under 3 points), criteria pass rates (worst first, click to failed calls), Agent × criteria heatmap (gray = fewer than 3 calls, click a cell for that employee's failed calls), sortable agents table, conversation metrics (talk ratio, dead air %, interruptions, handle time, pace — computed in code from timestamps), recent 5 calls. Scores: green ≥ target, amber ≥ pass threshold, red below. No data shows "—", never 0. Histogram moved to Analytics (average + median).

Demo flow: login → walkthrough (Help) → Guidelines (upload Markdown, write your own, or starter template → Activate → generate + approve criteria) → Employees (add via wizard, copy/reveal the persistent session key) → employee profile → call detail (audio + transcript click-to-seek + evidence quotes with guideline citations) → coaching memos + AI coaching via Google Meet (or in-app fallback).
Agent: `cd agent && npm run setup` (paste key) then `npm start`; drop a .wav into `agent/inbox/` to simulate a recorded call — it chunk-uploads and appears analyzed. Keys are persistent and revealable (masked + eye icon, copy logged); regenerate/revoke from the employee Agent tab. Revoked keys make the agent show a clear error and pause uploads. Production Linux capture: `desktop-app/` (tray, VAD, dual-track Opus, heartbeat).

## Database / migrations
No manual schema push needed: the API runs `ensureSchema()` (`apps/api/src/db/migrate.ts`) on boot and the seed script runs it too, creating all tables with `CREATE TABLE IF NOT EXISTS`. Just create the empty database and start the API.
If you change `apps/api/src/db/schema.ts`, apply the diff with drizzle-kit: `pnpm --filter @arocall/api db:push` (uses `drizzle.config.ts` + `DATABASE_URL`).

## Settings
Settings page (admin-gated writes): organization name, team invites (evaluator role; accept via the invite link), departments (rename cascades to employees) + offered languages, Quality targets (QA target default 80, pass threshold 70, drop alert 10 pts, repeated-failure count — feeds KPIs, trend target and coaching queue), coaching rules (same values, shared by the queue), **Integrations > Google** (Meet space creation, see below), retention window with a manual cleanup run, and the audit log (key reveals/copies, call views, cleanup runs, coach start/end/human-flag).

## Call analysis fields
Each analyzed call stores: per-criterion results (verbatim quote + timestamp + guideline section), customer sentiment start/end + issue resolved + supervisor request (each with verbatim quote + timestamp, "AI estimate" in the UI), and computed conversation metrics (talk:listening ratio, dead air %, interruptions, handle time, agent WPM — from transcript timestamps in `lib/conversation.ts`, never the LLM). Older calls show "—" until `Re-run analysis` (single or date-range bulk) backfills them.

## Env
See `.env.example`. All Muse calls live in `apps/api/src/lib/muse.ts` (swap models by config):
- `MODEL_API_KEY` — one Meta Model API key for everything. Unset (or `MUSE_MOCK=true`) = deterministic mock paths, labeled "MOCK"/"mock Muse" in the UI.
- `MUSE_LLM_MODEL` (default `muse-spark-1.3-contributor`) — reasoning: criteria generation, call scoring/reports, coaching replies. Chat Completions API, temp 0.1, JSON mode; evidence quotes verified verbatim and totals computed in code.
- `GUIDELINE_TOKEN_BUDGET` (default 60000) — active guidelines below this are included in full in every scoring prompt; above it, only mandatory sections are sent. Shown on the Guidelines page.
- `MUSE_STT_MODEL` (default `muse-voice-transcribe-1.0`) — transcription via `POST /v1/asr/transcribe`. Stereo recordings are split (Agent=L, Customer=R) and each channel transcribed with ENDPOINTING for turn timestamps; mixed mono uses DIARIZATION. `languageBias` is set from the call language (en/fr/de/es); domain keyword bias: "Arocall".
- TTS: Muse offers no speech-synthesis model, so the Meet coach speaks via OpenAI TTS (`OPENAI_API_KEY`, `OPENAI_TTS_MODEL` default `gpt-4o-mini-tts-2025-12-15`, voice `coral`); the in-app fallback (`COACH_TRANSPORT=inapp`, `/coach/:id`) uses browser `speechSynthesis`. Captions/STT in the session use the Web Speech API (the realtime `wss://.../asr/realtime` endpoint is available when a native live-caption client is built).
Google login without `GOOGLE_CLIENT_ID` = mock email passthrough (labeled). Audio stored locally in `STORAGE_DIR` (object-storage interface: swap `saveAudio` for S3). No TODO stubs in core flows.

## AI coaching via Google Meet

How it works: admin clicks **Start AI coaching** on an employee (memo + focus topics, optional manual Meet link) → backend creates a Meet space (`POST meet.googleapis.com/v2/spaces`, `accessType: OPEN`) with the org's stored Google token, or uses the pasted link → `coaching_sessions` row in `waiting_for_employee` → `coach-bot/` joins as **"Arocall AI Coach"** → employee opens the **Coaching room** (`/coach-room/:id?token=`) and joins the Meet → bot greets by voice → LISTENING / THINKING / SPEAKING loop (Muse LLM with the existing `coachSystemPrompt` + full history, OpenAI TTS sentence-by-sentence, `webrtcvad` barge-in) → `ended` / `expired` / `failed` → existing summary + action-items flow writes to the employee profile.

### Coaching room page
`/coach-room/:id?token=` (employee link; admins use their bearer session): left panel has status pill (`Waiting for you` / `live` / `ended` / `expired` / `failed`), timer, **Join the Meet** button, copy + email link, and — when Google isn't connected — a manual-link box plus **Use browser mode instead** (`/coach/:id`, the kept in-app fallback with browser `speechSynthesis`). Main panel is the live transcript (polls `GET /api/coach/:id/room` every 1.5s; interrupted turns badged), the AI notice (*"You are talking to an AI coach. This session is recorded and summarized. AI assists, humans decide."*), **Request human evaluator** / **End session** controls, and the final summary + agreed action items (also saved on the profile).

### Backend reference
- Services: `apps/api/src/lib/coach.ts` (`MeetTransport` interface + `transportFor()`, `trimHistory`, human/goodbye regexes), `lib/meet.ts` (OAuth URL, code exchange, `createMeetSpace`), `lib/openaiTts.ts` (speech endpoint + `splitSentences`), `lib/coachingLoop.ts` (testable LISTENING/THINKING/SPEAKING machine: barge-in, fallback line, 3-strikes → `failed`, goodbye/max-duration end). Prompt builder, safety rules, and summary flow are unchanged (`lib/muse.ts:228 coachSystemPrompt`).
- Tables (`db/schema.ts`, auto-migrated by `db/migrate.ts`): `coaching_sessions` += `transport, meet_space_name/url, status, started_at/ended_at, bot_error, tts_chars`; new `coaching_turns(session, idx, role, text, interrupted, audio_ms)` and `google_integrations(org, encrypted tokens, expiry)`.
- Endpoints: `POST /api/coach` (create space + session, audit `coach_start`), `GET /api/coach/:id/room` (status + turns, lazy expiry), `POST /api/coach/:id/end`, `POST /api/coach/:id/flag` (audit `coach_human_flag`, surfaces in dashboard Needs attention), `PATCH /api/coach/:id/meet-link` (admin manual fallback), `GET /api/coach/bot/pending` + `POST /api/coach/bot/callback` (`x-bot-secret` = `COACH_BOT_SECRET`; persists turns/summary/items, audit `coach_ended|expired|failed`), `GET|POST /api/settings/integrations/google*` (connect URL, status, disconnect, public OAuth callback → redirects to `FRONTEND_URL/settings?google=connected|error`).
- Config: `COACH_TRANSPORT=meet|inapp` (default `meet`), `OPENAI_API_KEY` (empty = mock TTS), `OPENAI_TTS_MODEL` (default `gpt-4o-mini-tts-2025-12-15`), `OPENAI_TTS_VOICE` (`coral`), `OPENAI_TTS_INSTRUCTIONS`, `COACH_MAX_SESSION_MIN=25` (cost guard; `tts_chars` logged per session), `COACH_JOIN_TIMEOUT_MIN=10` (→ `expired`), `COACH_BOT_SECRET`, `COACH_BOT_PROFILE_DIR`, `COACH_BOT_HEADLESS`, `GOOGLE_REDIRECT_URI`, `FRONTEND_URL`. Keys are never logged.

### Google setup (two flows, one Client ID)
Google Cloud → APIs & Services → Credentials → OAuth 2.0 Client (Web app):
- **Authorised JavaScript origins**: `http://localhost:5173`, `https://app.arofield.com` (+ `http://localhost:4000` harmless). Used by the GIS **login** button (`POST /api/auth/google`, scopes `openid email profile` only — no consent screen, no redirect).
- **Authorised redirect URIs**: keep `http://localhost:4000/api/auth/google/callback` (legacy, unused) and add `http://localhost:4000/api/settings/integrations/google/callback-public` (prod: your API origin + same path). Used by **Meet connect** (scope `meetings.space.created`, `access_type=offline`, `state=orgId`).
- **OAuth consent screen**: app stays in **Testing** for the hackathon. Add every admin/bot-tester Gmail under **Test users** — otherwise Meet connect fails with `403 access_denied` ("has not completed the Google verification process"). Login keeps working without this because it never hits the sensitive-scope consent screen.
- **Library**: enable **Google Meet API** (else `spaces.create` 403s). Then Settings → Integrations → Connect Google account → approve → redirected back to `/settings?google=connected` with a green pill. Without it, paste a `meet.google.com` link when starting a session.

### Coach bot (Linux only, `coach-bot/`, full doc in `coach-bot/README.md`)
- Install: `cd coach-bot && npm i && npx playwright install chromium`. Needs `pactl`/`paplay` (PulseAudio/PipeWire), one **dedicated** bot Google account.
- `npm run login` — one-time headed login (profile in `$COACH_BOT_PROFILE_DIR`); `npm run join -- <meetUrl>` — headed debug join; `npm run test-say -- <meetUrl> "sentence"` — prove TTS is audible in the meeting; `npm start` — poll `bot/pending` every 10s and run sessions.
- Audio per session: null sink `meet_in_*` (Chromium out via `PULSE_SINK`, bot records `meet_in.monitor`), null sink `coach_out_*` + virtual source `coach_mic_*` (Chromium mic via `PULSE_SOURCE`, TTS played with `paplay`). Removed after the session. Verify: `pactl list short sinks | grep -E 'meet_in|coach_out'` and `pactl list short sources | grep coach_mic`.
- Meet join: name field → "Arocall AI Coach", camera off, mic on, Join now (selectors isolated in `src/selectors.ts`; screenshot to `$COACH_BOT_DEBUG_DIR` on any step failure). Human presence = participant count ≥ 2 + speech on `meet_in.monitor` before greeting. Employee leaves (< 2 participants 60s) → clean end.

### Limitations (hackathon build)
No official Meet bot API — this is Playwright UI automation and will break when Google changes the Meet UI (update `coach-bot/src/selectors.ts`). Check Google ToS before any production use. One bot account per profile; concurrent sessions need separate profiles/sinks. English-only TTS/STT for now. Meet chat posting is skipped (fragile).

### Testing
- Unit: `pnpm --filter @arocall/api test` — 25 tests incl. `src/coachMeet.test.ts` (normal turn, barge-in marks turn, fallback + 3-strikes → `failed`, history trim, lifecycle/max-duration/goodbye, org isolation via existing route guards).
- Manual end-to-end: create session → room `waiting_for_employee` + Meet link → bot joins → join as employee → greeting audible → talk → reply audible + transcript updates → interrupt → playback stops + `interrupted` badge → End → summary + action items on employee profile; Request human → dashboard Needs attention entry.
