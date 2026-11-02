"""Phase-3 tests: 2-track recording on synthetic audio + trailing-silence trim."""
import json
import struct
import sys
import tempfile
import unittest
import wave
from pathlib import Path

sys.path.insert(0, "src")

from arocall_agent.record import CallRecorder


def pcm(level: float, frames=3200):
    v = int(max(-1.0, min(1.0, level)) * 30000)
    return struct.pack("<" + "h" * frames, *([v] * frames))


def frame30():
    return pcm(0.5, frames=480)


class RecordTest(unittest.TestCase):
    def test_two_tracks_and_metadata(self):
        tmp = tempfile.TemporaryDirectory()
        rec = CallRecorder(Path(tmp.name))
        cid = rec.start("micX", "monY", preroll=[(pcm(0.0, 480), pcm(0.1, 480))])
        for _ in range(5):
            rec.write_frame(pcm(0.5, 480), pcm(0.3, 480))
        cf = rec.finish()
        self.assertIsNotNone(cf)
        self.assertEqual(cf.call_id, cid)
        for wav in (cf.agent_wav, cf.customer_wav):
            self.assertTrue(wav.exists())
            with wave.open(str(wav), "rb") as w:
                self.assertEqual((w.getnchannels(), w.getsampwidth(), w.getframerate()), (1, 2, 16000))
                self.assertEqual(w.getnframes(), 6 * 480)  # preroll + 5 frames
        meta = json.loads(cf.meta_path.read_text())
        self.assertEqual(meta["mic_source"], "micX")
        self.assertEqual(meta["monitor_source"], "monY")
        self.assertEqual(meta["agent_offset_sec"], 0.0)
        self.assertAlmostEqual(meta["duration_sec"], 6 * 480 / 16000, places=2)
        tmp.cleanup()

    def test_finish_trims_trailing_silence(self):
        tmp = tempfile.TemporaryDirectory()
        rec = CallRecorder(Path(tmp.name))
        rec.start("m", "s")
        for _ in range(10):
            rec.write_frame(frame30(), frame30())
        cf = rec.finish(drop_trailing_frames=4)  # drop 4x30 ms
        for wav in (cf.agent_wav, cf.customer_wav):
            with wave.open(str(wav), "rb") as w:
                self.assertEqual(w.getnframes(), 6 * 480)
        meta = json.loads(cf.meta_path.read_text())
        self.assertAlmostEqual(meta["duration_sec"], 6 * 480 / 16000, places=2)
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
