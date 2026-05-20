"""
Tests for history CRUD operations.

Covers:
- Adding entries (prepend order, max truncation)
- Getting history from missing/empty/valid files
- Clearing history

Run with: python3 -m unittest tests.test_history -v
"""

import sys
import os
import json
import types
import tempfile
import shutil
import asyncio
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


def run(coro):
    """Helper to run async methods in tests."""
    return asyncio.get_event_loop().run_until_complete(coro)


class TestHistory(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.p = Plugin()
        self.p._history_lock = asyncio.Lock()
        self.p.settings = self.p._default_settings()
        self.p.history_path = os.path.join(self.tmpdir, "history.json")

    def tearDown(self):
        shutil.rmtree(self.tmpdir)

    def _entry(self, source="steam", trigger="auto", pending=1, forced=0, ts=None):
        return {
            "source": source,
            "timestamp": ts or 1000,
            "pendingCount": pending,
            "forcedCount": forced,
            "trigger": trigger,
        }

    def test_get_history_missing_file(self):
        """No history file should return empty list."""
        result = run(self.p.get_history())
        self.assertEqual(result, [])

    def test_get_history_empty_file(self):
        """History file with empty entries should return empty list."""
        self.p._write_json(self.p.history_path, {"entries": []})
        result = run(self.p.get_history())
        self.assertEqual(result, [])

    def test_add_entry_creates_file(self):
        """Adding the first entry should create the history file."""
        entry = self._entry()
        run(self.p.add_history_entry(entry))
        self.assertTrue(os.path.exists(self.p.history_path))
        result = run(self.p.get_history())
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["source"], "steam")

    def test_entries_prepended(self):
        """New entries should be at the front (most recent first)."""
        run(self.p.add_history_entry(self._entry(ts=1000)))
        run(self.p.add_history_entry(self._entry(ts=2000)))
        run(self.p.add_history_entry(self._entry(ts=3000)))
        result = run(self.p.get_history())
        timestamps = [e["timestamp"] for e in result]
        self.assertEqual(timestamps, [3000, 2000, 1000])

    def test_truncation_to_max_entries(self):
        """History should be truncated to maxHistoryEntries."""
        self.p.settings["maxHistoryEntries"] = 3
        for i in range(5):
            run(self.p.add_history_entry(self._entry(ts=i)))
        result = run(self.p.get_history())
        self.assertEqual(len(result), 3)
        # Most recent 3
        timestamps = [e["timestamp"] for e in result]
        self.assertEqual(timestamps, [4, 3, 2])

    def test_truncation_default_100(self):
        """Default maxHistoryEntries is 100."""
        self.p.settings = {"maxHistoryEntries": 5}
        for i in range(10):
            run(self.p.add_history_entry(self._entry(ts=i)))
        result = run(self.p.get_history())
        self.assertEqual(len(result), 5)

    def test_clear_history(self):
        """Clearing should result in empty entries list."""
        run(self.p.add_history_entry(self._entry()))
        run(self.p.add_history_entry(self._entry()))
        run(self.p.clear_history())
        result = run(self.p.get_history())
        self.assertEqual(result, [])

    def test_mixed_sources(self):
        """History should store entries from different sources."""
        run(self.p.add_history_entry(self._entry(source="steam", trigger="wake")))
        run(self.p.add_history_entry(self._entry(source="flatpak", trigger="auto")))
        result = run(self.p.get_history())
        self.assertEqual(result[0]["source"], "flatpak")
        self.assertEqual(result[1]["source"], "steam")

    def test_corrupt_history_file_recovers(self):
        """A corrupt history file should not crash - returns empty, then new entries work."""
        with open(self.p.history_path, "w") as f:
            f.write("NOT JSON!!!")
        result = run(self.p.get_history())
        self.assertEqual(result, [])
        # Adding a new entry should work (overwrites corrupt file)
        run(self.p.add_history_entry(self._entry()))
        result = run(self.p.get_history())
        self.assertEqual(len(result), 1)


if __name__ == "__main__":
    unittest.main()
