# Coach Bot — Meet participant for AI coaching (Linux only)

Playwright + Chromium bot that joins a Google Meet as **"Arocall AI Coach"**, hears the employee via virtual audio, and drives the conversation loop (Muse LLM + history, OpenAI TTS per sentence, VAD barge-in). Controlled by the backend through a pending queue + callbacks. Hackathon build: stable and simple over perfect.

## Prerequisites
- Linux with PulseAudio/PipeWire: `pactl`, `paplay` installed.
- Node 20+, one **dedicated** bot Google account (do not reuse a personal account).
- Backend API running (`pnpm dev` → `:4000`); same `COACH_BOT_SECRET` in API `.env` and this service's env.

## Install
```bash
cd coach-bot
npm i
npx playwright install chromium
```

## Env
| Var | Default | Purpose |
|---|---|---|
| `ARO_API` | `http://localhost:4000` | Backend base URL |
| `COACH_BOT_SECRET` | `dev-bot-secret` | `x-bot-secret` for `/api/coach/bot/pending` + `/api/coach/bot/callback` |
| `COACH_BOT_PROFILE_DIR` | `/tmp/opencode/coach-bot-profile` | Persistent Chromium profile (bot Google login lives here) |
| `COACH_BOT_HEADLESS` | `true` | `false` = headed debug |
| `COACH_BOT_DEBUG_DIR` | `/tmp/opencode/coach-bot-debug` | Failure screenshots |
| `COACH_MAX_SESSION_MIN` | `25` | Cost/duration guard |
| `OPENAI_API_KEY` | — | Empty = mock TTS (logs text, plays nothing) |
| `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts-2025-12-15` | TTS model |
| `OPENAI_TTS_VOICE` | `coral` | TTS voice |
| `OPENAI_TTS_INSTRUCTIONS` | `Warm, calm, supportive coach. Natural pace.` | TTS style |

## Usage
```bash
npm run login                                        # one-time: headed login for the bot account, then close
npm run join -- https://meet.google.com/xxx-yyyy-zzz            # debug join only (headed)
npm run test-say -- https://meet.google.com/xxx-yyyy-zzz "Hello! Can you hear me?"  # prove TTS audible
npm start                                            # poll pending sessions every 10s and run them
```

## How a session runs
1. Polls `GET /api/coach/bot/pending` → sessions with `transport=meet`, `status=waiting_for_employee`, and a `meetUrl`.
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
- **Join fails / stuck at login** → `npm run login` again (Google session expired), or update `src/selectors.ts` (Meet UI changed) — check the debug screenshot first.
- **Employee can't hear bot** → `coach_out_*` sink missing (`pactl` check), `paplay` not installed, or mock TTS (no `OPENAI_API_KEY`).
- **Bot can't hear employee** → wrong `PULSE_SINK`, browser tab muted, or Meet mic permission denied in the headed login profile.
- **403 on `spaces.create`** → enable Google Meet API; reconnect Google (token expired).

## Limitations
UI automation (fragile by design), one account/profile, English-only, no Meet-chat posting, Linux + `pactl` only. See main README "Limitations".
