"""
Tests for flatpak-related backend logic.

Covers:
- _minimal_env and _deck_env environment construction
- _detect_flatpak_scope (user vs system detection)
- _run_flatpak command routing based on scope
- check_flatpak_updates output parsing (various formats)
- apply_flatpak_updates result handling

Run with: python3 -m unittest tests.test_flatpak -v
"""

import sys
import os
import types
import asyncio
import unittest
from unittest.mock import AsyncMock, patch, MagicMock

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
    return asyncio.get_event_loop().run_until_complete(coro)


def mock_process(stdout=b"", stderr=b"", returncode=0):
    """Create a mock subprocess result."""
    proc = MagicMock()
    proc.communicate = AsyncMock(return_value=(stdout, stderr))
    proc.returncode = returncode
    return proc


class TestMinimalEnv(unittest.TestCase):

    def test_excludes_steam_runtime_vars(self):
        with patch.dict(os.environ, {"LD_LIBRARY_PATH": "/foo", "STEAM_RUNTIME": "/bar", "LANG": "en_US.UTF-8"}):
            env = Plugin._minimal_env()
            self.assertNotIn("LD_LIBRARY_PATH", env)
            self.assertNotIn("STEAM_RUNTIME", env)
            self.assertNotIn("LD_PRELOAD", env)

    def test_includes_essential_vars(self):
        with patch.dict(os.environ, {"LANG": "en_US.UTF-8"}):
            env = Plugin._minimal_env()
            self.assertIn("PATH", env)
            self.assertIn("XDG_RUNTIME_DIR", env)
            self.assertIn("LANG", env)

    def test_xdg_runtime_dir_uses_deck_uid(self):
        env = Plugin._minimal_env()
        self.assertRegex(env["XDG_RUNTIME_DIR"], r"/run/user/\d+")

    def test_does_not_mutate_real_env(self):
        with patch.dict(os.environ, {"LD_LIBRARY_PATH": "/foo"}):
            Plugin._minimal_env()
            self.assertEqual(os.environ["LD_LIBRARY_PATH"], "/foo")


class TestDeckEnv(unittest.TestCase):

    def test_includes_home(self):
        env = Plugin._deck_env()
        self.assertIn("HOME", env)

    def test_includes_essential_vars(self):
        env = Plugin._deck_env()
        self.assertIn("PATH", env)
        self.assertIn("XDG_RUNTIME_DIR", env)
        self.assertIn("LANG", env)

    def test_excludes_steam_runtime_vars(self):
        with patch.dict(os.environ, {"LD_LIBRARY_PATH": "/foo", "STEAM_RUNTIME": "/bar"}):
            env = Plugin._deck_env()
            self.assertNotIn("LD_LIBRARY_PATH", env)
            self.assertNotIn("STEAM_RUNTIME", env)


class TestDetectFlatpakScope(unittest.TestCase):

    def _run_detect(self, user_stdout="", user_rc=0, system_stdout="", system_rc=0):
        """Run scope detection with mocked subprocess results."""
        p = Plugin()
        p._flatpak_scope = None  # Reset cached scope

        call_count = [0]
        def make_process(*args, **kwargs):
            call_count[0] += 1
            argv = list(args)
            # First call is user-level (runuser), second is system-level
            if any("runuser" in str(a) for a in argv):
                return mock_process(stdout=user_stdout.encode(), returncode=user_rc)
            else:
                return mock_process(stdout=system_stdout.encode(), returncode=system_rc)

        mock_exec = AsyncMock(side_effect=make_process)
        with patch("asyncio.create_subprocess_exec", mock_exec):
            return run(p._detect_flatpak_scope()), p

    def test_user_scope_when_more_user_apps(self):
        user_apps = "com.spotify.Client\norg.mozilla.firefox\ncom.discord.Discord"
        system_apps = "com.example.App"
        scope, _ = self._run_detect(user_stdout=user_apps, system_stdout=system_apps)
        self.assertEqual(scope, "user")

    def test_system_scope_when_more_system_apps(self):
        user_apps = ""
        system_apps = "com.spotify.Client\norg.mozilla.firefox\ncom.discord.Discord"
        scope, _ = self._run_detect(user_stdout=user_apps, system_stdout=system_apps)
        self.assertEqual(scope, "system")

    def test_user_scope_when_equal(self):
        """When equal, prefer user scope (common case on SteamOS)."""
        apps = "com.spotify.Client\norg.mozilla.firefox"
        scope, _ = self._run_detect(user_stdout=apps, system_stdout=apps)
        self.assertEqual(scope, "user")

    def test_caches_result(self):
        user_apps = "com.spotify.Client"
        scope1, p = self._run_detect(user_stdout=user_apps)
        self.assertEqual(scope1, "user")
        # Second call should use cached value
        self.assertEqual(p._flatpak_scope, "user")

    def test_user_check_failure_falls_back_to_system(self):
        system_apps = "com.spotify.Client"
        scope, _ = self._run_detect(user_rc=1, system_stdout=system_apps)
        self.assertEqual(scope, "system")

    def test_both_empty_defaults_to_user(self):
        scope, _ = self._run_detect()
        self.assertEqual(scope, "user")


