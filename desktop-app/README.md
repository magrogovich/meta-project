# Arocall desktop agent (Linux)

Background tray app that records an employee's calls (microphone + all system
sound) and uploads them to the Arocall backend, where transcription, scoring
and coaching happen. No AI runs in the agent. Always visible: tray icon plus
an `arocall-agent` process — never hidden.

## Install

Requirements: Python 3.10+, `ffmpeg`, `pactl`/`parec` (PipeWire or PulseAudio).

```bash
cd desktop-app
./install.sh            # checks deps, venv install, links ~/.local/bin/arocall-agent
./install.sh --autostart   # also enable start-on-login
```

Updating to a newer version: pull the latest code and re-run `./install.sh`
— it upgrades the venv install in place. Confirm with
`arocall-agent status` (prints the agent version). If a command behaves like
an older version (e.g. `setup` never asks about the audio source), the
installed copy is stale: re-run `./install.sh` and try again.

`install.sh` warns (does not fail) when `python3-tk` is missing (settings
window falls back to terminal `setup`) or when AppIndicator libraries are
missing — common on GNOME, where there is no tray: the agent prints a note
and the terminal commands (`setup`, `status`, `run`) cover everything.

## Setup: where is the session key?

Dashboard → Employees → open the employee → **Agent tab** → Reveal (eye icon)
→ Copy. Keys are persistent (no expiry); admins can reveal them anytime and
every reveal/copy is audit-logged.

```bash
arocall-agent setup     # consent notice + paste key + validation + audio source choice
arocall-agent audio     # change the audio source later (no key needed)
arocall-agent monitor   # live VAD view for tuning (records nothing)
arocall-agent status    # backend, employee, capture mode, queue size
arocall-agent run       # start (tray + recording loop)
arocall-agent autostart on|off
```

## Choosing what to record: whole system or one app

During `setup` (terminal) or in Settings → Audio (window) you choose:

- **Entire system sound** (default) — records everything the computer plays
  via the output monitor. Simple, but music/videos also trigger "calls".
- **One specific app** — e.g. Zoom, Chrome, Teams. The agent creates a
  private null sink (`arocall_app`), moves that app's audio streams onto it
  with `pactl move-sink-input`, and records only the sink's monitor.
  Re-routing runs every 2 s while active, so calls started later in the same
  app are picked up too. Other apps' sound is ignored.

Pick the app from the list of currently-playing apps (start a call first so
it shows up), or type its name manually — matching is case-insensitive on
the app name or process binary. If the list is empty, play audio in the app
and rescan (terminal: answer `r`; Settings window: press Refresh).

Finding the exact name: while the app plays sound, run

```bash
pactl list sink-inputs | grep -E 'application.name|application.process.binary'
```

and use either value (the binary, e.g. `softphone`, is usually the most
stable). The names in prompts (Zoom, Chrome, Teams) are only examples —
whatever this command prints for your machine is what counts.
If the app isn't running when a call would start, there is simply silence
on the customer track until it plays again.
Switching modes takes effect on the next run (Settings applies it live for
meters; the recorder picks it up on restart). To change the source without
re-pasting the key, run `arocall-agent audio` at any time; `arocall-agent
status` shows the active mode.

On first run the agent shows a consent notice (calls on this computer are
recorded and analyzed by the employer); acceptance is stored with a timestamp.
A company-defined notice text can be set via the `notice_text` config value.

## How call detection works

The agent listens continuously to the microphone (Agent) and the system or
app sound (Customer) in 30 ms frames, each classified speech/no-speech by
WebRTC VAD (`webrtcvad-wheels`, aggressiveness 2). Nothing is written to
disk while idle. State machine (`vad.py`: IDLE → RECORDING → FINISHING):

- **IDLE** keeps a rolling 10 s in-memory buffer of both streams. A call
  starts only when BOTH streams each contain at least 600 ms of speech in
  the same window — mic-only chatter or system-only video/music never
  triggers. The whole buffer is then written to disk, so the greeting is kept.
- **RECORDING** streams both tracks to disk frame by frame (never held in
  memory). Only silence on BOTH streams counts, so agent-then-customer
  turn-taking keeps the call alive.
- **FINISHING** after 20 s of both-silence: trailing silence is trimmed to
  ~2 s. Calls shorter than 5 s after trimming are deleted; the rest is
  Opus-encoded and handed to the upload queue.

Config (`~/.config/arocall/config.json`, shown read-only under Settings →
Advanced): `vad_aggressiveness` (0-3, default 2), `buffer_s` (10),
`min_speech_ms` (600), `end_silence_s` (20), `min_call_s` (5).

