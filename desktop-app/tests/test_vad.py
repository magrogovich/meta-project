"""VAD state-machine tests with synthetic frames (mock classifier is deterministic).

Frame convention: S = speech frame, Z = silence frame (content-distinguished,
since the mock classifies by first byte). One test uses the real webrtcvad
path on digital silence (skipped when the package is unavailable).
"""
import sys
import unittest

sys.path.insert(0, "src")

from arocall_agent.vad import CallStateMachine, VadEngine, FRAME_BYTES

S = b"\x07" * FRAME_BYTES
Z = b"\x00" * FRAME_BYTES

fake = lambda pcm: pcm[:1] == b"\x07"  # noqa: E731


def sm(**kw):
    args = dict(buffer_s=3, min_speech_ms=120, end_silence_s=2,
                min_call_s=1, classify=fake)
    args.update(kw)
    return CallStateMachine(**args)


def feed(m, n, mic, sys):
    events = []
    for _ in range(n):
        ev, payload = m.feed(mic, sys)
        if ev:
            events.append((ev, payload))
    return events


class TwoSidedRuleTest(unittest.TestCase):
    def test_mic_only_never_starts(self):
        m = sm()
        self.assertEqual(feed(m, 400, S, Z), [])
        self.assertEqual(m.snapshot()["state"], "IDLE")

    def test_sys_only_never_starts(self):
        m = sm()
        self.assertEqual(feed(m, 400, Z, S), [])
        self.assertEqual(m.snapshot()["state"], "IDLE")

    def test_both_sides_start_and_buffer_included(self):
        m = sm()
        self.assertEqual(feed(m, 50, Z, Z), [])
        evs = feed(m, 10, S, S)
        kinds = [e for e, _ in evs]
        self.assertIn("started", kinds)
        started = [p for e, p in evs if e == "started"][0]
        # whole 10 s rolling buffer is handed over: 50 silence + speech so far
        self.assertEqual(len(started["buffer"]), 54)
        for mp, sp in started["buffer"]:
            self.assertEqual((len(mp), len(sp)), (FRAME_BYTES, FRAME_BYTES))


class CallLifecycleTest(unittest.TestCase):
    def test_alternating_one_sided_speech_survives(self):
        m = sm()
        feed(m, 10, S, S)  # start
        mid = []
        for _ in range(5):
            mid += feed(m, 10, S, Z)  # agent talks
            mid += feed(m, 10, Z, S)  # customer talks
        self.assertNotIn("ended", [e for e, _ in mid])
        self.assertNotIn("discarded", [e for e, _ in mid])
        self.assertEqual(m.snapshot()["state"], "RECORDING")

    def test_both_silence_ends_call_with_trim(self):
        m = sm(end_silence_s=3)  # 100 trailing frames, ~2 s (67) kept
        feed(m, 10, S, S)
        for _ in range(5):
            feed(m, 10, S, Z)
            feed(m, 10, Z, S)
        evs = feed(m, 105, Z, Z)  # > end_silence (100 frames)
        kinds = [e for e, _ in evs]
        self.assertIn("ended", kinds)
        ended = [p for e, p in evs if e == "ended"][0]
        self.assertEqual(ended["drop_frames"], 99 - 67)
        self.assertAlmostEqual(ended["duration_s"], (209 - 32) * 0.03, places=2)
        self.assertEqual(m.snapshot()["state"], "FINISHING")
        m.acknowledge()
        self.assertEqual(m.snapshot()["state"], "IDLE")

    def test_short_call_discarded(self):
        m = sm(min_call_s=5)
        evs = feed(m, 6, S, S)
        self.assertIn("started", [e for e, _ in evs])
        evs = feed(m, 70, Z, Z)
        kinds = [e for e, _ in evs]
        self.assertIn("discarded", kinds)
        self.assertNotIn("ended", kinds)

    def test_flush_midcall_finalizes(self):
        m = sm()
        feed(m, 40, S, S)  # 1.2 s >= min_call_s
        ev, payload = m.flush()
        self.assertEqual(ev, "ended")
        self.assertEqual(payload["drop_frames"], 0)

    def test_flush_idle_is_noop(self):
        m = sm()
        self.assertEqual(m.flush(), (None, None))

    def test_pause_resets_to_idle_and_clears(self):
        m = sm()
        feed(m, 10, S, S)
        self.assertEqual(m.snapshot()["state"], "RECORDING")
        self.assertTrue(m.reset())  # a call was dropped
        snap = m.snapshot()
        self.assertEqual(snap["state"], "IDLE")
        self.assertEqual((snap["mic_window_ms"], snap["sys_window_ms"]), (0, 0))
        self.assertEqual(feed(m, 200, Z, Z), [])
        self.assertFalse(m.reset())  # nothing to drop when idle


class EngineTest(unittest.TestCase):
    def test_frame_size_validated(self):
        with self.assertRaises(ValueError):
            VadEngine(classify=fake).is_speech(b"too short")

    def test_bad_aggressiveness_rejected(self):
        with self.assertRaises(ValueError):
            VadEngine(aggressiveness=9, classify=fake)


try:
    import webrtcvad  # noqa: F401
    HAS_VAD = True
except ImportError:
    HAS_VAD = False


@unittest.skipUnless(HAS_VAD, "webrtcvad not installed")
class RealVadTest(unittest.TestCase):
    def test_digital_silence_never_triggers(self):
        m = CallStateMachine()  # real webrtcvad, defaults
        events = []
        for _ in range(400):  # >12 s, covers the 10 s window
            ev, _ = m.feed(Z, Z)
            if ev:
                events.append(ev)
        self.assertEqual(events, [])


if __name__ == "__main__":
    unittest.main()
