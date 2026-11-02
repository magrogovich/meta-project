"""Per-app capture tests: sink-input parsing, matching, null-sink routing."""
import sys
import unittest

sys.path.insert(0, "src")

from arocall_agent import audio_linux as au

SINK_INPUTS = """Sink Input #5
\tDriver: protocol-native.c
\tProperties:
\t\tapplication.name = "Firefox"
\t\tapplication.process.binary = "firefox"
\t\tmedia.name = "AudioStream"
\tSink: 0
Sink Input #7
\tProperties:
\t\tapplication.name = "Zoom"
\t\tapplication.process.binary = "zoom"
\t\tmedia.name = "ZoomAudioDevice"
\tSink: 1
"""

SINKS = "0\talsa_output.pci\tmodule-x\t...\n1\tarocall_app\tmodule-null-sink\t...\n"


class ListAppsTest(unittest.TestCase):
    def test_parse_sink_inputs(self):
        real = au._pactl
        au._pactl = lambda *a: SINK_INPUTS
        try:
            apps = au.list_apps()
        finally:
            au._pactl = real
        self.assertEqual(len(apps), 2)
        self.assertEqual(apps[0], {"index": 5, "app": "Firefox", "binary": "firefox",
                                   "media": "AudioStream", "sink": "0"})
        self.assertEqual(apps[1]["binary"], "zoom")

    def test_empty_when_no_inputs(self):
        real = au._pactl
        au._pactl = lambda *a: ""
        try:
            self.assertEqual(au.list_apps(), [])
        finally:
            au._pactl = real


class RouteTest(unittest.TestCase):
    def setUp(self):
        self.moved = []
        self._real_pactl = au._pactl
        self._real_loaded = au._app_sink_loaded
        self._real_module = au._module_loaded

        def fake_pactl(*args):
            if args[:2] == ("list", "sink-inputs"):
                return SINK_INPUTS
            if args[0] == "move-sink-input":
                self.moved.append((args[1], args[2]))
                return ""
            raise AssertionError(args)

        au._pactl = fake_pactl
        au._app_sink_loaded = lambda sink="arocall_app": True
        au._module_loaded = lambda *a: True

    def tearDown(self):
        au._pactl = self._real_pactl
        au._app_sink_loaded = self._real_loaded
        au._module_loaded = self._real_module

    def test_moves_only_matching_app(self):
        n = au.route_app_audio("zoom")
        self.assertEqual(n, 1)
        self.assertEqual(self.moved, [("7", "arocall_app")])

    def test_match_is_case_insensitive_binary_or_name(self):
        self.assertEqual(au.route_app_audio("FIREFOX"), 1)
        self.assertEqual(au.route_app_audio("fire"), 1)

    def test_empty_match_moves_nothing(self):
        self.assertEqual(au.route_app_audio(""), 0)
        self.assertEqual(au.route_app_audio("   "), 0)
        self.assertEqual(self.moved, [])

    def test_unknown_app_moves_nothing(self):
        self.assertEqual(au.route_app_audio("teams"), 0)


class ConfigTest(unittest.TestCase):
    def test_app_capture_defaults(self):
        from arocall_agent import config as app_config
        self.assertEqual(app_config.DEFAULTS["capture_mode"], "system")
        self.assertEqual(app_config.DEFAULTS["target_app"], "")
        self.assertTrue(app_config.DEFAULTS["app_sink"])


FAKE_APPS = [
    {"index": 5, "app": "MySoftphone", "binary": "mysoftphone", "media": "call", "sink": "0"},
]


class CliAudioFlowTest(unittest.TestCase):
    def run_flow(self, inputs, app_lists):
        from unittest.mock import patch
        from arocall_agent import cli
        saved = {}

        class FakeMod:
            def __init__(self):
                self.calls = 0

            def list_apps(self):
                out = app_lists[min(self.calls, len(app_lists) - 1)]
                self.calls += 1
                if isinstance(out, Exception):
                    raise out
                return out

        with patch("builtins.input", side_effect=inputs), \
             patch("arocall_agent.audio.load", return_value=FakeMod()), \
             patch("arocall_agent.config.save", side_effect=lambda p: saved.update(p)):
            cli._setup_audio_source({})
        return saved

    def test_empty_list_then_rescan_then_pick(self):
        saved = self.run_flow(["2", "r", "1"], [[], FAKE_APPS])
        self.assertEqual(saved, {"capture_mode": "app", "target_app": "mysoftphone"})

    def test_empty_answer_keeps_system_sound(self):
        saved = self.run_flow(["2", ""], [FAKE_APPS])
        self.assertEqual(saved, {"capture_mode": "system", "target_app": ""})

    def test_manual_name_with_empty_list(self):
        saved = self.run_flow(["2", "mysoftphone"], [[], []])
        self.assertEqual(saved, {"capture_mode": "app", "target_app": "mysoftphone"})

    def test_bad_number_loops_then_valid(self):
        saved = self.run_flow(["2", "9", "1"], [FAKE_APPS])
        self.assertEqual(saved, {"capture_mode": "app", "target_app": "mysoftphone"})

    def test_pactl_error_still_allows_manual_name(self):
        saved = self.run_flow(["2", "mysoftphone"], [RuntimeError("no pactl")])
        self.assertEqual(saved, {"capture_mode": "app", "target_app": "mysoftphone"})


class EnsureSinkTest(unittest.TestCase):
    def test_creates_sink_and_loopback_once_then_idempotent(self):
        import subprocess
        loaded = {"sink": False, "loopback": False}
        commands = []
        real_pactl = au._pactl
        real_run = subprocess.run

        class Done:
            returncode = 0
            stderr = ""

        def fake_pactl(*args):
            if args == ("list", "short", "sinks"):
                return "0\tout\t...\n" + ("1\tarocall_app\t...\n" if loaded["sink"] else "")
            if args == ("list", "short", "modules"):
                mods = ""
                if loaded["loopback"]:
                    mods += "3\tmodule-loopback\tsource=arocall_app.monitor sink=out\n"
                return mods
            if args == ("get-default-sink",):
                return "out\n"
            raise AssertionError(args)

        def fake_run(cmd, **kw):
            commands.append(cmd)
            if "module-null-sink" in cmd:
                loaded["sink"] = True
            if "module-loopback" in cmd:
                loaded["loopback"] = True
            return Done()

        au._pactl = fake_pactl
        subprocess.run = fake_run
        try:
            au.ensure_app_sink("arocall_app")
            first_run = list(commands)
            self.assertTrue(any("module-null-sink" in c for c in first_run))
            loopback = [c for c in first_run if "module-loopback" in c][0]
            self.assertIn("source=arocall_app.monitor", loopback)
            au.ensure_app_sink("arocall_app")
            self.assertEqual(commands, first_run)  # second run loads nothing
        finally:
            au._pactl = real_pactl
            subprocess.run = real_run


if __name__ == "__main__":
    unittest.main()