Tuning: run `arocall-agent monitor` — it prints the live state plus current
speech flags, speech-ms per stream in the window, and silence seconds, once
per second, without recording anything. Raise `vad_aggressiveness` if noise
starts calls; lower it if quiet speech is missed.

## Known limitations

- Customer on mute, or on a separate audio device the agent doesn't capture,
  means no call is detected (both sides are required).
- Very quiet or poor-quality audio may not pass the VAD.
- Hold music or videos the VAD hears as speech keep a call alive and can extend it.
- Back-to-back calls with a short gap may merge into one recording.
- Use headphones so the customer's voice doesn't leak into the mic track.

`parec` reads raw PCM (16 kHz, mono) from the mic (`@DEFAULT_SOURCE@`) and, in
system mode, the system monitor (`@DEFAULT_MONITOR@`, i.e. everything the
computer plays). In app mode it reads `arocall_app.monitor` instead (see above).
Both tracks stream to disk, are encoded to Opus with
ffmpeg, queued with a metadata JSON, and uploaded with backoff retries —
offline-safe, resume-after-restart, deleted only on backend confirmation.

- Tray colors: gray = not configured, green = connected/idle, red = recording,
  orange = uploading/queued, red+cross = error (e.g. revoked key).
  The tray base is the Arocall brand icon (`src/arocall_agent/assets/icon.png`,
  copied from `apps/web/public/icon.png`); the color shows as a status dot in
  the corner. Same icon is used for the settings window and the autostart entry.
- Heartbeat every 60 s drives the dashboard's online/offline + last-seen.
- Recording indicator: tray turns red; optional `notify-send` call start/end
  chimes (`notify_calls` in config).
- Logs: `~/.local/share/arocall/logs/` (rotating, never contains the key or
  audio). Settings → Copy diagnostics for support.

## Backend endpoint contract

Base: `AROCALL_BACKEND_URL` (default `http://localhost:4000`).

- `POST /api/agent/validate` — header `X-Session-Key`. 200 `{employee:{id,name,orgId}}`,
  401 bad key, 403 `{error:"key_revoked"}`.
- `POST /api/agent/calls` — multipart `agent_track` + `customer_track` (Opus/WAV),
  `metadata` JSON `{call_id, language, start_time, end_time, duration_sec,
  agent_version, ...}`. Idempotent on `call_id`: repeats return
  `{done:true, duplicate:true, callId}`. 200 `{done, duplicate, callId}`.
- `POST /api/agent/heartbeat` — `{status, version, queueSize}` → `{ok:true}`;
  403 means the key was revoked: stop uploading, error state, keep the queue.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `setup` never asks about the audio source | stale install — pull latest code, re-run `./install.sh`, check `status` shows 0.3.0+ |
| `ffmpeg is missing` | `sudo apt install ffmpeg` |
| `missing audio tools` | `sudo apt install pulseaudio-utils` (or pipewire-pulse) |
| No tray on GNOME | expected — use terminal commands (printed automatically) |
| Test records silence | pick another source in Settings → Audio; check `pavucontrol` levels |
| `key revoked` error state | Settings → paste the new key from the dashboard |
| Music/videos trigger "calls" | expected in system mode: any two-sided sound counts — switch to one specific app (Settings → Audio, or `arocall-agent audio`), or raise `vad_aggressiveness` |
| Device unplugged / sound server restarted | capture subprocess auto-restarts (watchdog) and logs it |
| Backend down | queue grows on disk (see `max_queue_mb`), uploads resume automatically |

## Tests

```bash
cd desktop-app && python3 -m unittest discover -s tests -v
```
Covers config/permissions, key storage, PCM level + source parsing, live 5 s
hardware capture, VAD two-sided rule + pre-roll + trim + discard
(tests/test_vad.py, synthetic frames), 2-track files + metadata,
Opus encode, queue retry/backoff/resume, autostart, consent storage,
diagnostics hygiene (no key leakage).

## Extending to Windows/macOS later

Only two parts are platform-specific: audio capture (`audio_linux.py` behind
the `audio.py` shim — add `audio_windows.py` using WASAPI loopback and
`audio_macos.py` using the system tap) and autostart (`autostart.py` —
Task Scheduler / launchd). Detector, recorder, encoder (ffmpeg exists
everywhere), queue, heartbeat, tray (`pystray` is cross-platform) and the
`tkinter` settings UI are already portable.
