Update the existing, working Arocall codebase: move the AI coaching session from the current in-app voice call to Google Meet. The employee joins a Google Meet meeting, an AI coach participant joins it, and they hold a spoken conversation. The coach speaks using OpenAI TTS and has full conversation history. Do not rewrite from scratch and do not break working features. Keep the existing tech stack, the existing coaching prompt builder (scores, memo, call evidence, guidelines), the existing safety rules, and the existing summary and action-items flow. Before changing anything, inspect the current coaching session code and give me a short plan listing the files, endpoints, tables and new services you will change or add.

## 1. Constraints and honesty
- Google Meet has no official API for a bot to speak. Use the approach in section 3 (a browser-automation bot) and isolate it behind an interface (`MeetTransport`) so it can be replaced later.
- Keep the existing in-app voice session as a fallback transport. Add a config switch `COACH_TRANSPORT=meet|inapp` (default `meet`), and a "Use browser mode instead" option on the session page if Meet fails.
- This is a hackathon build: stable and simple over perfect. Linux only for the bot service.
- Document the limitations in the README (UI automation fragility, Google terms, one dedicated Google account for the bot).

## 2. Flow
1. An admin clicks "Start AI coaching" on an employee (existing dialog: memo, focus topics).
2. The backend creates a Google Meet space through the Google Meet REST API (`spaces.create`) using the admin's OAuth consent (add "Connect Google account" in Settings > Integrations; scope for creating meeting spaces). Set access type to OPEN so anyone with the link can join without knocking. If the API is unavailable or not connected, fall back to letting the admin paste a Meet link manually.
3. The backend creates a CoachingSession (status: `waiting_for_employee`) and shows the employee a link to a new Arocall "Coaching room" page, plus the Meet link (copy button and email option).
4. The Coach Bot joins the Meet meeting automatically, with the display name "Arocall AI Coach".
5. The employee joins the Meet. When the bot detects a human participant and hears speech, the coach greets them and the session becomes `live`.
6. Conversation runs as turns (section 4) until the employee says goodbye, the coach finishes the agreed action items, someone clicks End, a max duration is reached (default 25 minutes), or the employee does not join within 10 minutes (status `expired`).
7. After the session the bot leaves, and the existing summary and action-items generation runs. Everything is stored on the employee profile.

## 3. Coach Bot service (new, separate process, Linux)
- Python service (reuse the backend language if it is Python) using Playwright with Chromium, controlled by the backend through an internal authenticated API or job queue (`start_session(session_id, meet_url)`, `end_session(session_id)`, status callbacks).
- The bot uses a persistent Chromium profile directory for one dedicated Google account that is logged in once through a `coach-bot login` command (headed browser). Credentials and profile directory come from environment variables and are never logged.
- Virtual audio (PulseAudio/PipeWire via `pactl`), created per session and removed after:
  - A null sink `meet_in`: Chromium's audio output is routed here (start Chromium with `PULSE_SINK=meet_in`). The bot records `meet_in.monitor` to hear the employee.
  - A null sink `coach_out` plus a virtual source `coach_mic` built from `coach_out.monitor`: Chromium's microphone is `coach_mic` (start Chromium with `PULSE_SOURCE=coach_mic`). The TTS audio is played into `coach_out` with `paplay` or `pacat`, so Meet hears it as the bot's microphone.
- The bot joins Meet through the UI: open the link, dismiss prompts, disable the camera, make sure the microphone is on and unmuted, click "Join now". Make the selectors easy to update (one file) and handle the guest/sign-in variants. Take a screenshot into a debug folder when any step fails.
- Detect that a human is present: read the participant count from the Meet UI, and also require speech on `meet_in.monitor` before the greeting.
- Detect when the meeting ends or the employee leaves (the UI shows it, or no human participant for 60 seconds), then finish the session cleanly.
- Run headless if it works, with a `--headed` debug option.

