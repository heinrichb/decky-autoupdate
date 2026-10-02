"""
Tests for Plugin._run_cmd: logging volume, decoding, stdin, timeout and cancellation.

Run with: python3 -m unittest tests.test_run_cmd -v
"""

import asyncio
import os
import signal
import sys
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _stub import decky_stub, mock_process, run  # noqa: E402

from main import Plugin  # noqa: E402


def make_plugin(debug=False):
    p = Plugin()
    p.settings = {"debugLogging": debug}
    return p


def hanging_process():
    proc = MagicMock()

    async def hang():
        await asyncio.sleep(30)

    proc.communicate = hang
    proc.wait = AsyncMock(return_value=-9)
    proc.returncode = None
    proc.pid = 4242
    return proc


def process_is_gone(pid):
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().rsplit(")", 1)[1].split()[0] == "Z"
    except (FileNotFoundError, ProcessLookupError):
        return True


class TestRunCmdLogging(unittest.TestCase):

    def setUp(self):
        decky_stub.logger.records.clear()

    def _run(self, p, proc, argv=("/usr/bin/echo", "hi"), **kwargs):
        with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=proc)):
            return run(p._run_cmd(list(argv), **kwargs))

    def test_success_logs_a_single_line_with_rc_and_elapsed(self):
        p = make_plugin()
        rc, out, err = self._run(p, mock_process(stdout=b"out", stderr=b"warning text", returncode=0))
        self.assertEqual((rc, out, err), (0, "out", "warning text"))
        messages = decky_stub.logger.messages()
        self.assertEqual(len(messages), 1)
        self.assertRegex(messages[0], r"^cmd rc=0 \d+ms: /usr/bin/echo hi$")

    def test_nonzero_exit_logs_stderr_and_stdout_snippets(self):
        p = make_plugin()
        self._run(p, mock_process(stdout=b"partial output", stderr=b"it broke", returncode=3))
        text = "\n".join(decky_stub.logger.messages())
        self.assertIn("cmd rc=3", text)
        self.assertIn("it broke", text)
        self.assertIn("partial output", text)

    def test_debug_logs_snippets_on_success(self):
        p = make_plugin(debug=True)
        self._run(p, mock_process(stdout=b"hello out", stderr=b"hello err", returncode=0))
        text = "\n".join(decky_stub.logger.messages())
        self.assertIn("hello out", text)
        self.assertIn("hello err", text)

    def test_no_boilerplate_lines_even_in_debug(self):
        p = make_plugin(debug=True)
        self._run(p, mock_process(stdout=b"x", returncode=0), timeout=5, env={"PATH": "/usr/bin"})
        text = "\n".join(decky_stub.logger.messages())
        for noise in ("Running:", "Completed (rc", "Process started", "timeout=", "env="):
            self.assertNotIn(noise, text)

    def test_end_of_life_info_lines_are_not_logged(self):
        p = make_plugin(debug=True)
        stdout = (
            b"Info: org.kde.Platform//6.8 is end-of-life, with reason: We strongly recommend moving\n"
            b"Installing org.example.App\n"
        )
        rc, out, _ = self._run(p, mock_process(stdout=stdout, returncode=0))
        text = "\n".join(decky_stub.logger.messages())
        self.assertNotIn("end-of-life", text)
        self.assertIn("Installing org.example.App", text)
        self.assertIn("end-of-life", out)


    def test_terminal_progress_is_cleaned_in_logged_snippets(self):
        p = make_plugin(debug=True)
        stdout = b"\r\x1b[K\r0.00% 00:00:10\r\x1b[K\r75.00% 00:00:02\n"
        rc, out, _ = self._run(p, mock_process(stdout=stdout, returncode=0))
        text = "\n".join(decky_stub.logger.messages())
        self.assertIn("75.00% 00:00:02", text)
        self.assertNotIn("\x1b", text)
        self.assertNotIn("0.00% 00:00:10", text)
        self.assertIn("\x1b[K", out)


