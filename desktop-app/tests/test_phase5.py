"""Phase-5 tests: autostart, consent storage, diagnostics hygiene."""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, "src")


class Phase5Test(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["XDG_CONFIG_HOME"] = self.tmp.name + "/cfg"
        os.environ["XDG_DATA_HOME"] = self.tmp.name + "/data"

    def tearDown(self):
        self.tmp.cleanup()

    def test_autostart_roundtrip(self):
        from arocall_agent import autostart as am
        self.assertFalse(am.is_enabled())
        p = am.enable(exe="/tmp/fake/arocall-agent")
        self.assertTrue(am.is_enabled())
        text = p.read_text()
        self.assertIn("/tmp/fake/arocall-agent run", text)
        self.assertIn("[Desktop Entry]", text)
        self.assertTrue(am.disable())
        self.assertFalse(am.is_enabled())
        self.assertFalse(am.disable())

    def test_consent_storage(self):
        from arocall_agent import config as app_config
        self.assertEqual(app_config.load().get("consent_accepted_at"), "")
        app_config.save({"consent_accepted_at": "2026-01-01T00:00:00+00:00",
                         "notice_text": "Calls are recorded."})
        cfg = app_config.load()
        self.assertEqual(cfg["consent_accepted_at"], "2026-01-01T00:00:00+00:00")
        self.assertEqual(cfg["notice_text"], "Calls are recorded.")

    def test_diagnostics_never_leaks_key(self):
        from arocall_agent import config as app_config
        from arocall_agent import diagnostics as diag
        from arocall_agent import keystore
        import arocall_agent.keystore as ks
        real = ks._keyring
        ks._keyring = lambda: None
        try:
            ks.save_key("ak_super_secret_123")
            text = diag.format_text(diag.collect())
        finally:
            ks._keyring = real
        self.assertNotIn("ak_super_secret_123", text)
        self.assertIn("agent_version", text)
        self.assertIn("tools:", text)


if __name__ == "__main__":
    unittest.main()
