"""
Tests for SteamOS update handling: single-flight apply and terminal output cleanup.

Run with: python3 -m unittest tests.test_steamos -v
"""

import asyncio
import os
import sys
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _stub import FakeExec, mock_process, run  # noqa: E402

from main import Plugin  # noqa: E402

PROGRESS = "\r\x1b[K\r0.00% 00:00:00\r\x1b[K\r12.50% 00:00:30\r\x1b[K\r100.00% 00:00:00\n"


def make_plugin():
    p = Plugin()
    p.settings = {}
    return p


class TestCleanTerminalOutput(unittest.TestCase):

    def test_keeps_only_last_progress_token(self):
        self.assertEqual(Plugin._clean_terminal_output(PROGRESS), "100.00% 00:00:00")

    def test_plain_text_is_unchanged(self):
        self.assertEqual(Plugin._clean_terminal_output("Downloading...\nDone"), "Downloading...\nDone")

    def test_color_codes_are_stripped(self):
        self.assertEqual(Plugin._clean_terminal_output("\x1b[31merror\x1b[0m: boom"), "error: boom")

    def test_progress_frames_between_real_lines(self):
        raw = "Starting\n\r\x1b[K\r1.00% 5s\r\x1b[K\r2.00% 4s\nFinished\n"
        self.assertEqual(Plugin._clean_terminal_output(raw), "Starting\n2.00% 4s\nFinished")

    def test_empty_input(self):
        self.assertEqual(Plugin._clean_terminal_output(""), "")

    def test_other_control_characters_removed(self):
        self.assertEqual(Plugin._clean_terminal_output("a\x07b\x00c"), "abc")


class TestApplySteamosUpdate(unittest.TestCase):

    def test_success_returns_cleaned_stdout(self):
        p = make_plugin()
        fake = FakeExec().when("/usr/bin/steamos-update", stdout=PROGRESS)
        with patch("asyncio.create_subprocess_exec", fake):
            result = run(p.apply_steamos_update())
        self.assertTrue(result["success"])
        self.assertEqual(result["returncode"], 0)
        self.assertEqual(result["stdout"], "100.00% 00:00:00")

    def test_failure_is_reported(self):
        p = make_plugin()
        fake = FakeExec().when("/usr/bin/steamos-update", rc=1, stderr="error: no space left")
        with patch("asyncio.create_subprocess_exec", fake):
            result = run(p.apply_steamos_update())
        self.assertFalse(result["success"])
        self.assertEqual(result["returncode"], 1)
        self.assertIn("no space left", result["stderr"])

    def test_exception_is_reported(self):
        p = make_plugin()
        with patch("asyncio.create_subprocess_exec", AsyncMock(side_effect=OSError("missing"))):
            result = run(p.apply_steamos_update())
        self.assertFalse(result["success"])
        self.assertEqual(result["returncode"], -1)
        self.assertIn("missing", result["stderr"])

    def test_duplicate_call_joins_the_running_apply(self):
        p = make_plugin()
        fake = FakeExec(delay=0.05).when("/usr/bin/steamos-update", stdout=PROGRESS)

        async def scenario():
            first = asyncio.ensure_future(p.apply_steamos_update())
            await asyncio.sleep(0.01)
            second = await p.apply_steamos_update()
            return await first, second

        with patch("asyncio.create_subprocess_exec", fake):
            first, second = run(scenario())
        self.assertIs(first, second)
        self.assertTrue(second["success"])
        self.assertEqual(second["stdout"], "100.00% 00:00:00")
        self.assertEqual(len(fake.calls), 1)

    def test_joined_caller_sees_a_failure_not_a_fake_success(self):
        p = make_plugin()
        fake = FakeExec(delay=0.05).when("/usr/bin/steamos-update", rc=2, stderr="error: failed")

        async def scenario():
            first = asyncio.ensure_future(p.apply_steamos_update())
            await asyncio.sleep(0.01)
            second = await p.apply_steamos_update()
            return await first, second

        with patch("asyncio.create_subprocess_exec", fake):
            first, second = run(scenario())
        self.assertFalse(second["success"])
        self.assertEqual(second["returncode"], 2)

    def test_call_after_completion_runs_again(self):
        p = make_plugin()
        fake = FakeExec().when("/usr/bin/steamos-update", stdout="ok")
        with patch("asyncio.create_subprocess_exec", fake):
            run(p.apply_steamos_update())
            run(p.apply_steamos_update())
        self.assertEqual(len(fake.calls), 2)

    def test_cancelled_waiter_does_not_cancel_the_apply(self):
        p = make_plugin()
        fake = FakeExec(delay=0.05).when("/usr/bin/steamos-update", stdout="ok")

        async def scenario():
            first = asyncio.ensure_future(p.apply_steamos_update())
            await asyncio.sleep(0.01)
            first.cancel()
            return await p.apply_steamos_update()

        with patch("asyncio.create_subprocess_exec", fake):
            result = run(scenario())
        self.assertTrue(result["success"])
        self.assertEqual(len(fake.calls), 1)


class TestCheckSteamosUpdates(unittest.TestCase):

    def _check(self, rc, stdout="", stderr=""):
        p = make_plugin()
        proc = mock_process(stdout=stdout.encode(), stderr=stderr.encode(), returncode=rc)
        with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=proc)):
            return run(p.check_steamos_updates())

    def test_update_available(self):
        result = self._check(0, stdout="3.7.1\n")
        self.assertTrue(result["success"])
        self.assertTrue(result["hasUpdate"])
        self.assertEqual(result["buildId"], "3.7.1")

    def test_no_update(self):
        result = self._check(7)
        self.assertTrue(result["success"])
        self.assertFalse(result["hasUpdate"])

    def test_staged_update_needs_reboot(self):
        result = self._check(8)
        self.assertTrue(result["success"])
        self.assertTrue(result["needsReboot"])

    def test_failure(self):
        result = self._check(1, stderr="boom")
        self.assertFalse(result["success"])
        self.assertEqual(result["error"], "boom")


if __name__ == "__main__":
    unittest.main()