class TestRunCmdProcess(unittest.TestCase):

    def test_invalid_utf8_is_replaced_not_raised(self):
        p = make_plugin()
        proc = mock_process(stdout=b"ok\xff\xfe", stderr=b"bad\xc3", returncode=0)
        with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=proc)):
            rc, out, err = run(p._run_cmd(["/usr/bin/true"]))
        self.assertEqual(rc, 0)
        self.assertTrue(out.startswith("ok"))
        self.assertIn("�", out)
        self.assertIn("�", err)

    def test_stdin_is_closed(self):
        p = make_plugin()
        mock_exec = AsyncMock(return_value=mock_process())
        with patch("asyncio.create_subprocess_exec", mock_exec):
            run(p._run_cmd(["/usr/bin/true"]))
        self.assertEqual(mock_exec.call_args.kwargs["stdin"], asyncio.subprocess.DEVNULL)

    def test_child_starts_in_its_own_session(self):
        p = make_plugin()
        mock_exec = AsyncMock(return_value=mock_process())
        with patch("asyncio.create_subprocess_exec", mock_exec):
            run(p._run_cmd(["/usr/bin/true"]))
        self.assertIs(mock_exec.call_args.kwargs["start_new_session"], True)

    def test_default_env_is_minimal(self):
        p = make_plugin()
        mock_exec = AsyncMock(return_value=mock_process())
        with patch("asyncio.create_subprocess_exec", mock_exec):
            run(p._run_cmd(["/usr/bin/true"]))
        env = mock_exec.call_args.kwargs["env"]
        self.assertIn("PATH", env)
        self.assertNotIn("LD_LIBRARY_PATH", env)

    def test_timeout_kills_the_process_group_and_reports(self):
        p = make_plugin()
        proc = hanging_process()
        with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=proc)), patch("os.killpg") as killpg:
            rc, out, err = run(p._run_cmd(["/usr/bin/sleep", "30"], timeout=0.05))
        self.assertEqual(rc, -1)
        self.assertEqual(out, "")
        self.assertIn("timed out", err)
        killpg.assert_called_once_with(4242, signal.SIGKILL)
        proc.kill.assert_not_called()

    def test_cancellation_kills_the_process_group_and_propagates(self):
        p = make_plugin()
        proc = hanging_process()

        async def scenario():
            task = asyncio.ensure_future(p._run_cmd(["/usr/bin/sleep", "30"], timeout=30))
            await asyncio.sleep(0.05)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

        with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=proc)), patch("os.killpg") as killpg:
            run(scenario())
        killpg.assert_called_once_with(4242, signal.SIGKILL)
        proc.kill.assert_not_called()

    def test_kill_falls_back_to_the_single_process_when_the_group_is_unreachable(self):
        for error in (ProcessLookupError(), PermissionError()):
            p = make_plugin()
            proc = hanging_process()
            with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=proc)), patch(
                "os.killpg", side_effect=error
            ):
                rc, _, err = run(p._run_cmd(["/usr/bin/sleep", "30"], timeout=0.05))
            self.assertEqual(rc, -1, error)
            self.assertIn("timed out", err)
            proc.kill.assert_called_once()

    def test_kill_fallback_tolerates_an_already_gone_process(self):
        p = make_plugin()
        proc = hanging_process()
        proc.kill.side_effect = ProcessLookupError()
        with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=proc)), patch(
            "os.killpg", side_effect=ProcessLookupError()
        ):
            rc, _, _ = run(p._run_cmd(["/usr/bin/sleep", "30"], timeout=0.05))
        self.assertEqual(rc, -1)

    def test_finished_process_is_not_killed(self):
        proc = mock_process(returncode=0)
        with patch("os.killpg") as killpg:
            Plugin._kill_process(proc)
        killpg.assert_not_called()
        proc.kill.assert_not_called()


@unittest.skipUnless(os.path.exists("/bin/sh") and sys.platform.startswith("linux"), "needs /bin/sh on Linux")
class TestRunCmdRealProcessGroup(unittest.TestCase):

    def test_cancel_kills_a_grandchild_that_a_wrapper_would_orphan(self):
        p = make_plugin()
        with tempfile.TemporaryDirectory() as tmp:
            pidfile = os.path.join(tmp, "pid")

            async def scenario():
                task = asyncio.ensure_future(
                    p._run_cmd(["/bin/sh", "-c", f"sleep 30 & echo $! > {pidfile}; wait"], timeout=30)
                )
                grandchild = None
                while grandchild is None:
                    await asyncio.sleep(0.02)
                    try:
                        with open(pidfile) as f:
                            grandchild = int(f.read().strip() or 0) or None
                    except (FileNotFoundError, ValueError):
                        pass
                self.addCleanup(self._reap, grandchild)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                deadline = time.monotonic() + 5
                while not process_is_gone(grandchild) and time.monotonic() < deadline:
                    await asyncio.sleep(0.02)
                await asyncio.sleep(0.1)
                return grandchild

            grandchild = run(asyncio.wait_for(scenario(), 10))
            self.assertTrue(process_is_gone(grandchild))

    @staticmethod
    def _reap(pid):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


if __name__ == "__main__":
    unittest.main()
