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

`install.sh` warns (does not fail) when `python3-tk` is missing (settings
window falls back to terminal `setup`) or when AppIndicator libraries are
missing — common on GNOME, where there is no tray: the agent prints a note
and the terminal commands (`setup`, `status`, `run`) cover everything.

## Setup: where is the session key?

Dashboard → Employees → open the employee → **Agent tab** → Reveal (eye icon)
→ Copy. Keys are persistent (no expiry); admins can reveal them anytime and
every reveal/copy is audit-logged.

```bash
arocall-agent setup     # consent notice + paste key + validation
arocall-agent status    # backend, employee, queue size
arocall-agent run       # start (tray + recording loop)
arocall-agent autostart on|off
```

On first run the agent shows a consent notice (calls on this computer are
recorded and analyzed by the employer); acceptance is stored with a timestamp.
A company-defined notice text can be set via the `notice_text` config value.

## How it works

`parec` reads raw PCM (16 kHz, mono) from the mic (`@DEFAULT_SOURCE@`) and the
system monitor (`@DEFAULT_MONITOR@`, i.e. everything the computer plays).
A call starts when system energy passes the RMS threshold (2 s pre-roll kept),
ends after 20 s of system silence (mic silence alone never ends it), shorter
than 5 s is discarded. Both tracks stream to disk, are encoded to Opus with
ffmpeg, queued with a metadata JSON, and uploaded with backoff retries —
offline-safe, resume-after-restart, deleted only on backend confirmation.

- Tray colors: gray = not configured, green = connected/idle, red = recording,
  orange = uploading/queued, red+cross = error (e.g. revoked key).
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
| `ffmpeg is missing` | `sudo apt install ffmpeg` |
| `missing audio tools` | `sudo apt install pulseaudio-utils` (or pipewire-pulse) |
| No tray on GNOME | expected — use terminal commands (printed automatically) |
| Test records silence | pick another source in Settings → Audio; check `pavucontrol` levels |
| `key revoked` error state | Settings → paste the new key from the dashboard |
| Music/videos trigger "calls" | known limitation: the customer track is all system sound; set `require_mic_activity: true` in `~/.config/arocall/config.json` to also require mic energy |
| Device unplugged / sound server restarted | capture subprocess auto-restarts (watchdog) and logs it |
| Backend down | queue grows on disk (see `max_queue_mb`), uploads resume automatically |

## Tests

```bash
cd desktop-app && python3 -m unittest discover -s tests -v
```
Covers config/permissions, key storage, RMS + source parsing, live 5 s
hardware capture, call start/end/discard/mic-gating, 2-track files + metadata,
Opus encode, queue retry/backoff/resume, autostart, consent storage,
diagnostics hygiene (no key leakage).

## Extending to Windows/macOS later

Only two parts are platform-specific: audio capture (`audio_linux.py` behind
the `audio.py` shim — add `audio_windows.py` using WASAPI loopback and
`audio_macos.py` using the system tap) and autostart (`autostart.py` —
Task Scheduler / launchd). Detector, recorder, encoder (ffmpeg exists
everywhere), queue, heartbeat, tray (`pystray` is cross-platform) and the
`tkinter` settings UI are already portable.
