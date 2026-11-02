Update the existing Arocall Linux desktop agent. Replace its current call detection and recording logic (the energy/RMS threshold approach, the 2-second pre-roll, and the "require microphone activity" option) with the simple voice-activity-detection (VAD) design below. This is a hackathon build, so favor stable and simple over perfect. Do not change anything else that works (tray, settings window, session key, upload queue, heartbeat, backend integration). Before changing code, inspect the current recorder and give me a short plan of the files you will change.

## 1. Goal
The agent must detect calls automatically with no user action. It listens continuously to two streams, the microphone (Agent) and the system sound (Customer). It saves nothing to disk while idle, starts recording when a real two-sided conversation begins, and stops when the conversation ends.

## 2. VAD
- Use the `webrtcvad-wheels` package (prebuilt wheels for the `webrtcvad` module, so no compiler is needed). Import it as `webrtcvad`. If it fails to install or import, show a clear error message.
- Audio format: 16 kHz, mono, 16-bit PCM from the existing capture subprocesses.
- Process both streams in lockstep in 30 ms frames (480 samples = 960 bytes). Each frame gets a speech/no-speech flag per stream from `webrtcvad.Vad(aggressiveness)`.
- Put the VAD logic in its own module with no audio-device or filesystem dependencies, so it can be unit tested with synthetic frames.

## 3. State machine
IDLE -> RECORDING -> FINISHING -> IDLE

IDLE
- Keep a rolling in-memory buffer of the last 10 seconds of frames from BOTH streams (a fixed-size deque). Never write it to disk while idle.
- A stream counts as "active" in the last 10 seconds when it has at least `min_speech_ms` (default 600 ms) of speech frames in that window. This avoids triggering on a single noisy frame.
- Start a call when BOTH the mic stream and the system stream are active within the same 10-second window. Mic-only activity (a chat with a coworker) or system-only activity (a video or music) must not start a call.

RECORDING
- On entering RECORDING, first write the whole 10-second buffer to disk (so the greeting is kept), then continue streaming both tracks to disk frame by frame. Never hold a whole call in memory.
- Keep both tracks aligned: write frames for both streams at the same pace, and store the shared start timestamp in the metadata.
- Track the time since the last speech frame on EITHER stream. The agent is silent while the customer talks and vice versa, so only "both streams silent" counts as silence.
- Hold music or continuous system audio that the VAD classifies as speech keeps the call alive. That is acceptable.

FINISHING
- Enter it when neither stream has had speech for `end_silence_s` (default 20 s). Stop writing, trim the trailing silence down to about 2 seconds, then close the files.
- If the call is shorter than `min_call_s` (default 5 s, measured after trimming), delete the files and return to IDLE.
- Otherwise encode both tracks to Opus, write the metadata JSON, hand the call to the existing upload queue, and return to IDLE.
- Back-to-back calls with a short gap between them may merge into one recording. This is accepted for now. Do not build merge logic.

## 4. Configuration (config file, with these defaults)
- `vad_aggressiveness`: 2 (range 0-3; higher = stricter about what counts as speech)
- `buffer_s`: 10
- `min_speech_ms`: 600
- `end_silence_s`: 20
- `min_call_s`: 5
Show these values (read-only is fine) in the Settings window under an "Advanced" section.

## 5. Behavior and edge cases
- Tray status: green = idle/listening, red = recording, orange = finishing/uploading, matching the existing statuses. Log every state transition (info level) with a timestamp and the reason (for example "call started: both sides active" or "call ended: 20 s silence"). Never log audio content.
- Optional desktop notification on call start and end, using the existing config switch.
- If a capture stream dies, the existing watchdog restarts it. If a call is in progress, finalize it cleanly and upload what was recorded.
- If the agent is paused from the tray, stay in IDLE, drop the buffer, and do not trigger.
- On suspend/resume or an audio server restart, reset to IDLE and clear the buffer.

## 6. Tuning helper
Add a CLI command `arocall-agent monitor` that prints, once per second, the live state (IDLE/RECORDING/FINISHING), whether the mic and system stream currently have speech, seconds of speech in the window per stream, and seconds of silence so far. This lets me tune the settings quickly during testing. It must not record or upload anything.

## 7. Tests
Unit tests for the VAD/state-machine module using synthetic frames (mock the VAD so tests are deterministic, plus one test with real generated tone/noise to confirm that non-speech does not trigger):
- Mic-only speech never starts a call.
- System-only speech never starts a call.
- Both streams active within the window starts a call, and the buffered pre-roll is included in the output.
- A call survives alternating one-sided speech (agent talks, then customer talks) and ends only after 20 s of silence on both.
- Calls shorter than the minimum are discarded.
- Trailing silence is trimmed to about 2 seconds.
- Pause and resume return to IDLE and clear the buffer.

## 8. Documentation
Update the README with a short "How call detection works" section (the state machine, the "both sides" rule, the config values, how to use `arocall-agent monitor` for tuning) and a "Known limitations" list: customer on mute or on a separate audio device means no call is detected; very quiet or poor audio may not pass the VAD; music or videos playing during a call can extend it; back-to-back calls may merge; use headphones so the customer's voice doesn't leak into the mic track.

## 9. Build order (each step must run before moving on, with commands to test it)
1. VAD module and state machine with unit tests, using synthetic audio.
2. `arocall-agent monitor` connected to the real mic and system streams, so I can see the detection live.
3. Hook the state machine into the recorder: pre-roll dump, streaming to disk, trimming, Opus encoding, and handoff to the upload queue.
4. Config values, Settings "Advanced" display, log messages, README updates.

Definition of done: I start the agent, make a call (or play a conversation through the speakers while talking into the mic), the agent starts recording on its own, stops about 20 seconds after the conversation ends, and the call shows up in the Arocall dashboard, with nothing saved to disk while no call is happening.