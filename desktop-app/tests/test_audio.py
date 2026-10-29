"""Phase-2 tests: audio capture + meters. `python3 -m unittest discover -s tests -v`"""
import struct
import sys
import unittest

sys.path.insert(0, "src")

from arocall_agent import audio_linux as au


def sine_rms(seconds=1.0, amp=10000, rate=16000, freq=440.0):
    import math
    n = int(seconds * rate)
    return struct.pack("<" + "h" * n,
                       *[int(amp * math.sin(2 * math.pi * freq * i / rate)) for i in range(n)])


class RmsTest(unittest.TestCase):
    def test_silence_is_zero(self):
        self.assertEqual(au.rms_level(b"\x00" * 3200), 0.0)

    def test_sine_level(self):
        rms = au.rms_level(sine_rms())
        self.assertGreater(rms, 0.15)
        self.assertLess(rms, 0.30)

    def test_empty(self):
        self.assertEqual(au.rms_level(b""), 0.0)


class SourceParseTest(unittest.TestCase):
    def test_parse_and_defaults(self):
        calls = []

        def fake_pactl(*args):
            calls.append(args)
            if args[:2] == ("list", "short"):
                return ("1\tmic1\tX\n2\tout.monitor\tY\n")
            if args[0] == "get-default-source":
                return "mic1\n"
            if args[0] == "get-default-sink":
                return "out\n"
            raise AssertionError(args)

        real = au._pactl
        au._pactl = fake_pactl
        try:
            out = au.list_sources()
        finally:
            au._pactl = real
        self.assertEqual([s["name"] for s in out["inputs"]], ["mic1"])
        self.assertEqual(out["monitors"][0]["name"], "out.monitor")
        self.assertEqual(out["default_input"], "mic1")
        self.assertEqual(out["default_monitor"], "out.monitor")


class LiveHardwareTest(unittest.TestCase):
    def test_list_real_sources(self):
        try:
            out = au.list_sources()
        except RuntimeError as e:
            self.skipTest(f"no audio tools: {e}")
        self.assertIn("inputs", out)
        self.assertIn("monitors", out)

    def test_five_second_capture(self):
        """Records 5s from the real default devices (silence is fine)."""
        try:
            out = au.list_sources()
        except RuntimeError as e:
            self.skipTest(f"no audio tools: {e}")
        ms = au.Stream(out["default_input"])
        ns = au.Stream(out["monitors"][0]["name"])
        try:
            data = ms.read(au.RATE * 5 * 2)
            self.assertEqual(len(data), au.RATE * 5 * 2)
            self.assertGreaterEqual(au.rms_level(data), 0.0)
            ns.read(au.RATE * 1 * 2)
        finally:
            ms.stop()
            ns.stop()


if __name__ == "__main__":
    unittest.main()