class TestRunFlatpak(unittest.TestCase):

    def test_user_scope_uses_runuser(self):
        """User scope runs via runuser -u deck with --user flag."""
        p = Plugin()
        p._flatpak_scope = "user"
        proc = mock_process(stdout=b"output", returncode=0)
        mock_exec = AsyncMock(return_value=proc)
        with patch("asyncio.create_subprocess_exec", mock_exec):
            rc, stdout, stderr = run(p._run_flatpak(["remote-ls", "--updates"]))

        argv = list(mock_exec.call_args[0])
        self.assertEqual(argv[0], "/usr/bin/runuser")
        self.assertIn("-u", argv)
        self.assertIn("deck", argv)
        self.assertIn("--user", argv)
        self.assertIn("remote-ls", argv)
        self.assertIn("--updates", argv)

    def test_system_scope_runs_directly(self):
        """System scope runs flatpak directly with --system flag."""
        p = Plugin()
        p._flatpak_scope = "system"
        proc = mock_process(stdout=b"output", returncode=0)
        mock_exec = AsyncMock(return_value=proc)
        with patch("asyncio.create_subprocess_exec", mock_exec):
            rc, stdout, stderr = run(p._run_flatpak(["remote-ls", "--updates"]))

        argv = list(mock_exec.call_args[0])
        self.assertEqual(argv[0], "/usr/bin/flatpak")
        self.assertIn("--system", argv)
        self.assertNotIn("runuser", argv)

    def test_user_scope_uses_deck_env(self):
        """User scope passes deck_env (with HOME) to subprocess."""
        p = Plugin()
        p._flatpak_scope = "user"
        proc = mock_process(returncode=0)
        mock_exec = AsyncMock(return_value=proc)
        with patch("asyncio.create_subprocess_exec", mock_exec):
            run(p._run_flatpak(["list"]))

        env = mock_exec.call_args.kwargs["env"]
        self.assertIn("HOME", env)
        self.assertIn("PATH", env)
        self.assertNotIn("LD_LIBRARY_PATH", env)

    def test_system_scope_uses_minimal_env(self):
        """System scope passes minimal env (no HOME) to subprocess."""
        p = Plugin()
        p._flatpak_scope = "system"
        proc = mock_process(returncode=0)
        mock_exec = AsyncMock(return_value=proc)
        with patch("asyncio.create_subprocess_exec", mock_exec):
            run(p._run_flatpak(["list"]))

        env = mock_exec.call_args.kwargs["env"]
        self.assertNotIn("HOME", env)
        self.assertIn("PATH", env)
        self.assertNotIn("LD_LIBRARY_PATH", env)


