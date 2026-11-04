# Coach Bot — Meet participant for AI coaching (Linux only)

Playwright + Chromium bot that joins a Google Meet as the coach, hears the employee via virtual audio, and drives the conversation loop (Muse LLM + history, OpenAI TTS per sentence, VAD barge-in). Controlled by the backend through a pending queue + callbacks. Hackathon build: stable and simple over perfect.

## The account model: ONE coach account for creating AND joining
Create one dedicated Google account for the coach (display name **"Arocall AI Coach"**).
- **Settings → Integrations → Connect Google** (in the platform): sign in with the coach account. This authorizes the *backend* to **create** Meet spaces via the API (`spaces.create`). Stored encrypted per org.
- **The bot joins signed in as that same account** (`COACH_BOT_JOIN_MODE=account`, default): run `npm run login` once (headed Chrome opens; sign in with the coach account, press ENTER). The account created the space, so Meet admits it as host.
- Guest mode (`COACH_BOT_JOIN_MODE=guest`) exists but is **not recommended**: spaces are OPEN, yet Google commonly rejects signed-out automation joins with "You can't join this video call" (verified against live spaces). The bot detects this page and reports it in `bot_error` instead of timing out silently.

## Run in Docker (recommended)

The bot needs its own audio stack: it creates virtual PulseAudio devices
and — since Chrome ignores `PULSE_SINK`/`PULSE_SOURCE` — must own the
*default* mic/speaker of its environment. Run on the same machine as a
human's browser, that hijacks the human's mic (the coach starts
transmitting the room) and routes the coach's voice into a silent sink
(the employee hears nothing). Docker gives the bot a private PulseAudio
server, an Xvfb display (Google rejects headless joins) and a persistent
Chrome profile; the host is never touched.

```bash
cd coach-bot
docker compose build
xhost +local:root                       # one-time: lets the login window open
docker compose run --rm bot login       # one-time: sign in with the coach account, press ENTER, let the window close itself
docker compose up -d bot                # run
docker compose logs -f bot
```

The profile persists in `~/.arocall/coach-bot-profile` (mounted at
`/profile`) — never store it in `/tmp` (wiped on reboot) and never kill
Chrome mid-login (Google revokes the session). Screenshots land in
`~/.arocall/coach-bot-debug`.

## Run on the host (only on a dedicated bot machine)

- Linux with PulseAudio/PipeWire: `pactl`, `paplay` installed.
- Node 20+, the coach Google account (dedicated, named "Arocall AI Coach").
- Backend API running (`pnpm dev` → `:4000`); same `COACH_BOT_SECRET` in API `.env` and this service's env.
- During a session the bot switches the machine's default sink/source to
  its virtual devices and restores them afterwards. Do not run it on a
  machine a human is using for calls at the same time.

```bash
cd coach-bot
npm i
npx playwright install chromium
```

## Env
Copy values into `coach-bot/.env` (created for you, git-ignored, auto-loaded via dotenv).
`COACH_BOT_SECRET` must equal the API's root `.env` value.
| Var | Default | Purpose |
|---|---|---|
| `ARO_API` | `http://localhost:4000` | Backend base URL |
| `COACH_BOT_SECRET` | `dev-bot-secret` | `x-bot-secret` for `/api/coach/bot/pending` + `/api/coach/bot/callback` |
| `COACH_BOT_PROFILE_DIR` | `/tmp/opencode/coach-bot-profile` | Persistent Chromium profile (bot Google login lives here) |
| `COACH_BOT_HEADLESS` | `false` | Headed is required in practice: Google rejects headless Meet joins ("You can't join this video call" / 400 pages). Run on a desktop (`DISPLAY=:0 npm start`) or under Xvfb on servers. Repeated join retries also get rate-limited — the bot now backs off and reports it instead of hammering. |
| `COACH_BOT_DEBUG_DIR` | `/tmp/opencode/coach-bot-debug` | Failure screenshots |
| `COACH_MAX_SESSION_MIN` | `25` | Cost/duration guard |
| `OPENAI_API_KEY` | — | Empty = mock TTS (logs text, plays nothing) |
| `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts-2025-12-15` | TTS model |
| `OPENAI_TTS_VOICE` | `coral` | TTS voice |
| `OPENAI_TTS_INSTRUCTIONS` | `Warm, calm, supportive coach. Natural pace.` | TTS style |

