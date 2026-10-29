"""Call detection on the system-output stream (RMS threshold + hangover).

A call starts when system RMS stays above threshold for `hangover_sec`;
it ends after `silence_timeout_sec` of system quiet. Mic silence alone never
ends a call. A rolling pre-roll buffer keeps ~2s so the start isn't cut.
"""
from collections import deque


class CallDetector:
    def __init__(self, threshold=0.02, hangover_sec=1.0, preroll_sec=2.0,
                 silence_timeout_sec=20.0, min_call_sec=5.0,
                 require_mic_activity=False, frame_sec=0.2):
        self.threshold = threshold
        self.hangover_frames = max(1, round(hangover_sec / frame_sec))
        self.preroll_len = max(1, round(preroll_sec / frame_sec))
        self.silence_frames = max(1, round(silence_timeout_sec / frame_sec))
        self.min_call_sec = min_call_sec
        self.require_mic = require_mic_activity
        self.frame_sec = frame_sec
        self.pre = deque(maxlen=self.preroll_len)  # (sys_rms, mic_rms, sys_pcm, mic_pcm)
        self.reset()

    def reset(self):
        self.in_call = False
        self.hot = 0          # consecutive above-threshold frames
        self.quiet = 0        # consecutive below-threshold frames in call
        self.call_sec = 0.0
        self.mic_active = False

    def feed(self, sys_rms: float, mic_rms: float, sys_pcm: bytes, mic_pcm: bytes):
        """Returns (event, payload). Events: None | 'started' | 'frame' | 'ended'."""
        self.pre.append((sys_rms, mic_rms, sys_pcm, mic_pcm))
        loud = sys_rms >= self.threshold
        if self.require_mic and mic_rms >= self.threshold / 2:
            self.mic_active = True

        if not self.in_call:
            self.hot = self.hot + 1 if loud else 0
            if self.require_mic and not self.mic_active:
                self.hot = 0
            if self.hot >= self.hangover_frames:
                self.in_call = True
                self.call_sec = 0.0
                self.quiet = 0
                preroll = list(self.pre)
                self.pre.clear()
                return "started", {"preroll": preroll}
            return None, None

        self.call_sec += self.frame_sec
        self.quiet = 0 if loud else self.quiet + 1
        if self.quiet >= self.silence_frames:
            long_enough = self.call_sec >= self.min_call_sec
            self.reset()
            self.pre.clear()
            if long_enough:
                return "ended", {}
            return "discarded", {}
        return "frame", {}
