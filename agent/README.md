# Arocall desktop agent (MVP, cross-platform Node)
Windows-first per spec; this MVP is a tiny background Node app (no main window) that works on Windows/macOS/Linux.

- First run: `npm run setup` (or `node src/setup.js`) asks for the session key, validates against the server, saves to `config.json` (key stored as-is for MVP; production: OS credential store e.g. Credential Manager / Keychain via keytar).
- Background: `npm start` runs the watchdog loop: watches `inbox/` for new .wav files (= simulated call capture; production: WASAPI loopback mic+system via native module), uploads chunked to POST /api/agent/upload-chunk with X-Session-Key, retries offline, deletes local file after success.
- Tray: run `node src/tray.js` on a desktop (needs GUI; uses a minimal console menu fallback here: status connected/recording/error, Enter key, Status, Quit w/ admin password).
- Recording indicator + consent: prints a visible "● RECORDING" line while uploading and shows the one-time consent notice on setup. Never hide the app.
- Packaging: wrap with `pkg` or Electron for a signed installer (see PACKAGING notes below).
Env: API_URL (default http://localhost:4000), ADMIN_PASSWORD (quit confirmation).