## 4. Conversation loop
Per session, one loop with this state: LISTENING, THINKING, SPEAKING.
- LISTENING: read 16 kHz mono PCM from `meet_in.monitor` in 30 ms frames and use `webrtcvad` (reuse the existing VAD module if present; aggressiveness 2). An utterance ends after about 800 ms of silence. Ignore utterances shorter than 300 ms.
- Transcribe the utterance with the existing speech-to-text integration (English only for now, language as a config value).
- THINKING: send the system prompt (the existing coaching prompt builder), the full conversation history and the new employee turn to the Muse model through the existing provider abstraction. Stream the reply. Split it into sentences as they arrive.
- SPEAKING: for each sentence, call the OpenAI TTS endpoint (`/v1/audio/speech`) with model from env `OPENAI_TTS_MODEL` (default `gpt-4o-mini-tts-2025-12-15`), voice from `OPENAI_TTS_VOICE` (default `coral`), `response_format=pcm`, and an `instructions` field from config (default: "Warm, calm, supportive coach. Natural pace."). Convert the PCM (24 kHz, 16-bit mono) to what `paplay` needs and play it into `coach_out`. Pipeline it so sentence N+1 is being generated while sentence N plays, to keep latency low.
- Barge-in: if the employee starts speaking while the coach is speaking (VAD speech for more than 300 ms on `meet_in.monitor`), stop playback immediately (kill the player process, flush the queue), cancel the pending LLM/TTS work, mark the interrupted coach turn as "interrupted" in the history, and return to LISTENING. Beware of echo: the bot's own voice must not be captured by `meet_in`. This should be prevented by the separate sinks, but verify it in testing.
- History: every turn is stored in the database in order (role, text, timestamp, interrupted flag, audio duration). The LLM receives the full history each turn, trimmed to a token budget by summarizing the oldest turns if needed.
- Opening: the coach introduces itself as an AI coach, says that the session is recorded and summarized for the employee's profile, and references one concrete real example from the employee's recent calls, as the existing prompt specifies.
- Keep the existing coach rules: supportive and specific, never invents facts about calls, no employment decisions, offers a human evaluator when the employee raises complaints, harassment, health or personal issues. If a human is requested (the employee says so, or clicks the button in the Coaching room), the coach acknowledges, sets `human_flag` on the session and the dashboard "Needs attention" shows it.
- Handle errors: if STT, LLM or TTS fails, the coach says a short fallback line ("Sorry, I lost you for a second. Could you repeat that?"), logs the error and continues; after 3 consecutive failures, end the session as `failed` and notify the admin.

## 5. Arocall Coaching room page (the chat side)
A page opened from the session link (employee) and from the admin's session view:
- Left: status and instructions ("Join the Meet", the Meet link button, a "Waiting for you" / "Live" / "Ended" indicator, a timer).
- Main: a live chat transcript of the conversation (employee and "AI Coach" bubbles, interrupted turns marked), updated in real time through the existing real-time mechanism (WebSocket, SSE or polling at 1-2 seconds; use what the codebase already has).
- Controls: "Request human evaluator", "End session", and for admins a read-only view with the live transcript and the option to end the session.
- A visible notice: "You are talking to an AI coach. This session is recorded and summarized. AI assists, humans decide."
- On end: show the summary and the agreed action items, which are also saved on the employee profile.
- Optional (only if simple and stable): the bot posts the AI's text replies into the Meet chat. Skip it if it is fragile.

## 6. Data model and backend
- CoachingSession: add `transport` (meet|inapp), `meet_space_name`, `meet_url`, `status` (waiting_for_employee, live, ended, expired, failed), `started_at`, `ended_at`, `human_flag`, `bot_error`.
- CoachingTurn: session, index, role (employee|coach), text, interrupted, created_at, audio_ms.
- Integration storage for the admin's Google OAuth tokens (encrypted at rest, scoped to the organization) and Settings > Integrations > Google page with connect/disconnect and status.
- Endpoints: create session (creates Meet space, queues the bot), get session (status, turns), stream session updates, end session, request human, bot callbacks (authenticated with an internal secret).
- Strict per-organization isolation. Audit log entries for session start, end and human flag.

## 7. Configuration (.env.example and README)
`COACH_TRANSPORT`, `OPENAI_API_KEY`, `OPENAI_TTS_MODEL=gpt-4o-mini-tts-2025-12-15`, `OPENAI_TTS_VOICE`, `OPENAI_TTS_INSTRUCTIONS`, `COACH_MAX_SESSION_MIN`, `COACH_JOIN_TIMEOUT_MIN`, `COACH_BOT_PROFILE_DIR`, `COACH_BOT_HEADLESS`, Google OAuth client id/secret/redirect URI, internal bot secret. Never log keys or audio content. Add a simple cost guard: stop the session at the max duration and log the TTS characters used per session.

## 8. Tests
- Conversation loop state machine with mocked STT, LLM and TTS: normal turn, barge-in interrupts playback and marks the turn, failure fallback line, 3 consecutive failures end the session.
- History trimming and summarization under the token budget.
- Session lifecycle (waiting, live, expired, ended) and the human-flag path.
- Organization isolation on the new endpoints.
- A manual test checklist in the README for the Meet join flow and audio routing (`pactl` commands to verify the sinks, how to hear the bot's output, how to run the bot headed).

## 9. Build order (each phase must run before moving on, with exact commands to test it)
1. Data model, config, session creation endpoint, Google OAuth connect and Meet space creation (or the manual-link fallback), Coaching room page with status.
2. Coach Bot: one-time login command, join a Meet link, create the virtual audio devices, and play a test sentence generated by the OpenAI TTS model into the meeting. Prove the employee can hear it.
3. Capture the meeting audio, VAD, transcription, and show the live transcript in the Coaching room.
4. Full loop: Muse reply streaming, sentence-by-sentence TTS playback, history, barge-in.
5. Session end, summary and action items, human-evaluator flag, dashboard attention item, expiry and failure handling.
6. Fallback to the in-app mode, README, tests.

Definition of done: I click "Start AI coaching" on an employee, a Meet link is created, the bot joins as "Arocall AI Coach", I join from my browser, the coach greets me by voice, I talk to it and it answers by voice using the TTS model, I can interrupt it, the live transcript appears in the Coaching room, and when the session ends the summary and action items appear on the employee profile.