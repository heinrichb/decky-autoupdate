"""
Tests for the frontend log endpoints (log_frontend_message, log_frontend_batch).

Run with: python3 -m unittest tests.test_frontend_log -v
"""

import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _stub import decky_stub, run  # noqa: E402

from main import Plugin  # noqa: E402

TS_MS = 1_700_000_000_123


def clock(ts_ms):
    return time.strftime("%H:%M:%S", time.localtime(ts_ms // 1000)) + f".{ts_ms % 1000:03d}"


def make_plugin(debug=False):
    p = Plugin()
    p.settings = {"debugLogging": debug}
    return p


class TestLogFrontendBatch(unittest.TestCase):

    def setUp(self):
        decky_stub.logger.records.clear()

    def test_logs_each_entry_with_frontend_event_time(self):
        p = make_plugin()
        count = run(p.log_frontend_batch([["info", "hello", TS_MS], ["info", "world", TS_MS + 5]]))
        self.assertEqual(count, 2)
        self.assertEqual(
            decky_stub.logger.messages("info"),
            [f"[Frontend {clock(TS_MS)}] hello", f"[Frontend {clock(TS_MS + 5)}] world"],
        )

    def test_levels_route_to_logger_levels(self):
        p = make_plugin()
        run(p.log_frontend_batch([["error", "e", TS_MS], ["warn", "w", TS_MS], ["info", "i", TS_MS]]))
        self.assertEqual(decky_stub.logger.messages("error"), [f"[Frontend {clock(TS_MS)}] e"])
        self.assertEqual(decky_stub.logger.messages("warning"), [f"[Frontend {clock(TS_MS)}] w"])
        self.assertEqual(decky_stub.logger.messages("info"), [f"[Frontend {clock(TS_MS)}] i"])

    def test_debug_entries_carry_debug_marker_when_enabled(self):
        p = make_plugin(debug=True)
        run(p.log_frontend_batch([["debug", "details", TS_MS]]))
        self.assertEqual(decky_stub.logger.messages("info"), [f"[DEBUG] [Frontend {clock(TS_MS)}] details"])

    def test_debug_entries_suppressed_when_disabled(self):
        p = make_plugin(debug=False)
        run(p.log_frontend_batch([["debug", "details", TS_MS]]))
        self.assertEqual(decky_stub.logger.records, [])

    def test_unknown_level_logs_as_info(self):
        p = make_plugin()
        run(p.log_frontend_batch([["notice", "n", TS_MS]]))
        self.assertEqual(decky_stub.logger.messages("info"), [f"[Frontend {clock(TS_MS)}] n"])

    def test_caps_entries_per_call(self):
        p = make_plugin()
        entries = [["info", f"m{i}", TS_MS] for i in range(600)]
        self.assertEqual(run(p.log_frontend_batch(entries)), 500)
        self.assertEqual(len(decky_stub.logger.messages("info")), 500)

    def test_truncates_long_messages(self):
        p = make_plugin()
        run(p.log_frontend_batch([["info", "x" * 2500, TS_MS]]))
        line = decky_stub.logger.messages("info")[0]
        self.assertTrue(line.endswith("x" * 2000 + "...(truncated)"))

    def test_skips_malformed_entries(self):
        p = make_plugin()
        entries = ["nope", ["info"], ["info", 5, TS_MS], None, ["info", "good", TS_MS]]
        self.assertEqual(run(p.log_frontend_batch(entries)), 1)
        self.assertEqual(decky_stub.logger.messages("info"), [f"[Frontend {clock(TS_MS)}] good"])

    def test_missing_or_invalid_timestamp_uses_plain_tag(self):
        p = make_plugin()
        run(p.log_frontend_batch([["info", "a"], ["info", "b", "yesterday"], ["info", "c", None], ["info", "d", True]]))
        self.assertEqual(
            decky_stub.logger.messages("info"),
            ["[Frontend] a", "[Frontend] b", "[Frontend] c", "[Frontend] d"],
        )

    def test_float_timestamps_from_javascript(self):
        p = make_plugin()
        run(p.log_frontend_batch([["info", "f", float(TS_MS) + 0.4]]))
        self.assertEqual(decky_stub.logger.messages("info"), [f"[Frontend {clock(TS_MS)}] f"])

    def test_non_list_payload(self):
        p = make_plugin()
        self.assertEqual(run(p.log_frontend_batch("not a list")), 0)
        self.assertEqual(run(p.log_frontend_batch(None)), 0)
        self.assertEqual(decky_stub.logger.records, [])

    def test_empty_batch(self):
        self.assertEqual(run(make_plugin().log_frontend_batch([])), 0)


class TestLogFrontendMessage(unittest.TestCase):

    def setUp(self):
        decky_stub.logger.records.clear()

    def test_still_supported(self):
        p = make_plugin()
        self.assertTrue(run(p.log_frontend_message("warn", "careful")))
        self.assertEqual(decky_stub.logger.messages("warning"), ["[Frontend] careful"])

    def test_non_string_message_rejected(self):
        self.assertFalse(run(make_plugin().log_frontend_message("info", 5)))

    def test_long_message_truncated(self):
        p = make_plugin()
        run(p.log_frontend_message("info", "y" * 2500))
        self.assertTrue(decky_stub.logger.messages("info")[0].endswith("y" * 2000 + "...(truncated)"))


if __name__ == "__main__":
    unittest.main()