## Usage
```bash
npm run login                                        # REQUIRED once (account mode): sign in with the coach account (same as Integrations), press ENTER, and let the window close itself — killing Chrome mid-login makes Google revoke the saved session
DISPLAY=:0 npm start                                 # headed (required); servers: xvfb-run -a npm start
npm run join -- https://meet.google.com/xxx-yyyy-zzz            # debug join only (needs a display; headless servers: xvfb-run -a npm run join -- <url>)
npm run test-say -- https://meet.google.com/xxx-yyyy-zzz "Hello! Can you hear me?"  # prove TTS audible
npm start                                            # poll pending sessions every 10s and run them
```

## How a session runs
1. Polls `GET /api/coach/bot/pending` → sessions with `transport=meet`, a `meetUrl`, and status `waiting_for_employee` **or `scheduled` whose time has come** — the bot auto-joins both, so scheduled calls need no human action.
2. Creates per-session sinks (`src/audio.ts`): `meet_in_*` (Chromium out via `PULSE_SINK`, bot records `meet_in.monitor`), `coach_out_*` + virtual source `coach_mic_*` (Chromium mic via `PULSE_SOURCE`, TTS via `paplay`). Torn down afterwards.
3. Joins via the Meet UI (`src/selectors.ts` — all selectors in one file): dismiss prompts → fill name → camera off → mic on → Join now. Screenshot to `$COACH_BOT_DEBUG_DIR` on any step failure.
4. Waits for a human (participant count ≥ 2, then speech) → `status: live` callback → greeting (references a real call example per the coaching prompt) → conversation loop (see `apps/api/src/lib/coachingLoop.ts` for the tested state machine).
5. Ends on goodbye / End click / max duration / employee gone (< 2 participants 60s) / 3 consecutive STT-LLM-TTS failures → callbacks persist turns, `ttsChars`, summary + action items.

## Verify audio routing
```bash
pactl list short sinks | grep -E 'meet_in|coach_out'
pactl list short sources | grep coach_mic
```
Hear the bot's output locally by loading `coach_out_*.monitor` in `pavucontrol`, or just listen in the Meet.

## Troubleshooting
- **Bot never picks up sessions** → `COACH_BOT_SECRET` mismatch, or session has no `meetUrl` (Google not connected → paste one manually).
- **"This browser or app may not be secure" at login** → Google flagged Playwright's bundled Chromium as automation. Fix: install real Google Chrome, set `COACH_BOT_CHANNEL=chrome` in `coach-bot/.env`, re-run `npm run login`. (Avoids the issue entirely: stay on `JOIN_MODE=guest`, which never logs in.)
- **Login window closes instantly / won't open** → the old command exited immediately (fixed: it now waits for ENTER). If it still fails: `npx playwright install --with-deps chromium` (missing system libs) or `xvfb-run -a npm run login` (headless server, no display).
- **Join fails / stuck at login** → `npm run login` again (Google session expired), or update `src/selectors.ts` (Meet UI changed) — check the debug screenshot first.
- **Employee can't hear bot** → `coach_out_*` sink missing (`pactl` check), `paplay` not installed, or mock TTS (no `OPENAI_API_KEY`).
- **Bot can't hear employee** → wrong `PULSE_SINK`, browser tab muted, or Meet mic permission denied in the headed login profile.
- **403 on `spaces.create`** → enable Google Meet API; reconnect Google (token expired).

## Limitations
UI automation (fragile by design), one account/profile, English-only, no Meet-chat posting, Linux + `pactl` only. See main README "Limitations".
