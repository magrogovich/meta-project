"""Voice-activity call detection: two-sided conversation triggers recording.

Pure logic module: no audio-device or filesystem dependencies, so it is unit
testable with synthetic frames. The runner feeds 30 ms PCM frames
(16 kHz mono s16le, 480 samples = 960 bytes) from the mic (Agent) and the
system/app monitor (Customer) in lockstep.

State machine: IDLE -> RECORDING -> FINISHING -> IDLE.

- IDLE keeps a rolling in-memory buffer of the last `buffer_s` seconds from
  BOTH streams (never written to disk). A call starts only when BOTH streams
  each have at least `min_speech_ms` of VAD speech inside the same window,
  so mic-only chatter or system-only video/music never triggers.
- RECORDING streams frames to disk (caller-owned). Only "both streams
  silent" counts as silence, so alternating one-sided speech keeps the call
  alive. Hold music the VAD calls speech keeps it alive too (accepted).
- FINISHING is entered after `end_silence_s` of both-silence. The caller
  trims the trailing silence down to ~2 s, encodes, uploads, then calls
  `acknowledge()` to return to IDLE.

Events from `feed()`: None | "started" (+ full buffer) | "frame" |
"ended" (+ drop_frames, duration_s) | "discarded".
"""
from collections import deque
from math import ceil

FRAME_MS = 30
FRAME_SAMPLES = 480
FRAME_BYTES = FRAME_SAMPLES * 2  # 960
SAMPLE_RATE = 16000
TRAIL_KEEP_S = 2.0  # trailing silence kept after trimming


class VadEngine:
    """Speech/no-speech flags per 30 ms frame. Pass `classify` in tests.

    One engine instance must serve exactly ONE audio stream: the underlying
    WebRTC VAD keeps a short hangover across frames, so sharing an instance
    between the mic and system streams would bleed state across them.
    """

    def __init__(self, aggressiveness: int = 2, classify=None):
        if not 0 <= aggressiveness <= 3:
            raise ValueError("aggressiveness must be 0-3")
        self.aggressiveness = aggressiveness
        self._classify = classify
        self._vad = None

    def is_speech(self, pcm: bytes) -> bool:
        if len(pcm) != FRAME_BYTES:
            raise ValueError(f"VAD needs {FRAME_BYTES}-byte frames, got {len(pcm)}")
        if self._classify is not None:
            return bool(self._classify(pcm))
        if self._vad is None:
            try:
                import webrtcvad
            except ImportError as e:
                raise RuntimeError(
                    "webrtcvad is not installed — install it with "
                    "`pip install webrtcvad-wheels` (prebuilt wheels, no compiler needed)."
                ) from e
            self._vad = webrtcvad.Vad(self.aggressiveness)
        return bool(self._vad.is_speech(pcm, SAMPLE_RATE))


class CallStateMachine:
    def __init__(self, aggressiveness: int = 2, buffer_s: float = 10,
                 min_speech_ms: int = 600, end_silence_s: float = 20,
                 min_call_s: float = 5, classify=None):
        self.frame_s = FRAME_MS / 1000.0
        # One VAD instance per stream (hangover state must not cross streams).
        self.mic_vad = VadEngine(aggressiveness, classify)
        self.sys_vad = VadEngine(aggressiveness, classify)
        self.window_len = max(1, round(buffer_s / self.frame_s))
        self.min_speech_frames = max(1, ceil(min_speech_ms / FRAME_MS))
        self.end_silence_frames = max(1, round(end_silence_s / self.frame_s))
        self.min_call_frames = max(1, round(min_call_s / self.frame_s))
        self.keep_silence_frames = max(0, round(TRAIL_KEEP_S / self.frame_s))
        self.buf: deque = deque(maxlen=self.window_len)  # (mic_flag, sys_flag, mic_pcm, sys_pcm)
        self.reset()

    def reset(self) -> bool:
        """Back to IDLE with a cleared buffer. Returns True if a call was dropped."""
        was_active = getattr(self, "state", "IDLE") in ("RECORDING", "FINISHING")
        self.state = "IDLE"
        self.buf.clear()
        self.total = 0          # frames seen since entering RECORDING
        self.last_speech = 0    # frame index (in-call) of last either-side speech
        self.cur = (False, False)
        return was_active

    # -- introspection (monitor command) ------------------------------------
    def window_speech_ms(self) -> tuple:
        mic = sum(1 for m, _, _, _ in self.buf if m) * FRAME_MS
        sys = sum(1 for _, s, _, _ in self.buf if s) * FRAME_MS
        return mic, sys

    def silence_s(self) -> float:
        if self.state != "RECORDING":
            return 0.0
        return max(0, (self.total - self.last_speech)) * self.frame_s

    def snapshot(self) -> dict:
        mic_ms, sys_ms = self.window_speech_ms()
        return {
            "state": self.state,
            "mic_speech": self.cur[0],
            "sys_speech": self.cur[1],
            "mic_window_ms": mic_ms,
            "sys_window_ms": sys_ms,
            "silence_s": round(self.silence_s(), 1),
        }

    # -- core ---------------------------------------------------------------
    def feed(self, mic_pcm: bytes, sys_pcm: bytes):
        """Returns (event, payload). Events: None | started | frame | ended | discarded.

        While FINISHING, frames are ignored until the caller acknowledges, so
        the state stays observable (tray orange, monitor display).
        """
        if self.state == "FINISHING":
            return None, None
        mic = self.mic_vad.is_speech(mic_pcm)
        sys = self.sys_vad.is_speech(sys_pcm)
        self.cur = (mic, sys)
        self.buf.append((mic, sys, mic_pcm, sys_pcm))

        if self.state == "IDLE":
            mic_ms, sys_ms = self.window_speech_ms()
            if mic_ms >= self.min_speech_frames * FRAME_MS and sys_ms >= self.min_speech_frames * FRAME_MS:
                self.state = "RECORDING"
                # The whole buffer is handed to the caller for the pre-roll
                # dump, so frame accounting starts from its length and the
                # last in-buffer speech, keeping file and counter in sync.
                self.total = len(self.buf)
                self.last_speech = 0
                for i, (m, s, _, _) in enumerate(self.buf, 1):
                    if m or s:
                        self.last_speech = i
                return "started", {"buffer": [(mp, sp) for _, _, mp, sp in self.buf]}
            return None, None

        # RECORDING
        self.total += 1
        if mic or sys:
            self.last_speech = self.total
            return "frame", {"mic_pcm": mic_pcm, "sys_pcm": sys_pcm,
                             "mic_speech": mic, "sys_speech": sys}
        if self.total - self.last_speech >= self.end_silence_frames:
            # The triggering silence frame is never written to disk, so it
            # must not count toward the kept audio either.
            self.total -= 1
            return self._finish()
        return "frame", {"mic_pcm": mic_pcm, "sys_pcm": sys_pcm,
                         "mic_speech": mic, "sys_speech": sys}

    def _finish(self):
        trailing = self.total - self.last_speech
        drop = max(0, trailing - self.keep_silence_frames)
        kept = self.total - drop
        self.state = "FINISHING"
        self.buf.clear()
        if kept >= self.min_call_frames:
            return "ended", {"drop_frames": drop, "duration_s": round(kept * self.frame_s, 2)}
        return "discarded", {"drop_frames": drop, "duration_s": round(kept * self.frame_s, 2)}

    def flush(self):
        """End a call early (e.g. capture stream died): evaluate like end-of-silence."""
        if self.state != "RECORDING":
            return None, None
        return self._finish()

    def acknowledge(self):
        """Caller finished file IO for FINISHING -> back to IDLE."""
        self.reset()
