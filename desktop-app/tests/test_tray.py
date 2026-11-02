"""Tray icon tests: tooltips must stay latin-1 safe (AppIndicator crashes on e.g. em-dashes)."""
import sys
import unittest

sys.path.insert(0, "src")


class TrayTooltipTest(unittest.TestCase):
    def test_all_statuses_latin1_safe(self):
        from arocall_agent import tray as tray_mod
        for status in ("unconfigured", "idle", "recording", "uploading", "error", "bogus"):
            tray_mod._state.update(status=status, detail="Connected as Test User")
            tray_mod.tooltip().encode("latin-1")

    def test_status_icons_render(self):
        from arocall_agent import tray as tray_mod
        for status in ("idle", "recording", "error"):
            self.assertEqual(tray_mod._make_icon(status).size, (64, 64))


if __name__ == "__main__":
    unittest.main()