class TestCheckFlatpakUpdates(unittest.TestCase):

    def _run_check(self, stdout_text, stderr_text="", returncode=0, scope="user"):
        p = Plugin()
        p._flatpak_scope = scope
        proc = mock_process(
            stdout=stdout_text.encode(),
            stderr=stderr_text.encode(),
            returncode=returncode,
        )
        with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=proc)):
            return run(p.check_flatpak_updates())

    def test_three_column_output(self):
        """Standard 3-column tab-separated output."""
        stdout = "com.spotify.Client\tSpotify\t50.2 MB\norg.mozilla.firefox\tFirefox\t120.5 MB"
        result = self._run_check(stdout)
        self.assertTrue(result["success"])
        self.assertEqual(len(result["updates"]), 2)
        self.assertEqual(result["updates"][0]["id"], "com.spotify.Client")
        self.assertEqual(result["updates"][0]["name"], "Spotify")
        self.assertEqual(result["updates"][0]["downloadSize"], "50.2 MB")
        self.assertEqual(result["updates"][1]["id"], "org.mozilla.firefox")

    def test_two_column_output(self):
        """Some flatpak versions omit download size."""
        stdout = "com.spotify.Client\tSpotify"
        result = self._run_check(stdout)
        self.assertTrue(result["success"])
        self.assertEqual(len(result["updates"]), 1)
        self.assertEqual(result["updates"][0]["downloadSize"], "")

    def test_empty_output_no_updates(self):
        """Empty stdout means no updates available."""
        result = self._run_check("")
        self.assertTrue(result["success"])
        self.assertEqual(result["updates"], [])

    def test_single_column_line_ignored(self):
        """A line with only one column (no tab) should be ignored."""
        stdout = "com.spotify.Client"
        result = self._run_check(stdout)
        self.assertTrue(result["success"])
        self.assertEqual(result["updates"], [])

    def test_mixed_valid_and_invalid_lines(self):
        """Valid lines parsed, invalid lines skipped."""
        stdout = "com.spotify.Client\tSpotify\t50 MB\nbadline\norg.mozilla.firefox\tFirefox"
        result = self._run_check(stdout)
        self.assertTrue(result["success"])
        self.assertEqual(len(result["updates"]), 2)

    def test_whitespace_stripped(self):
        """Whitespace around columns should be stripped."""
        stdout = "  com.spotify.Client \t  Spotify  \t  50 MB  "
        result = self._run_check(stdout)
        self.assertEqual(result["updates"][0]["id"], "com.spotify.Client")
        self.assertEqual(result["updates"][0]["name"], "Spotify")
        self.assertEqual(result["updates"][0]["downloadSize"], "50 MB")

    def test_subprocess_exception(self):
        """If subprocess exec throws, returns error result."""
        p = Plugin()
        p._flatpak_scope = "user"
        with patch("asyncio.create_subprocess_exec", AsyncMock(side_effect=OSError("no flatpak"))):
            result = run(p.check_flatpak_updates())
        self.assertFalse(result["success"])
        self.assertIn("no flatpak", result["error"])

    def test_check_passes_clean_env(self):
        """create_subprocess_exec must receive a clean env to avoid Steam runtime pollution."""
        p = Plugin()
        p._flatpak_scope = "user"
        proc = mock_process(stdout=b"", stderr=b"", returncode=0)
        mock_exec = AsyncMock(return_value=proc)
        with patch("asyncio.create_subprocess_exec", mock_exec):
            run(p.check_flatpak_updates())
        for call in mock_exec.call_args_list:
            self.assertIn("env", call.kwargs)
            env = call.kwargs["env"]
            self.assertNotIn("LD_LIBRARY_PATH", env)
            self.assertNotIn("STEAM_RUNTIME", env)
            self.assertIn("PATH", env)
            self.assertIn("XDG_RUNTIME_DIR", env)

    def test_nonzero_return_code(self):
        """Non-zero return code reports failure with stderr."""
        result = self._run_check("", stderr_text="error: no remotes", returncode=1)
        self.assertFalse(result["success"])
        self.assertIn("no remotes", result["error"])


class TestApplyFlatpakUpdates(unittest.TestCase):

    def _run_apply(self, stdout_text="", stderr_text="", returncode=0, scope="user"):
        p = Plugin()
        p._flatpak_scope = scope
        proc = mock_process(
            stdout=stdout_text.encode(),
            stderr=stderr_text.encode(),
            returncode=returncode,
        )
        with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=proc)):
            return run(p.apply_flatpak_updates())

    def test_successful_apply(self):
        result = self._run_apply(stdout_text="Nothing to do.", returncode=0)
        self.assertTrue(result["success"])
        self.assertEqual(result["returncode"], 0)

    def test_failed_apply(self):
        result = self._run_apply(stderr_text="error: permission denied", returncode=1)
        self.assertFalse(result["success"])
        self.assertEqual(result["returncode"], 1)
        self.assertIn("permission denied", result["stderr"])

    def test_subprocess_exception(self):
        p = Plugin()
        p._flatpak_scope = "user"
        with patch("asyncio.create_subprocess_exec", AsyncMock(side_effect=OSError("crash"))):
            result = run(p.apply_flatpak_updates())
        self.assertFalse(result["success"])
        self.assertEqual(result["returncode"], -1)
        self.assertIn("crash", result["stderr"])


if __name__ == "__main__":
    unittest.main()
