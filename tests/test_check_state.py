"""
Tests for the persisted per-source last-check summaries (get_check_state / save_check_state).

Run with: python3 -m unittest tests.test_check_state -v
"""

import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _stub import decky_stub, run  # noqa: E402

from main import Plugin  # noqa: E402


def entry(timestamp=1_700_000_000_000, pending=2, forced=1, errors=None):
    return {"timestamp": timestamp, "pendingCount": pending, "forcedCount": forced, "errors": errors or []}


class TestCheckState(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmpdir)
        self.p = Plugin()
        self.p.settings = {}
        self.p.check_state_path = os.path.join(self.tmpdir, "check_state.json")

    def test_missing_file_is_empty(self):
        self.assertEqual(run(self.p.get_check_state()), {})

    def test_round_trip(self):
        state = {"steam": entry(), "flatpak": entry(pending=0, forced=0, errors=["Offline: no network"])}
        self.assertTrue(run(self.p.save_check_state(state)))
        self.assertEqual(run(self.p.get_check_state()), state)

    def test_persisted_next_to_other_settings_files(self):
        decky_stub.DECKY_PLUGIN_SETTINGS_DIR, saved = self.tmpdir, decky_stub.DECKY_PLUGIN_SETTINGS_DIR
        self.addCleanup(setattr, decky_stub, "DECKY_PLUGIN_SETTINGS_DIR", saved)
        p = Plugin()
        p.settings = {}
        run(p.save_check_state({"steam": entry()}))
        self.assertTrue(os.path.isfile(os.path.join(self.tmpdir, "check_state.json")))

    def test_corrupt_file_is_empty_and_quarantined(self):
        with open(self.p.check_state_path, "w") as f:
            f.write("{not json")
        self.assertEqual(run(self.p.get_check_state()), {})
        self.assertTrue(os.path.exists(self.p.check_state_path + ".corrupt"))

    def test_non_object_file_is_empty(self):
        with open(self.p.check_state_path, "w") as f:
            json.dump([1, 2, 3], f)
        self.assertEqual(run(self.p.get_check_state()), {})

    def test_unknown_sources_are_dropped(self):
        run(self.p.save_check_state({"steam": entry(), "bogus": entry(), "": entry()}))
        self.assertEqual(list(run(self.p.get_check_state())), ["steam"])

    def test_all_known_sources_are_accepted(self):
        sources = ["steam", "flatpak", "decky", "decky-loader", "steamos"]
        run(self.p.save_check_state({s: entry() for s in sources}))
        self.assertEqual(sorted(run(self.p.get_check_state())), sorted(sources))

    def test_invalid_entries_are_dropped(self):
        state = {
            "steam": "nope",
            "flatpak": {"timestamp": "yesterday", "pendingCount": 1, "forcedCount": 0},
            "decky": {"pendingCount": 1, "forcedCount": 0},
            "decky-loader": {"timestamp": 5, "pendingCount": None, "forcedCount": 0},
            "steamos": entry(),
        }
        run(self.p.save_check_state(state))
        self.assertEqual(list(run(self.p.get_check_state())), ["steamos"])

    def test_bool_numbers_are_rejected(self):
        run(self.p.save_check_state({"steam": {"timestamp": True, "pendingCount": 1, "forcedCount": 0}}))
        self.assertEqual(run(self.p.get_check_state()), {})

    def test_floats_from_javascript_become_ints(self):
        run(self.p.save_check_state({"steam": entry(timestamp=1_700_000_000_000.0, pending=3.0, forced=1.0)}))
        saved = run(self.p.get_check_state())["steam"]
        self.assertEqual(saved, entry(pending=3, forced=1))
        self.assertIsInstance(saved["timestamp"], int)
        self.assertIsInstance(saved["pendingCount"], int)

    def test_errors_capped_in_count_and_length(self):
        run(self.p.save_check_state({"steam": entry(errors=["a" * 500, "b", "c", "d", "e"])}))
        errors = run(self.p.get_check_state())["steam"]["errors"]
        self.assertEqual(len(errors), 3)
        self.assertEqual(errors[0], "a" * 200)
        self.assertEqual(errors[1:], ["b", "c"])

    def test_non_string_errors_are_dropped(self):
        run(self.p.save_check_state({"steam": entry(errors=["ok", 5, None, "also ok"])}))
        self.assertEqual(run(self.p.get_check_state())["steam"]["errors"], ["ok", "also ok"])

    def test_missing_errors_default_to_empty(self):
        raw = {"timestamp": 1000, "pendingCount": 0, "forcedCount": 0}
        run(self.p.save_check_state({"steam": raw}))
        self.assertEqual(run(self.p.get_check_state())["steam"]["errors"], [])

    def test_stored_file_is_sanitized_on_read(self):
        with open(self.p.check_state_path, "w") as f:
            json.dump({"steam": entry(errors=["x"] * 9), "bogus": entry()}, f)
        state = run(self.p.get_check_state())
        self.assertEqual(list(state), ["steam"])
        self.assertEqual(len(state["steam"]["errors"]), 3)

    def test_saves_merge_by_source(self):
        run(self.p.save_check_state({"steam": entry(pending=1)}))
        run(self.p.save_check_state({"flatpak": entry(pending=4)}))
        state = run(self.p.get_check_state())
        self.assertEqual(state["steam"]["pendingCount"], 1)
        self.assertEqual(state["flatpak"]["pendingCount"], 4)

    def test_save_overwrites_same_source(self):
        run(self.p.save_check_state({"steam": entry(pending=1)}))
        run(self.p.save_check_state({"steam": entry(pending=7)}))
        self.assertEqual(run(self.p.get_check_state())["steam"]["pendingCount"], 7)

    def test_older_timestamp_does_not_overwrite_newer_entry(self):
        run(self.p.save_check_state({"steam": entry(timestamp=2000, pending=5)}))
        run(self.p.save_check_state({"steam": entry(timestamp=1000, pending=9)}))
        saved = run(self.p.get_check_state())["steam"]
        self.assertEqual(saved["timestamp"], 2000)
        self.assertEqual(saved["pendingCount"], 5)

    def test_future_stored_entry_does_not_block_later_saves(self):
        import time
        future = int(time.time() * 1000) + 9 * 3600 * 1000
        with open(self.p.check_state_path, "w") as f:
            json.dump({"flatpak": entry(timestamp=future, pending=3, errors=["Offline: no network"])}, f)
        fresh = entry(timestamp=int(time.time() * 1000), pending=0, forced=0)
        self.assertTrue(run(self.p.save_check_state({"flatpak": fresh})))
        self.assertEqual(run(self.p.get_check_state())["flatpak"], fresh)

    def test_newer_timestamp_replaces_older_entry(self):
        run(self.p.save_check_state({"steam": entry(timestamp=1000, pending=9)}))
        run(self.p.save_check_state({"steam": entry(timestamp=2000, pending=5)}))
        saved = run(self.p.get_check_state())["steam"]
        self.assertEqual(saved["timestamp"], 2000)
        self.assertEqual(saved["pendingCount"], 5)

    def test_equal_timestamp_overwrites(self):
        run(self.p.save_check_state({"steam": entry(timestamp=1000, pending=9)}))
        run(self.p.save_check_state({"steam": entry(timestamp=1000, pending=5)}))
        self.assertEqual(run(self.p.get_check_state())["steam"]["pendingCount"], 5)

    def test_stale_snapshot_merges_per_source(self):
        run(self.p.save_check_state({"steam": entry(timestamp=5000, pending=1), "flatpak": entry(timestamp=1000, pending=1)}))
        run(self.p.save_check_state({
            "steam": entry(timestamp=2000, pending=8),
            "flatpak": entry(timestamp=3000, pending=8),
            "decky": entry(timestamp=2000, pending=8),
        }))
        state = run(self.p.get_check_state())
        self.assertEqual((state["steam"]["timestamp"], state["steam"]["pendingCount"]), (5000, 1))
        self.assertEqual((state["flatpak"]["timestamp"], state["flatpak"]["pendingCount"]), (3000, 8))
        self.assertEqual((state["decky"]["timestamp"], state["decky"]["pendingCount"]), (2000, 8))

    def test_non_dict_state_is_rejected(self):
        self.assertFalse(run(self.p.save_check_state(["steam"])))
        self.assertFalse(run(self.p.save_check_state(None)))
        self.assertFalse(os.path.exists(self.p.check_state_path))

    def test_save_leaves_no_temp_file(self):
        run(self.p.save_check_state({"steam": entry()}))
        self.assertEqual(os.listdir(self.tmpdir), ["check_state.json"])


if __name__ == "__main__":
    unittest.main()
