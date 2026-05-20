"""
Tests for flatpak-related backend logic.

Covers:
- _minimal_env and _deck_env environment construction
- _detect_flatpak_scopes (multi-scope detection)
- _run_flatpak command routing based on scope
- check_flatpak_updates output parsing (various formats, both scopes)
- apply_flatpak_updates result handling (both scopes)

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
        self.assertIn("XDG_DATA_DIRS", env)

    def test_xdg_data_dirs_includes_flatpak_exports(self):
        env = Plugin._deck_env()
        self.assertIn("flatpak/exports/share", env["XDG_DATA_DIRS"])

    def test_excludes_steam_runtime_vars(self):
        with patch.dict(os.environ, {"LD_LIBRARY_PATH": "/foo", "STEAM_RUNTIME": "/bar"}):
            env = Plugin._deck_env()
            self.assertNotIn("LD_LIBRARY_PATH", env)
            self.assertNotIn("STEAM_RUNTIME", env)


class TestDetectFlatpakScopes(unittest.TestCase):

    def _run_detect(self, user_stdout="", user_rc=0, system_stdout="", system_rc=0):
        """Run scope detection with mocked subprocess results."""
        p = Plugin()
        p._flatpak_scopes = None

        def make_process(*args, **kwargs):
            argv = list(args)
            if any("runuser" in str(a) for a in argv):
                return mock_process(stdout=user_stdout.encode(), returncode=user_rc)
            else:
                return mock_process(stdout=system_stdout.encode(), returncode=system_rc)

        mock_exec = AsyncMock(side_effect=make_process)
        with patch("asyncio.create_subprocess_exec", mock_exec):
            return run(p._detect_flatpak_scopes()), p

    def test_both_scopes_when_both_have_apps(self):
        user_apps = "com.spotify.Client\norg.mozilla.firefox"
        system_apps = "com.example.App"
        scopes, _ = self._run_detect(user_stdout=user_apps, system_stdout=system_apps)
        self.assertIn("user", scopes)
        self.assertIn("system", scopes)

    def test_user_only_when_no_system_apps(self):
        user_apps = "com.spotify.Client"
        scopes, _ = self._run_detect(user_stdout=user_apps, system_stdout="")
        self.assertEqual(scopes, ["user"])

    def test_system_only_when_no_user_apps(self):
        system_apps = "com.spotify.Client\norg.mozilla.firefox"
        scopes, _ = self._run_detect(user_stdout="", system_stdout=system_apps)
        self.assertEqual(scopes, ["system"])

    def test_caches_result(self):
        user_apps = "com.spotify.Client"
        _, p = self._run_detect(user_stdout=user_apps)
        self.assertEqual(p._flatpak_scopes, ["user"])

    def test_user_check_failure_falls_back_to_system(self):
        system_apps = "com.spotify.Client"
        scopes, _ = self._run_detect(user_rc=1, system_stdout=system_apps)
        self.assertEqual(scopes, ["system"])

    def test_both_empty_defaults_to_user(self):
        scopes, _ = self._run_detect()
        self.assertEqual(scopes, ["user"])


class TestRunFlatpak(unittest.TestCase):

    def test_user_scope_uses_runuser(self):
        """User scope runs via runuser -u deck with --user flag."""
        p = Plugin()
        p._flatpak_scopes = ["user"]
        proc = mock_process(stdout=b"output", returncode=0)
        mock_exec = AsyncMock(return_value=proc)
        with patch("asyncio.create_subprocess_exec", mock_exec):
            rc, stdout, stderr = run(p._run_flatpak("user", ["remote-ls", "--updates"]))

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
        p._flatpak_scopes = ["system"]
        proc = mock_process(stdout=b"output", returncode=0)
        mock_exec = AsyncMock(return_value=proc)
        with patch("asyncio.create_subprocess_exec", mock_exec):
            rc, stdout, stderr = run(p._run_flatpak("system", ["remote-ls", "--updates"]))

        argv = list(mock_exec.call_args[0])
        self.assertEqual(argv[0], "/usr/bin/flatpak")
        self.assertIn("--system", argv)
        self.assertNotIn("runuser", argv)

    def test_user_scope_uses_deck_env(self):
        """User scope passes deck_env (with HOME) to subprocess."""
        p = Plugin()
        proc = mock_process(returncode=0)
        mock_exec = AsyncMock(return_value=proc)
        with patch("asyncio.create_subprocess_exec", mock_exec):
            run(p._run_flatpak("user", ["list"]))

        env = mock_exec.call_args.kwargs["env"]
        self.assertIn("HOME", env)
        self.assertIn("PATH", env)
        self.assertNotIn("LD_LIBRARY_PATH", env)

    def test_system_scope_uses_minimal_env(self):
        """System scope passes minimal env (no HOME) to subprocess."""
        p = Plugin()
        proc = mock_process(returncode=0)
        mock_exec = AsyncMock(return_value=proc)
        with patch("asyncio.create_subprocess_exec", mock_exec):
            run(p._run_flatpak("system", ["list"]))

        env = mock_exec.call_args.kwargs["env"]
        self.assertNotIn("HOME", env)
        self.assertIn("PATH", env)
        self.assertNotIn("LD_LIBRARY_PATH", env)


class TestCheckFlatpakUpdates(unittest.TestCase):

    def _run_check(self, stdout_text, stderr_text="", returncode=0, scopes=None):
        p = Plugin()
        p._flatpak_scopes = scopes or ["user"]
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

    def test_updates_include_scope(self):
        """Each update record should include the scope it came from."""
        stdout = "com.spotify.Client\tSpotify\t50 MB"
        result = self._run_check(stdout, scopes=["system"])
        self.assertEqual(result["updates"][0]["scope"], "system")

    def test_both_scopes_combined(self):
        """Updates from both scopes are merged into a single list."""
        p = Plugin()
        p._flatpak_scopes = ["user", "system"]

        call_count = [0]
        def make_process(*args, **kwargs):
            call_count[0] += 1
            if any("runuser" in str(a) for a in args):
                return mock_process(stdout=b"com.discord.Discord\tDiscord\t100 MB", returncode=0)
            else:
                return mock_process(stdout=b"org.gtk.Gtk3theme.Breeze\tBreeze GTK theme\t192.5 kB", returncode=0)

        mock_exec = AsyncMock(side_effect=make_process)
        with patch("asyncio.create_subprocess_exec", mock_exec):
            result = run(p.check_flatpak_updates())

        self.assertTrue(result["success"])
        self.assertEqual(len(result["updates"]), 2)
        ids = [u["id"] for u in result["updates"]]
        self.assertIn("com.discord.Discord", ids)
        self.assertIn("org.gtk.Gtk3theme.Breeze", ids)

    def test_subprocess_exception(self):
        """If subprocess exec throws, returns error result."""
        p = Plugin()
        p._flatpak_scopes = ["user"]
        with patch("asyncio.create_subprocess_exec", AsyncMock(side_effect=OSError("no flatpak"))):
            result = run(p.check_flatpak_updates())
        self.assertFalse(result["success"])
        self.assertIn("no flatpak", result["error"])

    def test_check_passes_clean_env(self):
        """create_subprocess_exec must receive a clean env to avoid Steam runtime pollution."""
        p = Plugin()
        p._flatpak_scopes = ["user"]
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

    def _run_apply(self, stdout_text="", stderr_text="", returncode=0, scopes=None):
        p = Plugin()
        p._flatpak_scopes = scopes or ["user"]
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

    def test_apply_both_scopes(self):
        """Apply runs against all active scopes."""
        p = Plugin()
        p._flatpak_scopes = ["user", "system"]

        def make_process(*args, **kwargs):
            return mock_process(stdout=b"Done.", returncode=0)

        mock_exec = AsyncMock(side_effect=make_process)
        with patch("asyncio.create_subprocess_exec", mock_exec):
            result = run(p.apply_flatpak_updates())

        self.assertTrue(result["success"])
        self.assertEqual(result["returncode"], 0)
        calls = mock_exec.call_args_list
        all_argv = [list(c[0]) for c in calls]
        has_user = any("--user" in argv for argv in all_argv)
        has_system = any("--system" in argv for argv in all_argv)
        self.assertTrue(has_user)
        self.assertTrue(has_system)

    def test_subprocess_exception(self):
        p = Plugin()
        p._flatpak_scopes = ["user"]
        with patch("asyncio.create_subprocess_exec", AsyncMock(side_effect=OSError("crash"))):
            result = run(p.apply_flatpak_updates())
        self.assertFalse(result["success"])
        self.assertEqual(result["returncode"], -1)
        self.assertIn("crash", result["stderr"])


class TestCheckAndApplyFlatpak(unittest.TestCase):

    def test_check_only_no_apply(self):
        """When auto_apply is False, only check - don't apply."""
        p = Plugin()
        p._flatpak_scopes = ["system"]
        proc = mock_process(
            stdout=b"org.gtk.Gtk3theme.Breeze\tBreeze GTK theme\t192.5 kB",
            returncode=0,
        )
        mock_exec = AsyncMock(return_value=proc)
        with patch("asyncio.create_subprocess_exec", mock_exec):
            result = run(p.check_and_apply_flatpak(False))

        self.assertTrue(result["success"])
        self.assertEqual(len(result["updates"]), 1)
        self.assertFalse(result["applied"])
        # Should NOT have called flatpak update without --appstream (only check commands)
        all_argv = [list(c[0]) for c in mock_exec.call_args_list]
        self.assertFalse(
            any("update" in argv and "--noninteractive" in argv and "--appstream" not in argv
                for argv in all_argv)
        )

    def test_auto_apply_runs_update(self):
        """When auto_apply is True and updates exist, applies them."""
        p = Plugin()
        p._flatpak_scopes = ["user"]
        proc = mock_process(
            stdout=b"com.discord.Discord\tDiscord\t100 MB",
            returncode=0,
        )
        mock_exec = AsyncMock(return_value=proc)
        with patch("asyncio.create_subprocess_exec", mock_exec):
            result = run(p.check_and_apply_flatpak(True))

        self.assertTrue(result["success"])
        self.assertTrue(result["applied"])
        self.assertEqual(len(result["updates"]), 1)

    def test_no_updates_skips_apply(self):
        """When no updates found, applied is False even with auto_apply=True."""
        p = Plugin()
        p._flatpak_scopes = ["user"]
        proc = mock_process(stdout=b"", returncode=0)
        with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=proc)):
            result = run(p.check_and_apply_flatpak(True))

        self.assertTrue(result["success"])
        self.assertFalse(result["applied"])
        self.assertEqual(result["updates"], [])

    def test_check_failure_skips_apply(self):
        """When check fails, don't attempt apply."""
        p = Plugin()
        p._flatpak_scopes = ["user"]
        proc = mock_process(stdout=b"", stderr=b"error", returncode=1)
        mock_exec = AsyncMock(return_value=proc)
        with patch("asyncio.create_subprocess_exec", mock_exec):
            result = run(p.check_and_apply_flatpak(True))

        self.assertFalse(result["success"])
        self.assertFalse(result["applied"])


if __name__ == "__main__":
    unittest.main()
