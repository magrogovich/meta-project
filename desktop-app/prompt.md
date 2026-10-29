Build the Arocall desktop agent for LINUX ONLY (Windows and macOS support will be added later, so keep the code organized so that only the audio-capture and autostart parts are platform-specific). It is a small background app that sits in the system tray, records the employee's call audio (microphone + all system sound), and uploads it to the existing Arocall backend. Keep it as simple as possible. No transcription or AI in the agent; the backend already handles that.

## 1. Tech stack (keep it simple)
- Python 3.10+, no heavy frameworks.
- Audio capture: use the PulseAudio/PipeWire-compatible command-line tools that exist on all modern Linux distros. Capture the microphone from the default input source and ALL system sound from the default output's monitor source (`@DEFAULT_SOURCE@` and `@DEFAULT_MONITOR@`, resolved with `pactl`). Read raw PCM (16 kHz, mono, 16-bit) from `parec` subprocesses (or `ffmpeg -f pulse`). Do NOT implement per-application capture: the customer track is simply everything the computer plays.
- Encoding: ffmpeg (system-installed) to Opus (.ogg or .opus), one file per track.
- Tray: `pystray` + Pillow (generated colored icons). Settings window: `tkinter`. Include a terminal fallback (`arocall-agent setup`, `arocall-agent status`, `arocall-agent run`) for desktops where the tray is unavailable (e.g. GNOME without the AppIndicator extension), and print a helpful message explaining that case.
- HTTP: `requests`. Credential storage: the `keyring` library (Secret Service); if unavailable, fall back to a config file with permissions 600 and tell the user.
- Config and data under XDG paths (`~/.config/arocall/`, `~/.local/share/arocall/`), directories with permissions 700.
- Autostart on login: create an XDG autostart `.desktop` file (`~/.config/autostart/`), with a setup command to enable/disable it. Add a single-instance lock.
- Packaging: a `pyproject.toml` and an `install.sh` script that checks dependencies (python3, ffmpeg, pactl/parec, tkinter, AppIndicator libraries) and installs the app into a virtual environment, plus a launcher command `arocall-agent`. A .deb package can come later.
Before coding, give me a short plan: folder structure, how audio flows, and any deviation from this spec.

## 2. Behavior
- Tray icon with a status color: gray = not configured, green = connected/idle, red = recording, orange = uploading or offline queue, red with a cross = error (for example key revoked). The tooltip shows the status text.
- Tray menu: Open Settings, Status ("Connected as <employee name>"), Pause/Resume recording, Quit.
- The app runs in the background, starts on login, and has a watchdog: if a capture subprocess dies, restart it automatically and log the error.
- It is always visible to the employee (tray icon, shows in the process list as "arocall-agent"). Never hide it.

## 3. Settings window (opens on first run and from the tray)
1. Session key: password-style field (masked, eye icon to reveal, paste works). "Save and connect" validates the key against the backend and shows the employee's name on success or a clear error on failure. Changing the key later is done here; after saving, the recorder restarts automatically.
2. Microphone: dropdown of input sources (default selected) with a live level meter.
3. System sound: shows the output monitor that will be recorded (default), with a dropdown to pick another monitor source and a live level meter. Short note: "Records all sound played by this computer."
4. Test button: record 5 seconds and show levels for both streams so the user can verify the setup.
5. Info: agent version, backend URL (configurable in the config file or environment variable, with a default constant), queue size, last upload time, "Open logs folder".
6. First-run consent notice: explains that calls handled on this computer are recorded and analyzed by the employer, requires a checkbox to continue, and stores the acceptance with a timestamp. Allow an optional company-defined notice text from the config.
7. Show a tip: "Use headphones, otherwise the customer's voice leaks into the microphone track."

## 4. Recording logic
- Two separate tracks per call: microphone = Agent, system output = Customer. Keep them in sync (shared start timestamp, record each stream's start offset).
- Do not record all day. Call detection: a call starts when the system-output stream rises above an energy threshold (simple RMS threshold with a short hangover, implemented with numpy). Keep a rolling pre-roll buffer of about 2 seconds so the beginning of the call is not cut. A call ends after a configurable silence timeout on the system stream (default 20 seconds). Mic silence alone does not end a call. Ignore calls shorter than a configurable minimum (default 5 seconds). Make the thresholds, timeout and minimum configurable in the config file.
- Stream audio to disk during the call (do not hold a whole call in memory), then encode both tracks to Opus when the call ends. Save two audio files plus a metadata JSON (start time, end time, duration, device names, agent version, sample rate, call id).
- Local queue in the data folder: upload in the background with exponential-backoff retries, work offline, resume after restart, and delete local files only after the backend confirms receipt. Configurable maximum queue size on disk, with a log warning when it is exceeded.
- Known limitation to document: music, videos or notification sounds played on the computer also count as system sound, so they can start a "call". Add an optional config setting to require microphone activity as well before a call starts.

## 5. Backend integration
First inspect the existing Arocall backend and reuse its upload endpoint and session-key authentication. Do not break the existing code. If something is missing, add the minimum:
- Auth/validation endpoint: takes the session key and returns the employee id and name, or 401 if invalid or revoked.
- Upload endpoint: authenticated with the session key in a header, accepts the two audio tracks plus metadata, supports resumable or chunked upload for large files, is idempotent (a client-generated call id prevents duplicates on retry), and creates a Call record with status "uploaded" so the existing pipeline picks it up.
- Heartbeat endpoint: the agent calls it every 60 seconds with status, version and queue size, so the dashboard shows online/offline and last seen per employee.
- On 401 (key revoked or regenerated): stop uploading, set the tray to the error state, show "Key invalid. Open Settings to update it.", and keep recordings queued so nothing is lost.
Document the endpoint contract in the README.

## 6. Quality and safety
- Show the recording state clearly at all times (tray color, plus an optional desktop notification at call start and end, configurable via notify-send).
- Log to a rotating file (info and errors), never logging the session key or any audio content. Add a "Copy diagnostics" button in Settings.
- Handle edge cases: audio device changed or unplugged, PipeWire/PulseAudio restarted, laptop suspend/resume, backend unreachable, disk full, ffmpeg missing (clear error message).
- Tests for: call start/end detection logic (using synthetic audio), queue and retry logic, idempotent upload, config and key storage.

## 7. Build order (each phase must run before moving on, with the exact commands to test it)
1. Project skeleton, config, session key entry and validation against the backend, keyring storage, tray icon with statuses, terminal fallback commands, single instance.
2. Audio capture: list sources, record mic and system monitor, live level meters, Test button.
3. Call detection and recording of two synchronized tracks saved locally with metadata.
4. Opus encoding, upload queue with retries, heartbeat, and the backend endpoints.
5. Autostart, consent notice, install.sh, README (install steps, how to find the session key in the dashboard, GNOME tray note, troubleshooting, how to extend to Windows/macOS later), and tests.

Definition of done: I run install.sh, paste an employee's session key, play or make a test call on my Linux machine, and the call appears in the Arocall dashboard for that employee with both tracks uploaded and the existing pipeline starting to process it.