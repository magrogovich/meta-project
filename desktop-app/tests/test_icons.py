"""Brand icon tests: bundled PNG loads, per-status tray icons render."""
import sys
import unittest

sys.path.insert(0, "src")


class IconTest(unittest.TestCase):
    def test_bundled_icon_exists(self):
        from arocall_agent import icons
        p = icons.icon_path()
        self.assertTrue(p.is_file(), f"missing bundled icon: {p}")
        base = icons.load_base(64)
        self.assertEqual(base.size, (64, 64))
        self.assertEqual(base.mode, "RGBA")

    def test_status_icons_render(self):
        from arocall_agent import icons
        seen = set()
        for status in ("unconfigured", "idle", "recording", "uploading", "error"):
            img = icons.make_status_icon(status, 64)
            self.assertEqual(img.size, (64, 64))
            # brand base: center pixel must be opaque in every status
            cx, cy = 32, 32
            self.assertGreater(img.getpixel((cx, cy))[3], 0, status)
            # status dot region (bottom-right) differs per status color
            dot = img.getpixel((56, 56))[:3]
            seen.add(dot)
        self.assertGreater(len(seen), 1, "status dots should vary by status")

    def test_tray_uses_brand_icon(self):
        from arocall_agent import tray as tray_mod
        for status in ("idle", "recording", "error"):
            img = tray_mod._make_icon(status)
            self.assertEqual(img.size, (64, 64))

    def test_autostart_references_brand_icon(self):
        from arocall_agent import autostart as am
        text = am.DESKTOP_FILE.format(exe="/tmp/fake/arocall-agent", icon="/tmp/fake/icon.png", desktops="GNOME;")
        self.assertIn("Icon=/tmp/fake/icon.png", text)


if __name__ == "__main__":
    unittest.main()
