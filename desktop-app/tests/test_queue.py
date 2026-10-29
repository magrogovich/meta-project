"""Phase-4 tests: Opus encode, queue retry/backoff. `python3 -m unittest discover -s tests -v`"""
import struct
import sys
import tempfile
import threading
import time
import unittest
import wave
from pathlib import Path

sys.path.insert(0, "src")

from arocall_agent.encode import to_opus
from arocall_agent.queue import Queue


def make_wav(path: Path, seconds=1.0):
    n = int(16000 * seconds)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(struct.pack("<" + "h" * n, *([3000] * n)))


class EncodeTest(unittest.TestCase):
    def test_wav_to_opus(self):
        tmp = Path(tempfile.mkdtemp())
        wav = tmp / "a.wav"
        make_wav(wav)
        out = to_opus(wav, tmp / "a.ogg")
        self.assertTrue(out.exists())
        self.assertLess(out.stat().st_size, wav.stat().st_size)

    def test_missing_ffmpeg_message(self):
        import arocall_agent.encode as enc
        real = enc.shutil.which
        enc.shutil.which = lambda *_a, **_k: None
        try:
            with self.assertRaises(RuntimeError) as c:
                enc.to_opus(Path("/tmp/x.wav"), Path("/tmp/x.ogg"))
            self.assertIn("ffmpeg is missing", str(c.exception))
        finally:
            enc.shutil.which = real


class QueueTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.qdir = Path(self.tmp.name) / "q"

    def tearDown(self):
        self.tmp.cleanup()

    def _call_files(self, cid):
        a = Path(self.tmp.name) / f"{cid}-a.ogg"
        c = Path(self.tmp.name) / f"{cid}-c.ogg"
        a.write_bytes(b"fake-opus-a")
        c.write_bytes(b"fake-opus-c")
        return a, c

    def test_retry_then_success_deletes_entry(self):
        tries = []

        def uploader(path, meta):
            tries.append(1)
            if len(tries) < 3:
                raise ConnectionError("offline")
        q = Queue(self.qdir, uploader)
        a, c = self._call_files("c1")
        q.enqueue("c1", a, c, {"call_id": "c1"})
        q.start()
        deadline = time.time() + 30
        while q.pending() and time.time() < deadline:
            time.sleep(0.5)
        q.stop()
        self.assertEqual(len(tries), 3)
        self.assertEqual(q.pending(), [])

    def test_persistent_failure_keeps_files(self):
        def uploader(path, meta):
            raise ConnectionError("offline")
        q = Queue(self.qdir, uploader)
        a, c = self._call_files("c2")
        q.enqueue("c2", a, c, {"call_id": "c2"})
        t = threading.Thread(target=q._loop, daemon=True)
        t.start()
        time.sleep(9)  # first attempts at ~0s and ~2s
        q.stop()
        items = q.pending()
        self.assertEqual(len(items), 1)
        self.assertGreaterEqual(items[0][1]["attempts"], 2)
        self.assertTrue((items[0][0] / "agent.ogg").exists())

    def test_resume_after_restart(self):
        q = Queue(self.qdir, lambda p, m: None)
        a, c = self._call_files("c3")
        q.enqueue("c3", a, c, {"call_id": "c3"})
        q2 = Queue(self.qdir, lambda p, m: None)
        self.assertEqual([m["call_id"] for _, m in q2.pending()], ["c3"])


if __name__ == "__main__":
    unittest.main()
