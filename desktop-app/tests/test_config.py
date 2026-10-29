"""Phase-1 tests: config + key storage. Run: python3 -m unittest discover -s tests -v"""
import os
import stat
import tempfile
import unittest


class ConfigTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["XDG_CONFIG_HOME"] = self.tmp.name + "/cfg"
        os.environ["XDG_DATA_HOME"] = self.tmp.name + "/data"
        import sys
        sys.path.insert(0, "src")
        global app_config, keystore
        from arocall_agent import config as app_config
        from arocall_agent import keystore

    def tearDown(self):
        self.tmp.cleanup()

    def test_dirs_are_700(self):
        d = app_config.config_dir()
        self.assertEqual(oct(stat.S_IMODE(os.stat(d).st_mode)), "0o700")

    def test_save_load_roundtrip_and_600_file(self):
        app_config.save({"employee_name": "Test"})
        self.assertEqual(app_config.load()["employee_name"], "Test")
        self.assertEqual(oct(stat.S_IMODE(os.stat(app_config.config_path()).st_mode)), "0o600")

    def test_backend_url_env_override(self):
        os.environ["AROCALL_BACKEND_URL"] = "http://example:1234"
        try:
            self.assertEqual(app_config.load()["backend_url"], "http://example:1234")
        finally:
            del os.environ["AROCALL_BACKEND_URL"]

    def test_key_roundtrip_file_fallback(self):
        # force file backend by hiding keyring
        import arocall_agent.keystore as ks
        real = ks._keyring
        ks._keyring = lambda: None
        try:
            self.assertEqual(ks.save_key("ak_test123"), "file")
            self.assertEqual(ks.load_key(), "ak_test123")
            p = ks._fallback_path()
            self.assertEqual(oct(stat.S_IMODE(os.stat(p).st_mode)), "0o600")
            ks.clear_key()
            self.assertEqual(ks.load_key(), "")
        finally:
            ks._keyring = real


if __name__ == "__main__":
    unittest.main()
