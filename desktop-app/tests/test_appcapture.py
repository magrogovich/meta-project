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
        au._nowarn_cache.clear()

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

    def test_describe_labels_nameless_streams(self):
        real = au._pactl
        au._pactl = lambda *a: ("Sink Input #8\n\tProperties:\n\t\tmedia.name = \"Playback\"\n"
                                "Sink Input #9\n\tProperties:\n\t\tmedia.role = \"event\"\n")
        try:
            labels = au.describe_live_apps()
        finally:
            au._pactl = real
        self.assertEqual(labels, ["stream #8 [Playback]", "stream #9 [no name]"])

    def test_no_match_warning_throttled_until_change(self):
        with self.assertLogs("arocall.audio_linux", level="WARNING") as logs:
            self.assertEqual(au.route_app_audio("teams"), 0)
        self.assertTrue(any("no audio streams matched" in m for m in logs.output))
        with self.assertNoLogs("arocall.audio_linux", level="WARNING"):
            self.assertEqual(au.route_app_audio("teams"), 0)

    def test_no_match_warns_again_after_success(self):
        au.route_app_audio("teams")  # warns + caches
        au.route_app_audio("zoom")   # moves, resets cache
        with self.assertLogs("arocall.audio_linux", level="WARNING"):
            au.route_app_audio("teams")  # warns again


class ConfigTest(unittest.TestCase):
    def test_app_capture_defaults(self):
        from arocall_agent import config as app_config
        self.assertEqual(app_config.DEFAULTS["capture_mode"], "system")
        self.assertEqual(app_config.DEFAULTS["target_app"], "")
        self.assertTrue(app_config.DEFAULTS["app_sink"])


FAKE_INSTALLED = [
    {"name": "MySoftphone", "binary": "mysoftphone", "icon": "", "playing": True},
    {"name": "Web Browser", "binary": "firefox", "icon": "", "playing": False},
]


class CliAudioFlowTest(unittest.TestCase):
    def run_flow(self, inputs, installed_lists):
        from unittest.mock import patch
        from arocall_agent import cli
        saved = {}

        class FakeMod:
            def __init__(self):
                self.calls = 0

            def list_installed_apps(self):
                out = installed_lists[min(self.calls, len(installed_lists) - 1)]
                self.calls += 1
                if isinstance(out, Exception):
                    raise out
                return out

        with patch("builtins.input", side_effect=inputs), \
             patch("arocall_agent.audio.load", return_value=FakeMod()), \
             patch("arocall_agent.config.save", side_effect=lambda p: saved.update(p)):
            cli._setup_audio_source({})
        return saved

    def test_pick_from_installed_list(self):
        saved = self.run_flow(["2", "", "1"], [FAKE_INSTALLED])
        self.assertEqual(saved, {"capture_mode": "app", "target_app": "mysoftphone"})

    def test_search_filters_then_pick(self):
        saved = self.run_flow(["2", "soft", "1"], [FAKE_INSTALLED])
        self.assertEqual(saved, {"capture_mode": "app", "target_app": "mysoftphone"})

    def test_empty_list_then_rescan_then_pick(self):
        saved = self.run_flow(["2", "", "r", "", "2"], [[], FAKE_INSTALLED])
        self.assertEqual(saved, {"capture_mode": "app", "target_app": "firefox"})

    def test_empty_answer_keeps_system_sound(self):
        saved = self.run_flow(["2", "", ""], [FAKE_INSTALLED])
        self.assertEqual(saved, {"capture_mode": "system", "target_app": ""})

    def test_manual_name_with_empty_list(self):
        saved = self.run_flow(["2", "", "mysoftphone"], [[], []])
        self.assertEqual(saved, {"capture_mode": "app", "target_app": "mysoftphone"})

    def test_bad_number_loops_then_valid(self):
        saved = self.run_flow(["2", "", "9", "", "1"], [FAKE_INSTALLED])
        self.assertEqual(saved, {"capture_mode": "app", "target_app": "mysoftphone"})

    def test_pick_prefers_observed_live_binary(self):
        installed = [{"name": "Brave Web Browser", "binary": "brave-browser-stable",
                      "icon": "", "playing": True, "live_binary": "brave"}]
        saved = self.run_flow(["2", "", "1"], [installed])
        self.assertEqual(saved, {"capture_mode": "app", "target_app": "brave"})

    def test_read_error_still_allows_manual_name(self):
        saved = self.run_flow(["2", "", "mysoftphone"], [RuntimeError("no dirs")])
        self.assertEqual(saved, {"capture_mode": "app", "target_app": "mysoftphone"})


