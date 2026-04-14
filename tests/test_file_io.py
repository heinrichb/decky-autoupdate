"""
Tests for Plugin._load_json, _write_json, and _default_settings.

Covers:
- Reading valid/invalid/missing/corrupt JSON files
- Writing JSON and auto-creating directories
- The defaults merge logic (hardcoded + file = complete defaults)

Run with: python3 -m unittest tests.test_file_io -v
"""

import sys
import os
import json
import types
import tempfile
import shutil
import unittest

# Stub decky
decky_stub = types.ModuleType("decky")
decky_stub.DECKY_PLUGIN_SETTINGS_DIR = "/tmp/test_autoupdate"
decky_stub.DECKY_PLUGIN_DIR = "/tmp/test_autoupdate_plugin"
decky_stub.logger = types.SimpleNamespace(
    info=lambda *a: None,
    error=lambda *a: None,
    warning=lambda *a: None,
)
sys.modules["decky"] = decky_stub

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from main import Plugin


class TestLoadJson(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def _path(self, name):
        return os.path.join(self.tmpdir, name)

    def test_load_valid_json(self):
        path = self._path("valid.json")
        with open(path, "w") as f:
            json.dump({"key": "value"}, f)
        p = Plugin()
        result = p._load_json(path, {})
        self.assertEqual(result, {"key": "value"})

    def test_load_missing_file_returns_fallback(self):
        p = Plugin()
        result = p._load_json(self._path("nope.json"), {"fallback": True})
        self.assertEqual(result, {"fallback": True})

    def test_load_corrupt_file_returns_fallback(self):
        path = self._path("corrupt.json")
        with open(path, "w") as f:
            f.write("{broken json!!!")
        p = Plugin()
        result = p._load_json(path, {"safe": True})
        self.assertEqual(result, {"safe": True})

    def test_load_empty_file_returns_fallback(self):
        path = self._path("empty.json")
        with open(path, "w") as f:
            f.write("")
        p = Plugin()
        result = p._load_json(path, [])
        self.assertEqual(result, [])

    def test_load_list_json(self):
        path = self._path("list.json")
        with open(path, "w") as f:
            json.dump([1, 2, 3], f)
        p = Plugin()
        result = p._load_json(path, [])
        self.assertEqual(result, [1, 2, 3])


class TestWriteJson(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def _path(self, *parts):
        return os.path.join(self.tmpdir, *parts)

    def test_write_and_read_back(self):
        path = self._path("out.json")
        p = Plugin()
        ok = p._write_json(path, {"hello": "world"})
        self.assertTrue(ok)
        with open(path) as f:
            data = json.load(f)
        self.assertEqual(data, {"hello": "world"})

    def test_write_creates_parent_dirs(self):
        path = self._path("sub", "dir", "file.json")
        p = Plugin()
        ok = p._write_json(path, {"nested": True})
        self.assertTrue(ok)
        self.assertTrue(os.path.exists(path))

    def test_write_overwrites_existing(self):
        path = self._path("overwrite.json")
        p = Plugin()
        p._write_json(path, {"v": 1})
        p._write_json(path, {"v": 2})
        with open(path) as f:
            data = json.load(f)
        self.assertEqual(data["v"], 2)


class TestDefaultSettings(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        # Point decky stub at our temp dir
        decky_stub.DECKY_PLUGIN_DIR = self.tmpdir

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def test_hardcoded_defaults_without_file(self):
        """When no defaults/settings.json exists, returns hardcoded defaults."""
        p = Plugin()
        defaults = p._default_settings()
        self.assertIs(defaults["checkOnWake"], True)
        self.assertIs(defaults["steamEnabled"], True)
        self.assertEqual(defaults["steamCheckIntervalMinutes"], 30)

    def test_file_merges_into_hardcoded(self):
        """defaults/settings.json overrides hardcoded values but missing keys are kept."""
        defaults_dir = os.path.join(self.tmpdir, "defaults")
        os.makedirs(defaults_dir)
        # Write a file that overrides steamCheckIntervalMinutes but omits checkOnWake
        with open(os.path.join(defaults_dir, "settings.json"), "w") as f:
            json.dump({"steamCheckIntervalMinutes": 60}, f)

        p = Plugin()
        defaults = p._default_settings()
        # Overridden
        self.assertEqual(defaults["steamCheckIntervalMinutes"], 60)
        # Still present from hardcoded (the bug we fixed)
        self.assertIs(defaults["checkOnWake"], True)
        self.assertIs(defaults["showNotifications"], True)

    def test_stale_file_missing_new_field(self):
        """A stale defaults file missing a new field should still include it from hardcoded."""
        defaults_dir = os.path.join(self.tmpdir, "defaults")
        os.makedirs(defaults_dir)
        # Simulate an old defaults file that predates checkOnWake
        old_defaults = {
            "showNotifications": True,
            "logHistory": True,
            "maxHistoryEntries": 100,
            "steamEnabled": True,
            "steamCheckIntervalMinutes": 30,
            "flatpakEnabled": True,
            "flatpakCheckIntervalMinutes": 720,
            "flatpakAutoApply": True,
        }
        with open(os.path.join(defaults_dir, "settings.json"), "w") as f:
            json.dump(old_defaults, f)

        p = Plugin()
        defaults = p._default_settings()
        self.assertIn("checkOnWake", defaults)
        self.assertIs(defaults["checkOnWake"], True)

    def test_corrupt_defaults_file_falls_back_to_hardcoded(self):
        """A corrupt defaults file should still return valid defaults."""
        defaults_dir = os.path.join(self.tmpdir, "defaults")
        os.makedirs(defaults_dir)
        with open(os.path.join(defaults_dir, "settings.json"), "w") as f:
            f.write("NOT VALID JSON{{{")

        p = Plugin()
        defaults = p._default_settings()
        # _load_json returns {} on parse failure, merged into hardcoded = hardcoded
        self.assertIs(defaults["checkOnWake"], True)
        self.assertEqual(defaults["steamCheckIntervalMinutes"], 30)

    def test_all_hardcoded_keys_present(self):
        """Verify every expected key exists in defaults."""
        p = Plugin()
        decky_stub.DECKY_PLUGIN_DIR = "/nonexistent"  # force hardcoded path
        defaults = p._default_settings()
        expected_keys = {
            "showNotifications", "logHistory", "maxHistoryEntries",
            "steamEnabled", "steamCheckIntervalMinutes",
            "flatpakEnabled", "flatpakCheckIntervalMinutes",
            "flatpakAutoApply", "checkOnWake",
            "checkOnGameClose", "checkDuringGameplay",
            "deckyPluginUpdatesEnabled", "deckyCheckIntervalMinutes",
            "deckyPluginBlacklist",
            "deckyLoaderUpdateEnabled",
            "steamosUpdateEnabled", "steamosCheckIntervalMinutes",
        }
        self.assertEqual(set(defaults.keys()), expected_keys)


if __name__ == "__main__":
    unittest.main()
