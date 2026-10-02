"""
Tests for the Plugin._validate_settings method.

These test the exact class of bugs that have caused issues:
- New settings fields missing from saved JSON
- JavaScript sending floats for integer settings
- Type mismatches between frontend and backend
- Settings clamping ranges

Run with: python3 -m unittest tests.test_settings -v
  (from the project root directory)
"""

import sys
import os
import json
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _stub import decky_stub  # noqa: E402

from main import Plugin  # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OLD_LIGHTEST_ORDER = ["steamos", "decky-loader", "decky", "flatpak", "steam"]
LIGHTEST_ORDER = ["steam", "decky", "steamos", "decky-loader", "flatpak"]


def make_plugin():
    """Create a Plugin instance for testing (no async _main needed)."""
    p = Plugin()
    p.settings = p._default_settings()
    return p


class TestValidateSettings(unittest.TestCase):
    """Tests for _validate_settings - the most critical backend function."""

    def test_defaults_are_complete(self):
        """Every field in defaults should be present and have the right type."""
        p = make_plugin()
        defaults = p._default_settings()
        validated = p._validate_settings({})

        for key, default_val in defaults.items():
            self.assertIn(key, validated, f"Missing key: {key}")
            self.assertEqual(validated[key], default_val)

    def test_empty_settings_returns_all_defaults(self):
        """An empty dict should produce all default values."""
        p = make_plugin()
        result = p._validate_settings({})
        defaults = p._default_settings()
        self.assertEqual(result, defaults)

    def test_new_field_not_in_saved_json(self):
        """Saved settings missing a new field should get the default value.
        This is the exact bug where checkOnWake was undefined."""
        p = make_plugin()
        saved = {
            "notificationLevel": "updates-only",
            "logHistory": True,
            "maxHistoryEntries": 100,
            "steamEnabled": True,
            "steamCheckIntervalMinutes": 30,
            "flatpakEnabled": True,
            "flatpakCheckIntervalMinutes": 720,
            "flatpakAutoApply": True,
            # checkOnWake, checkOnGameClose, checkDuringGameplay intentionally missing
        }
        result = p._validate_settings(saved)
        self.assertIs(result["checkOnWake"], True)
        self.assertIs(result["checkOnGameClose"], True)
        self.assertIs(result["checkDuringGameplay"], False)
        self.assertIs(result["deckyPluginUpdatesEnabled"], False)
        self.assertEqual(result["deckyCheckIntervalMinutes"], 1440)
        self.assertEqual(result["deckyPluginBlacklist"], [])

    def test_float_integers_from_javascript(self):
        """JS sends all numbers as floats over JSON. They must be accepted and coerced to int."""
        p = make_plugin()
        settings = {
            "steamCheckIntervalMinutes": 30.0,
            "flatpakCheckIntervalMinutes": 720.0,
            "maxHistoryEntries": 100.0,
        }
        result = p._validate_settings(settings)
        self.assertEqual(result["steamCheckIntervalMinutes"], 30)
        self.assertIsInstance(result["steamCheckIntervalMinutes"], int)
        self.assertEqual(result["flatpakCheckIntervalMinutes"], 720)
        self.assertIsInstance(result["flatpakCheckIntervalMinutes"], int)
        self.assertEqual(result["maxHistoryEntries"], 100)
        self.assertIsInstance(result["maxHistoryEntries"], int)

    def test_bool_not_confused_with_int(self):
        """bool is a subclass of int in Python. Booleans must stay booleans."""
        p = make_plugin()
        settings = {
            "steamEnabled": True,
            "flatpakEnabled": False,
            "checkOnWake": True,
            "notificationLevel": "off",
            "checkOnGameClose": True,
            "checkDuringGameplay": False,
        }
        result = p._validate_settings(settings)
        self.assertIs(result["steamEnabled"], True)
        self.assertIs(result["flatpakEnabled"], False)
        self.assertIs(result["checkOnWake"], True)
        self.assertEqual(result["notificationLevel"], "off")
        self.assertIs(result["checkOnGameClose"], True)
        self.assertIs(result["checkDuringGameplay"], False)

    def test_int_not_accepted_for_bool_field(self):
        """An integer (1 or 0) should NOT be accepted for a boolean field."""
        p = make_plugin()
        result = p._validate_settings({"steamEnabled": 1, "checkOnWake": 0})
        self.assertIs(result["steamEnabled"], True)   # default
        self.assertIs(result["checkOnWake"], True)     # default

    def test_string_for_int_field_reverts_to_default(self):
        p = make_plugin()
        result = p._validate_settings({"steamCheckIntervalMinutes": "thirty"})
        self.assertEqual(result["steamCheckIntervalMinutes"], 30)

    def test_string_for_bool_field_reverts_to_default(self):
        p = make_plugin()
        result = p._validate_settings({"steamEnabled": "yes"})
        self.assertIs(result["steamEnabled"], True)

    def test_clamping_steam_interval(self):
        p = make_plugin()
        self.assertEqual(p._validate_settings({"steamCheckIntervalMinutes": 1})["steamCheckIntervalMinutes"], 5)
        self.assertEqual(p._validate_settings({"steamCheckIntervalMinutes": 200})["steamCheckIntervalMinutes"], 120)
        self.assertEqual(p._validate_settings({"steamCheckIntervalMinutes": 60})["steamCheckIntervalMinutes"], 60)

    def test_clamping_flatpak_interval(self):
        p = make_plugin()
        self.assertEqual(p._validate_settings({"flatpakCheckIntervalMinutes": 10})["flatpakCheckIntervalMinutes"], 60)
        self.assertEqual(p._validate_settings({"flatpakCheckIntervalMinutes": 2000})["flatpakCheckIntervalMinutes"], 1440)

    def test_clamping_max_history(self):
        p = make_plugin()
        self.assertEqual(p._validate_settings({"maxHistoryEntries": 0})["maxHistoryEntries"], 1)
        self.assertEqual(p._validate_settings({"maxHistoryEntries": 5000})["maxHistoryEntries"], 1000)

    def test_clamping_decky_interval(self):
        p = make_plugin()
        self.assertEqual(p._validate_settings({"deckyCheckIntervalMinutes": 10})["deckyCheckIntervalMinutes"], 60)
        self.assertEqual(p._validate_settings({"deckyCheckIntervalMinutes": 5000})["deckyCheckIntervalMinutes"], 2880)
        self.assertEqual(p._validate_settings({"deckyCheckIntervalMinutes": 720})["deckyCheckIntervalMinutes"], 720)

    def test_blacklist_validation(self):
        """Blacklist must be a list of strings."""
        p = make_plugin()
        # Valid list
        result = p._validate_settings({"deckyPluginBlacklist": ["PluginA", "PluginB"]})
        self.assertEqual(result["deckyPluginBlacklist"], ["PluginA", "PluginB"])

        # Non-string entries filtered out
        result = p._validate_settings({"deckyPluginBlacklist": ["Valid", 123, None, True]})
        self.assertEqual(result["deckyPluginBlacklist"], ["Valid"])

        # Not a list reverts to default
        result = p._validate_settings({"deckyPluginBlacklist": "not a list"})
        self.assertEqual(result["deckyPluginBlacklist"], [])

    def test_migrate_old_check_interval(self):
        p = make_plugin()
        result = p._validate_settings({"checkIntervalMinutes": 45})
        self.assertEqual(result["steamCheckIntervalMinutes"], 45)

    def test_migrate_does_not_overwrite_new_key(self):
        p = make_plugin()
        result = p._validate_settings({
            "checkIntervalMinutes": 45,
            "steamCheckIntervalMinutes": 60,
        })
        self.assertEqual(result["steamCheckIntervalMinutes"], 60)

    def test_extra_keys_are_stripped(self):
        p = make_plugin()
        result = p._validate_settings({"unknownFutureField": "hello", "steamEnabled": True})
        self.assertNotIn("unknownFutureField", result)

    def test_none_values_revert_to_default(self):
        p = make_plugin()
        result = p._validate_settings({
            "steamEnabled": None,
            "steamCheckIntervalMinutes": None,
            "checkOnWake": None,
        })
        self.assertIs(result["steamEnabled"], True)
        self.assertEqual(result["steamCheckIntervalMinutes"], 30)
        self.assertIs(result["checkOnWake"], True)

    def test_full_round_trip(self):
        """Validate -> JSON serialize -> parse -> validate should be stable."""
        p = make_plugin()
        original = p._validate_settings({})
        json_str = json.dumps(original)
        loaded = json.loads(json_str)
        round_tripped = p._validate_settings(loaded)
        self.assertEqual(round_tripped, original)

    def test_float_round_trip(self):
        """Settings with float values should round-trip correctly through JSON."""
        p = make_plugin()
        settings = {"steamCheckIntervalMinutes": 30.0, "flatpakCheckIntervalMinutes": 720.0}
        validated = p._validate_settings(settings)
        json_str = json.dumps(validated)
        loaded = json.loads(json_str)
        round_tripped = p._validate_settings(loaded)
        self.assertEqual(round_tripped, validated)


    # ── notificationLevel migration and enum validation ──

    def test_migrate_showNotifications_true_to_updates_only(self):
        """Legacy showNotifications=True should become notificationLevel='updates-only'."""
        p = make_plugin()
        result = p._validate_settings({"showNotifications": True})
        self.assertEqual(result["notificationLevel"], "updates-only")
        self.assertNotIn("showNotifications", result)

    def test_migrate_showNotifications_false_to_off(self):
        """Legacy showNotifications=False should become notificationLevel='off'."""
        p = make_plugin()
        result = p._validate_settings({"showNotifications": False})
        self.assertEqual(result["notificationLevel"], "off")
        self.assertNotIn("showNotifications", result)

    def test_no_migration_when_notificationLevel_already_set(self):
        """If both showNotifications and notificationLevel exist, keep notificationLevel."""
        p = make_plugin()
        result = p._validate_settings({
            "showNotifications": False,
            "notificationLevel": "all",
        })
        self.assertEqual(result["notificationLevel"], "all")

    def test_invalid_notificationLevel_reverts_to_default(self):
        """Invalid enum value should revert to default."""
        p = make_plugin()
        result = p._validate_settings({"notificationLevel": "invalid"})
        self.assertEqual(result["notificationLevel"], "updates-only")

    def test_valid_notificationLevel_values(self):
        """All valid enum values should be accepted."""
        p = make_plugin()
        for level in ("off", "updates-only", "all"):
            result = p._validate_settings({"notificationLevel": level})
            self.assertEqual(result["notificationLevel"], level)

    def test_debugLogging_defaults_to_false(self):
        p = make_plugin()
        result = p._validate_settings({})
        self.assertIs(result["debugLogging"], False)

    def test_debugLogging_accepts_boolean(self):
        p = make_plugin()
        result = p._validate_settings({"debugLogging": True})
        self.assertIs(result["debugLogging"], True)

    def test_debugLogging_rejects_non_boolean(self):
        p = make_plugin()
        result = p._validate_settings({"debugLogging": "yes"})
        self.assertIs(result["debugLogging"], False)

    def test_decky_interval_clamping(self):
        """Decky and SteamOS intervals should be clamped."""
        p = make_plugin()
        result = p._validate_settings({
            "deckyCheckIntervalMinutes": 10,
            "steamosCheckIntervalMinutes": 5000,
        })
        self.assertEqual(result["deckyCheckIntervalMinutes"], 60)
        self.assertEqual(result["steamosCheckIntervalMinutes"], 2880)

    # ── checkOrder defaults and migration ──

    def test_default_check_order_is_lightest_first(self):
        p = make_plugin()
        self.assertEqual(p._default_settings()["checkOrder"], LIGHTEST_ORDER)
        self.assertEqual(p._validate_settings({})["checkOrder"], LIGHTEST_ORDER)

    def test_shipped_defaults_file_uses_lightest_first_order(self):
        with open(os.path.join(REPO_ROOT, "defaults", "settings.json")) as f:
            self.assertEqual(json.load(f)["checkOrder"], LIGHTEST_ORDER)

    def test_shipped_defaults_merge_to_lightest_first_order(self):
        saved = decky_stub.DECKY_PLUGIN_DIR
        decky_stub.DECKY_PLUGIN_DIR = REPO_ROOT
        self.addCleanup(setattr, decky_stub, "DECKY_PLUGIN_DIR", saved)
        self.assertEqual(Plugin()._default_settings()["checkOrder"], LIGHTEST_ORDER)

    def test_old_lightest_order_migrates_to_new_lightest_order(self):
        p = make_plugin()
        result = p._validate_settings({"checkOrder": list(OLD_LIGHTEST_ORDER)})
        self.assertEqual(result["checkOrder"], LIGHTEST_ORDER)

    def test_migration_survives_save_round_trip(self):
        p = make_plugin()
        once = p._validate_settings({"checkOrder": list(OLD_LIGHTEST_ORDER)})
        twice = p._validate_settings(json.loads(json.dumps(once)))
        self.assertEqual(twice["checkOrder"], LIGHTEST_ORDER)

    def test_custom_order_is_preserved(self):
        p = make_plugin()
        custom = ["flatpak", "steam", "decky", "steamos", "decky-loader"]
        self.assertEqual(p._validate_settings({"checkOrder": list(custom)})["checkOrder"], custom)

    def test_other_permutations_are_not_migrated(self):
        p = make_plugin()
        almost = ["steamos", "decky-loader", "decky", "steam", "flatpak"]
        self.assertEqual(p._validate_settings({"checkOrder": list(almost)})["checkOrder"], almost)

    def test_partial_order_is_completed_with_default_tail(self):
        p = make_plugin()
        result = p._validate_settings({"checkOrder": ["flatpak", "steam"]})
        self.assertEqual(result["checkOrder"], ["flatpak", "steam", "decky", "steamos", "decky-loader"])

    def test_unknown_and_duplicate_sources_are_dropped(self):
        p = make_plugin()
        result = p._validate_settings({"checkOrder": ["steam", "bogus", "steam", 5, "decky"]})
        self.assertEqual(result["checkOrder"], ["steam", "decky", "steamos", "decky-loader", "flatpak"])


if __name__ == "__main__":
    unittest.main()