class InstalledAppsTest(unittest.TestCase):
    def test_exec_binary_parsing(self):
        self.assertEqual(au._exec_binary("firefox %u"), "firefox")
        self.assertEqual(au._exec_binary("/usr/bin/google-chrome-stable --flag %U"), "google-chrome-stable")
        self.assertEqual(au._exec_binary("flatpak run org.mozilla.firefox"), "firefox")
        self.assertEqual(au._exec_binary("/snap/bin/spotify --x"), "spotify")
        self.assertEqual(au._exec_binary("env VAR=1 myapp --flag %U"), "myapp")
        self.assertEqual(au._exec_binary(""), "")

    def test_parse_desktop_file(self):
        import tempfile
        from pathlib import Path
        tmp = tempfile.TemporaryDirectory()
        good = Path(tmp.name) / "call.desktop"
        good.write_text("[Desktop Entry]\nType=Application\nName=Call App\nExec=/opt/call/bin/callapp %U\nIcon=call\n")
        hidden = Path(tmp.name) / "hide.desktop"
        hidden.write_text("[Desktop Entry]\nType=Application\nName=Hidden\nExec=hidden\nNoDisplay=true\n")
        link = Path(tmp.name) / "link.desktop"
        link.write_text("[Desktop Entry]\nType=Link\nName=Web\nURL=https://x\n")
        self.assertEqual(au._parse_desktop_file(good)["binary"], "callapp")
        self.assertIsNone(au._parse_desktop_file(hidden))
        self.assertIsNone(au._parse_desktop_file(link))
        tmp.cleanup()

    def test_installed_list_marks_playing(self):
        import tempfile
        from pathlib import Path
        tmp = tempfile.TemporaryDirectory()
        d = Path(tmp.name)
        (d / "a.desktop").write_text("[Desktop Entry]\nName=Zoom Client\nExec=zoom\n")
        (d / "b.desktop").write_text("[Desktop Entry]\nName=Editor\nExec=gedit\n")
        real_dirs, real_pactl = au._desktop_dirs, au._pactl
        au._desktop_dirs = lambda: [d]
        au._pactl = lambda *a: ("Sink Input #3\n\tProperties:\n\t\t"
                                "application.name = \"Zoom\"\n\t\t"
                                "application.process.binary = \"zoom\"\n\tSink: 0\n")
        try:
            apps = au.list_installed_apps()
        finally:
            au._desktop_dirs, au._pactl = real_dirs, real_pactl
            tmp.cleanup()
        by_name = {a["name"]: a for a in apps}
        self.assertTrue(by_name["Zoom Client"]["playing"])
        self.assertEqual(by_name["Zoom Client"]["live_binary"], "zoom")
        self.assertFalse(by_name["Editor"]["playing"])
        self.assertEqual(by_name["Editor"]["live_binary"], "")
        self.assertEqual(apps[0]["name"], "Zoom Client")  # playing sorts first


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


class MatchingTest(unittest.TestCase):
    def test_longer_installed_binary_matches_shorter_runtime(self):
        live = {"index": 9, "app": "Brave", "binary": "brave", "media": "Playback", "sink": "0"}
        self.assertTrue(au._matches(live, "brave-browser-stable"))

    def test_exact_still_matches(self):
        live = {"index": 9, "app": "Zoom", "binary": "zoom", "media": "", "sink": "0"}
        self.assertTrue(au._matches(live, "zoom"))
        self.assertTrue(au._matches(live, "ZOOM"))

    def test_unrelated_does_not_match(self):
        live = {"index": 9, "app": "Brave", "binary": "brave", "media": "", "sink": "0"}
        self.assertFalse(au._matches(live, "teams"))
        self.assertFalse(au._matches(live, ""))
        self.assertFalse(au._matches(live, "   "))

    def test_live_binary_for_prefers_observed(self):
        live = [{"index": 9, "app": "Brave", "binary": "brave", "media": "", "sink": "0"}]
        installed = {"name": "Brave Web Browser", "binary": "brave-browser-stable"}
        self.assertEqual(au.live_binary_for(installed, live), "brave")

    def test_live_binary_for_empty_when_not_playing(self):
        self.assertEqual(au.live_binary_for({"name": "X", "binary": "x"}, []), "")


if __name__ == "__main__":
    unittest.main()
