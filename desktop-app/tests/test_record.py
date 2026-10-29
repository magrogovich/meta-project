"""Phase-3 tests: call detection + 2-track recording on synthetic audio."""
import json
import struct
import sys
import tempfile
import unittest
import wave
from pathlib import Path

sys.path.insert(0, "src")

from arocall_agent.detect import CallDetector
from arocall_agent.record import CallRecorder


def pcm(level: float, frames=3200):
    v = int(max(-1.0, min(1.0, level)) * 30000)
    return struct.pack("<" + "h" * frames, *([v] * frames))


SIL = pcm(0.0)
LOUD = pcm(0.5)
FRAME = 0.2


def run(det, sys_seq, mic_seq=None):
    """Feed RMS sequences; collect events. Each item = seconds of level."""
    events = []
    mic_seq = mic_seq or [0.0] * len(sys_seq)
    import numpy as np

    def rms(b):
        a = np.frombuffer(b, dtype=np.int16).astype(float) / 32768.0
        return float((a * a).mean() ** 0.5)

    for s_level, m_level in zip(sys_seq, mic_seq):
        n = max(1, round(1.0 / FRAME))
        for _ in range(n):
            sp, mp = pcm(s_level), pcm(m_level)
            ev, payload = det.feed(rms(sp), rms(mp), sp, mp)
            if ev:
                events.append((ev, payload))
    return events


class DetectTest(unittest.TestCase):
    def det(self, **kw):
        args = dict(threshold=0.1, hangover_sec=0.4, preroll_sec=0.6,
                    silence_timeout_sec=1.0, min_call_sec=1.0, frame_sec=FRAME)
        args.update(kw)
        return CallDetector(**args)

    def test_full_call_with_preroll(self):
        d = self.det()
        evs = run(d, [0.0, 0.0, 0.5, 0.5, 0.5, 0.5, 0.0, 0.0])
        kinds = [e for e, _ in evs]
        self.assertIn("started", kinds)
        self.assertIn("ended", kinds)
        started = [p for e, p in evs if e == "started"][0]
        # pre-roll kept ~0.6s => 3 frames of 200ms
        self.assertGreaterEqual(len(started["preroll"]), 3)

    def test_short_blip_discarded(self):
        d = self.det(min_call_sec=3.0)
        evs = run(d, [0.5, 0.0, 0.0])
        kinds = [e for e, _ in evs]
        self.assertIn("started", kinds)
        self.assertIn("discarded", kinds)
        self.assertNotIn("ended", kinds)

    def test_mic_alone_never_starts(self):
        d = self.det()
        evs = run(d, [0.0] * 6, mic_seq=[0.8] * 6)
        self.assertEqual(evs, [])

    def test_require_mic_gates_start(self):
        d = self.det(require_mic_activity=True)
        evs = run(d, [0.5, 0.5, 0.5], mic_seq=[0.0, 0.0, 0.0])
        self.assertEqual(evs, [])
        d2 = self.det(require_mic_activity=True)
        evs2 = run(d2, [0.5, 0.5, 0.5, 0.5, 0.0, 0.0], mic_seq=[0.5, 0.5, 0.5, 0.5, 0.0, 0.0])
        self.assertIn("started", [e for e, _ in evs2])

    def test_mic_silence_does_not_end_call(self):
        d = self.det()
        evs = run(d, [0.5] * 4 + [0.0, 0.0], mic_seq=[0.0] * 6)
        kinds = [e for e, _ in evs]
        self.assertIn("started", kinds)
        self.assertIn("ended", kinds)


class RecordTest(unittest.TestCase):
    def test_two_tracks_and_metadata(self):
        tmp = tempfile.TemporaryDirectory()
        rec = CallRecorder(Path(tmp.name))
        cid = rec.start("micX", "monY", preroll=[(0.1, 0.0, pcm(0.1), pcm(0.0))])
        for _ in range(5):
            rec.write_frame(pcm(0.5), pcm(0.3))
        cf = rec.finish()
        self.assertIsNotNone(cf)
        self.assertEqual(cf.call_id, cid)
        for wav in (cf.agent_wav, cf.customer_wav):
            self.assertTrue(wav.exists())
            with wave.open(str(wav), "rb") as w:
                self.assertEqual((w.getnchannels(), w.getsampwidth(), w.getframerate()), (1, 2, 16000))
                self.assertEqual(w.getnframes(), 6 * 3200)  # preroll + 5 frames
        meta = json.loads(cf.meta_path.read_text())
        self.assertEqual(meta["mic_source"], "micX")
        self.assertEqual(meta["monitor_source"], "monY")
        self.assertEqual(meta["agent_offset_sec"], 0.0)
        self.assertGreaterEqual(meta["duration_sec"], 0)
        # agent track holds mic levels, customer holds system levels
        tmp.cleanup()

    def test_abort_removes_dir(self):
        tmp = tempfile.TemporaryDirectory()
        rec = CallRecorder(Path(tmp.name))
        cid = rec.start("m", "s")
        rec.write_frame(pcm(0.5), pcm(0.5))
        rec.abort()
        self.assertFalse((Path(tmp.name) / cid).exists())
        self.assertIsNone(rec.finish())
        tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
