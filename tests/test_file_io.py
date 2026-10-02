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
import tempfile
import shutil
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _stub import decky_stub  # noqa: E402

from main import Plugin  # noqa: E402


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

    def test_corrupt_file_is_renamed_aside(self):
        path = self._path("history.json")
        with open(path, "w") as f:
            f.write("{broken json!!!")
        p = Plugin()
        self.assertEqual(p._load_json(path, {"safe": True}), {"safe": True})
        self.assertFalse(os.path.exists(path))
        with open(path + ".corrupt") as f:
            self.assertEqual(f.read(), "{broken json!!!")

    def test_empty_file_is_renamed_aside(self):
        path = self._path("empty.json")
        open(path, "w").close()
        Plugin()._load_json(path, {})
        self.assertTrue(os.path.exists(path + ".corrupt"))

    def test_corruption_is_logged(self):
        path = self._path("settings.json")
        with open(path, "w") as f:
            f.write("nope")
        decky_stub.logger.records.clear()
        Plugin()._load_json(path, {})
        self.assertTrue(any("settings.json" in m for m in decky_stub.logger.messages("error")))

    def test_binary_garbage_is_renamed_aside(self):
        path = self._path("binary.json")
        with open(path, "wb") as f:
            f.write(b"\xff\xfe\x00\x80")
        self.assertEqual(Plugin()._load_json(path, {"x": 1}), {"x": 1})
        self.assertTrue(os.path.exists(path + ".corrupt"))

    def test_missing_file_is_not_renamed_or_logged(self):
        decky_stub.logger.records.clear()
        Plugin()._load_json(self._path("nope.json"), {})
        self.assertEqual(os.listdir(self.tmpdir), [])
        self.assertEqual(decky_stub.logger.messages("error"), [])

    def test_newer_corruption_replaces_older_quarantine_file(self):
        path = self._path("history.json")
        p = Plugin()
        for text in ("first bad", "second bad"):
            with open(path, "w") as f:
                f.write(text)
            p._load_json(path, {})
        with open(path + ".corrupt") as f:
            self.assertEqual(f.read(), "second bad")


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

    def test_write_leaves_no_temp_file(self):
        path = self._path("out.json")
        Plugin()._write_json(path, {"a": 1})
        self.assertEqual(os.listdir(self.tmpdir), ["out.json"])

    def test_write_fsyncs_before_replacing(self):
        path = self._path("out.json")
        events = []
        real_fsync, real_replace = os.fsync, os.replace
        with patch("os.fsync", side_effect=lambda fd: (events.append("fsync"), real_fsync(fd))[1]), \
             patch("os.replace", side_effect=lambda a, b: (events.append("replace"), real_replace(a, b))[1]):
            self.assertTrue(Plugin()._write_json(path, {"a": 1}))
        self.assertEqual(events, ["fsync", "replace"])

    def test_failed_replace_keeps_original_and_removes_temp(self):
        path = self._path("keep.json")
        p = Plugin()
        p._write_json(path, {"v": "original"})
        with patch("os.replace", side_effect=OSError("disk gone")):
            self.assertFalse(p._write_json(path, {"v": "new"}))
        with open(path) as f:
            self.assertEqual(json.load(f), {"v": "original"})
        self.assertEqual(os.listdir(self.tmpdir), ["keep.json"])

    def test_failed_serialization_keeps_original_and_removes_temp(self):
        path = self._path("keep.json")
        p = Plugin()
        p._write_json(path, {"v": "original"})
        self.assertFalse(p._write_json(path, {"v": object()}))
        with open(path) as f:
            self.assertEqual(json.load(f), {"v": "original"})
        self.assertEqual(os.listdir(self.tmpdir), ["keep.json"])

    def test_failed_first_write_leaves_nothing_behind(self):
        path = self._path("new.json")
        with patch("os.replace", side_effect=OSError("disk gone")):
            self.assertFalse(Plugin()._write_json(path, {"v": 1}))
        self.assertEqual(os.listdir(self.tmpdir), [])

    def test_existing_file_ownership_and_mode_are_preserved(self):
        path = self._path("owned.json")
        p = Plugin()
        p._write_json(path, {"v": 1})
        os.chmod(path, 0o640)
        st = os.stat(path)
        with patch("os.chown") as chown:
            self.assertTrue(p._write_json(path, {"v": 2}))
        chown.assert_called_once_with(path + ".tmp", st.st_uid, st.st_gid)
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o640)

    def test_new_file_is_not_chowned(self):
        with patch("os.chown") as chown:
            self.assertTrue(Plugin()._write_json(self._path("fresh.json"), {"v": 1}))
        chown.assert_not_called()

    def test_chown_failure_does_not_fail_the_write(self):
        path = self._path("owned.json")
        p = Plugin()
        p._write_json(path, {"v": 1})
        with patch("os.chown", side_effect=PermissionError("not root")):
            self.assertTrue(p._write_json(path, {"v": 2}))
        with open(path) as f:
            self.assertEqual(json.load(f), {"v": 2})


class TestDefaultSettings(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmpdir)
        self.addCleanup(setattr, decky_stub, "DECKY_PLUGIN_DIR", decky_stub.DECKY_PLUGIN_DIR)
        decky_stub.DECKY_PLUGIN_DIR = self.tmpdir

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
        self.assertEqual(defaults["notificationLevel"], "updates-only")

    def test_stale_file_missing_new_field(self):
        """A stale defaults file missing a new field should still include it from hardcoded."""
        defaults_dir = os.path.join(self.tmpdir, "defaults")
        os.makedirs(defaults_dir)
        # Simulate an old defaults file that predates checkOnWake
        old_defaults = {
            "notificationLevel": "updates-only",
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
            "notificationLevel", "debugLogging",
            "logHistory", "maxHistoryEntries",
            "steamEnabled", "steamCheckIntervalMinutes",
            "flatpakEnabled", "flatpakCheckIntervalMinutes",
            "flatpakAutoApply", "checkOnWake",
            "checkOnGameClose", "checkDuringGameplay",
            "deckyPluginUpdatesEnabled", "deckyCheckIntervalMinutes",
            "deckyPluginBlacklist",
            "deckyLoaderUpdateEnabled",
            "steamosUpdateEnabled", "steamosCheckIntervalMinutes",
            "interCheckDelayMs", "checkOrder",
        }
        self.assertEqual(set(defaults.keys()), expected_keys)


if __name__ == "__main__":
    unittest.main()
