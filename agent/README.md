# Arocall desktop agent (MVP, cross-platform Node)
Windows-first per spec; this MVP is a tiny background Node app (no main window) that works on Windows/macOS/Linux.

- Session keys are **persistent** (no expiry, no one-time display). Admins can reveal them anytime from the dashboard (Employees page, or the employee's Agent tab). Keys are stored encrypted server-side and every reveal/copy is audit-logged.
- First run: `npm run setup` (or `node src/setup.js`) asks for the session key, validates against the server, saves to `config.json` (key stored as-is for MVP; production: OS credential store e.g. Credential Manager / Keychain via keytar). You can also use the "Download connection file" button in the dashboard wizard and place `arocall-agent-config.json` next to the agent.
- If an admin **revokes** the key, the agent prints a clear `session key REVOKED` error, pauses uploads, keeps local files, and reports status error until a new key is set up.
- Background: `npm start` runs the watchdog loop: watches `inbox/` for new .wav files (= simulated call capture; production: WASAPI loopback mic+system via native module), uploads chunked to POST /api/agent/upload-chunk with X-Session-Key, retries offline, and deletes local files after success. The key only grants upload rights for its own employee's calls — no read access.
- Background: `npm start` runs the watchdog loop: watches `inbox/` for new .wav files (= simulated call capture; production: WASAPI loopback mic+system via native module), uploads chunked to POST /api/agent/upload-chunk with X-Session-Key, retries offline, deletes local file after success.
- Tray: run `node src/tray.js` on a desktop (needs GUI; uses a minimal console menu fallback here: status connected/recording/error, Enter key, Status, Quit w/ admin password).
- Recording indicator + consent: prints a visible "● RECORDING" line while uploading and shows the one-time consent notice on setup. Never hide the app.
- Packaging: wrap with `pkg` or Electron for a signed installer (see PACKAGING notes below).
Env: API_URL (default http://localhost:4000), ADMIN_PASSWORD (quit confirmation).
