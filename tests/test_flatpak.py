"""
Tests for flatpak-related backend logic.

Covers:
- _minimal_env and _deck_env environment construction
- _detect_flatpak_scopes (multi-scope detection, cache only on clean probes)
- _run_flatpak command routing based on scope
- mask pattern parsing and matching
- check_flatpak_updates parsing, name lookup, mask filtering, offline errors
- apply_flatpak_updates per-scope results and commit verification
- check_and_apply_flatpak single-flight, apply gating and stuck-ref memory

Run with: python3 -m unittest tests.test_flatpak -v
"""

import asyncio
import os
import sys
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _stub import FakeExec, decky_stub, mock_process, run  # noqa: E402

from main import Plugin  # noqa: E402

REMOTE_LS_COLUMNS = "--columns=ref,commit,origin,download-size"
LIST_NAMES_COLUMNS = "--columns=ref,name,active"
LIST_SNAPSHOT_COLUMNS = "--columns=ref,active"

DISCORD = "com.discord.Discord/x86_64/stable"
SPOTIFY = "com.spotify.Client/x86_64/stable"
BREEZE = "org.gtk.Gtk3theme.Breeze/x86_64/3.22"
GEFORCE = "com.nvidia.geforcenow/x86_64/master"


def remote_ls(*entries):
    """Build remote-ls output from (ref, commit[, size]) tuples; refs get the app/ prefix unless they already have a kind."""
    lines = []
    for entry in entries:
        ref, commit = entry[0], entry[1]
        size = entry[2] if len(entry) > 2 else "10.0 MB"
        if not ref.startswith(("app/", "runtime/")):
            ref = "app/" + ref
        lines.append(f"{ref}\t{commit}\tflathub\t{size}")
    return "\n".join(lines)


def installed(*entries):
    """Build `flatpak list` output from (ref, active) or (ref, name, active) tuples."""
    return "\n".join("\t".join(entry) for entry in entries)


def make_plugin(scopes=("user",)):
    p = Plugin()
    p._flatpak_scopes = list(scopes)
    p.settings = {}
    return p


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

    def _fake(self, user_stdout="", user_rc=0, system_stdout="", system_rc=0):
        fake = FakeExec()
        fake.when("/usr/bin/runuser", stdout=user_stdout, rc=user_rc)
        fake.when("--system", stdout=system_stdout, rc=system_rc)
        return fake

    def _run_detect(self, **kwargs):
        p = Plugin()
        p._flatpak_scopes = None
        p.settings = {}
        with patch("asyncio.create_subprocess_exec", self._fake(**kwargs)):
            return run(p._detect_flatpak_scopes()), p

    def test_both_scopes_when_both_have_apps(self):
        scopes, _ = self._run_detect(user_stdout="com.spotify.Client\norg.mozilla.firefox", system_stdout="com.example.App")
        self.assertEqual(scopes, ["user", "system"])

    def test_user_only_when_no_system_apps(self):
        scopes, _ = self._run_detect(user_stdout="com.spotify.Client")
        self.assertEqual(scopes, ["user"])

    def test_system_only_when_no_user_apps(self):
        scopes, _ = self._run_detect(system_stdout="com.spotify.Client\norg.mozilla.firefox")
        self.assertEqual(scopes, ["system"])

    def test_caches_result_after_clean_probes(self):
        _, p = self._run_detect(user_stdout="com.spotify.Client")
        self.assertEqual(p._flatpak_scopes, ["user"])

    def test_cached_result_skips_probes(self):
        p = Plugin()
        p.settings = {}
        p._flatpak_scopes = ["system"]
        fake = self._fake(user_stdout="com.spotify.Client")
        with patch("asyncio.create_subprocess_exec", fake):
            scopes = run(p._detect_flatpak_scopes())
        self.assertEqual(scopes, ["system"])
        self.assertEqual(fake.calls, [])

    def test_failed_probe_falls_back_to_other_scope_without_caching(self):
        scopes, p = self._run_detect(user_rc=1, system_stdout="com.spotify.Client")
        self.assertEqual(scopes, ["system"])
        self.assertIsNone(p._flatpak_scopes)

    def test_failed_system_probe_is_not_cached(self):
        scopes, p = self._run_detect(user_stdout="com.spotify.Client", system_rc=1)
        self.assertEqual(scopes, ["user"])
        self.assertIsNone(p._flatpak_scopes)

    def test_redetects_after_failed_probe(self):
        scopes, p = self._run_detect(user_rc=1, system_stdout="com.spotify.Client")
        self.assertEqual(scopes, ["system"])
        with patch("asyncio.create_subprocess_exec", self._fake(user_stdout="com.a", system_stdout="com.b")):
            scopes = run(p._detect_flatpak_scopes())
        self.assertEqual(scopes, ["user", "system"])
        self.assertEqual(p._flatpak_scopes, ["user", "system"])

    def test_both_empty_defaults_to_user(self):
        scopes, p = self._run_detect()
        self.assertEqual(scopes, ["user"])
        self.assertEqual(p._flatpak_scopes, ["user"])


class TestRunFlatpak(unittest.TestCase):

    def test_user_scope_uses_runuser(self):
        p = make_plugin(["user"])
        mock_exec = AsyncMock(return_value=mock_process(stdout=b"output"))
        with patch("asyncio.create_subprocess_exec", mock_exec):
            run(p._run_flatpak("user", ["remote-ls", "--updates"]))

        argv = list(mock_exec.call_args[0])
        self.assertEqual(argv[0], "/usr/bin/runuser")
        self.assertIn("-u", argv)
        self.assertIn("deck", argv)
        self.assertIn("--user", argv)
        self.assertIn("remote-ls", argv)
        self.assertIn("--updates", argv)

    def test_system_scope_runs_directly(self):
        p = make_plugin(["system"])
        mock_exec = AsyncMock(return_value=mock_process(stdout=b"output"))
        with patch("asyncio.create_subprocess_exec", mock_exec):
            run(p._run_flatpak("system", ["remote-ls", "--updates"]))

        argv = list(mock_exec.call_args[0])
        self.assertEqual(argv[0], "/usr/bin/flatpak")
        self.assertIn("--system", argv)
        self.assertNotIn("runuser", argv)

    def test_user_scope_uses_deck_env(self):
        p = make_plugin(["user"])
        mock_exec = AsyncMock(return_value=mock_process())
        with patch("asyncio.create_subprocess_exec", mock_exec):
            run(p._run_flatpak("user", ["list"]))

        env = mock_exec.call_args.kwargs["env"]
        self.assertIn("HOME", env)
        self.assertIn("PATH", env)
        self.assertNotIn("LD_LIBRARY_PATH", env)

    def test_system_scope_uses_minimal_env(self):
        p = make_plugin(["system"])
        mock_exec = AsyncMock(return_value=mock_process())
        with patch("asyncio.create_subprocess_exec", mock_exec):
            run(p._run_flatpak("system", ["list"]))

        env = mock_exec.call_args.kwargs["env"]
        self.assertNotIn("HOME", env)
        self.assertIn("PATH", env)
        self.assertNotIn("LD_LIBRARY_PATH", env)


class TestMaskPatterns(unittest.TestCase):

    def test_parses_one_pattern_per_line(self):
        self.assertEqual(
            Plugin._parse_mask_patterns("  com.nvidia.geforcenow\n  org.example.*\n"),
            ["com.nvidia.geforcenow", "org.example.*"],
        )

    def test_ignores_blank_and_header_lines(self):
        out = "Masked patterns:\n\n  com.a.B\nNo masked patterns\n"
        self.assertEqual(Plugin._parse_mask_patterns(out), ["com.a.B"])

    def test_empty_output(self):
        self.assertEqual(Plugin._parse_mask_patterns(""), [])

    def test_matches_application_id(self):
        self.assertTrue(Plugin._is_masked("app/com.nvidia.geforcenow/x86_64/master", ["com.nvidia.geforcenow"]))

    def test_matches_id_glob(self):
        self.assertTrue(Plugin._is_masked("app/com.nvidia.geforcenow/x86_64/master", ["com.nvidia.*"]))

    def test_matches_partial_ref(self):
        self.assertTrue(
            Plugin._is_masked("app/com.nvidia.geforcenow/x86_64/master", ["com.nvidia.geforcenow/x86_64/master"])
        )

    def test_matches_full_ref_with_kind(self):
        self.assertTrue(
            Plugin._is_masked("runtime/org.freedesktop.Platform.GL.default/x86_64/26.08", ["runtime/org.freedesktop.Platform.GL.*"])
        )

    def test_non_matching_pattern(self):
        self.assertFalse(Plugin._is_masked("app/com.discord.Discord/x86_64/stable", ["com.nvidia.*", "org.gtk.Gtk3theme.Breeze"]))

    def test_no_patterns(self):
        self.assertFalse(Plugin._is_masked("app/com.discord.Discord/x86_64/stable", []))

    def test_exact_id_pattern_does_not_match_longer_id(self):
        self.assertFalse(Plugin._is_masked("app/com.discord.DiscordCanary/x86_64/stable", ["com.discord.Discord"]))

    def test_matches_every_pattern_form_flatpak_accepts(self):
        ref = "app/com.nvidia.geforcenow/x86_64/master"
        for pattern in (
            "com.nvidia.geforcenow",
            "com.nvidia.geforcenow/x86_64",
            "com.nvidia.geforcenow/x86_64/master",
            "com.nvidia.geforcenow//master",
            "app/com.nvidia.geforcenow",
            "app/com.nvidia.geforcenow/x86_64",
            "app/com.nvidia.geforcenow/x86_64/master",
            "app/com.nvidia.geforcenow//master",
            "com.nvidia.*/x86_64",
            "*/x86_64",
            "app/*/x86_64",
        ):
            self.assertTrue(Plugin._is_masked(ref, [pattern]), pattern)

    def test_matches_glob_patterns_that_flatpak_masks(self):
        ref = "app/org.test.App/x86_64/master"
        for pattern in (
            "org.test.Ap*",
            "*.test.App",
            "*.App",
            "org.t*t.App",
            "*/x86_64/master",
            "org.*/*/master",
            "org.test.App/*/master",
            "org.test.App/*",
            "org.test.App/x86_*",
            "org.test.App/x86_64/mas*",
        ):
            self.assertTrue(Plugin._is_masked(ref, [pattern]), pattern)

    def test_does_not_match_other_kind_arch_or_branch(self):
        ref = "app/com.nvidia.geforcenow/x86_64/master"
        for pattern in (
            "runtime/com.nvidia.geforcenow",
            "x86_64",
            "com.nvidia.geforcenow/aarch64",
            "com.nvidia.geforcenow/x86_64/stable",
            "com.nvidia.geforcenow//stable",
            "app/com.nvidia.geforcenow/aarch64",
            "runtime/*/x86_64",
        ):
            self.assertFalse(Plugin._is_masked(ref, [pattern]), pattern)

    def test_runtime_pattern_matches_runtime_not_app(self):
        runtime = "runtime/org.freedesktop.Platform.GL.default/x86_64/26.08"
        self.assertTrue(Plugin._is_masked(runtime, ["runtime/org.freedesktop.Platform.GL.default"]))
        self.assertTrue(Plugin._is_masked(runtime, ["org.freedesktop.Platform.GL.default/x86_64"]))
        self.assertFalse(Plugin._is_masked("app/com.discord.Discord/x86_64/stable", ["runtime/com.discord.Discord"]))

    def test_glob_does_not_cross_segment_separators(self):
        self.assertTrue(Plugin._is_masked("app/org.example.App/x86_64/master", ["org.example.*"]))
        self.assertFalse(Plugin._is_masked("app/org.example.App/x86_64/master", ["org.example.App*master"]))
        self.assertFalse(Plugin._is_masked("app/org.example.App/x86_64/master", ["org.example.App/x86*master"]))

    def test_branch_glob(self):
        self.assertTrue(Plugin._is_masked("app/com.discord.Discord/x86_64/stable", ["com.discord.Discord//st*"]))
        self.assertFalse(Plugin._is_masked("app/com.discord.Discord/x86_64/stable", ["com.discord.Discord//beta*"]))

    def test_pattern_with_too_many_segments_matches_nothing(self):
        self.assertFalse(Plugin._is_masked("app/com.discord.Discord/x86_64/stable", ["com.discord.Discord/x86_64/stable/extra"]))

    def test_regex_metacharacters_in_patterns_are_literal(self):
        self.assertFalse(Plugin._is_masked("app/comxdiscordxDiscord/x86_64/stable", ["com.discord.Discord"]))

    def test_any_pattern_in_the_list_can_match(self):
        self.assertTrue(
            Plugin._is_masked("app/com.discord.Discord/x86_64/stable", ["com.nvidia.*", "com.discord.Discord/x86_64"])
        )

    def test_ref_without_kind_is_treated_as_an_app(self):
        self.assertTrue(Plugin._is_masked("com.discord.Discord/x86_64/stable", ["app/com.discord.Discord/x86_64"]))


class TestCheckFlatpakUpdates(unittest.TestCase):

    def _check(self, fake, scopes=("user",)):
        p = make_plugin(scopes)
        with patch("asyncio.create_subprocess_exec", fake):
            return run(p.check_flatpak_updates())

    def test_update_record_shape(self):
        fake = FakeExec()
        fake.when("--user", "remote-ls", stdout=remote_ls((SPOTIFY, "c1", "50.2 MB"), (DISCORD, "c2", "120.5 MB")))
        fake.when("--user", "list", LIST_NAMES_COLUMNS, stdout=installed((SPOTIFY, "Spotify", "a1"), (DISCORD, "Discord", "a2")))
        result = self._check(fake)
        self.assertTrue(result["success"])
        self.assertEqual(
            result["updates"],
            [
                {"id": "com.spotify.Client", "name": "Spotify", "downloadSize": "50.2 MB", "scope": "user", "ref": SPOTIFY},
                {"id": "com.discord.Discord", "name": "Discord", "downloadSize": "120.5 MB", "scope": "user", "ref": DISCORD},
            ],
        )
        self.assertEqual(result["masked"], [])
        self.assertEqual(result["error"], "")

    def test_remote_ls_omits_the_name_column(self):
        fake = FakeExec()
        self._check(fake)
        argv = fake.argvs("remote-ls")[0]
        self.assertIn("--updates", argv)
        self.assertIn(REMOTE_LS_COLUMNS, argv)
        columns = [a for a in argv if a.startswith("--columns=")]
        self.assertEqual(len(columns), 1)
        self.assertNotIn("name", columns[0])

    def test_name_falls_back_to_id_when_not_installed_listing(self):
        fake = FakeExec()
        fake.when("--user", "remote-ls", stdout=remote_ls((SPOTIFY, "c1")))
        result = self._check(fake)
        self.assertEqual(result["updates"][0]["name"], "com.spotify.Client")

    def test_name_falls_back_to_id_when_list_fails(self):
        fake = FakeExec()
        fake.when("--user", "remote-ls", stdout=remote_ls((SPOTIFY, "c1")))
        fake.when("--user", "list", rc=1, stderr="error")
        result = self._check(fake)
        self.assertTrue(result["success"])
        self.assertEqual(result["updates"][0]["name"], "com.spotify.Client")

    def test_runtime_ref_is_parsed_and_joined_to_name(self):
        runtime = "org.freedesktop.Platform.GL.default/x86_64/26.08"
        fake = FakeExec()
        fake.when("--user", "remote-ls", stdout=remote_ls(("runtime/" + runtime, "c1")))
        fake.when("--user", "list", LIST_NAMES_COLUMNS, stdout=installed((runtime, "Mesa", "a1")))
        update = self._check(fake)["updates"][0]
        self.assertEqual(update["id"], "org.freedesktop.Platform.GL.default")
        self.assertEqual(update["ref"], runtime)
        self.assertEqual(update["name"], "Mesa")

    def test_missing_download_size_is_empty(self):
        fake = FakeExec()
        fake.when("--user", "remote-ls", stdout="app/com.spotify.Client/x86_64/stable\tc1")
        result = self._check(fake)
        self.assertEqual(result["updates"][0]["downloadSize"], "")

    def test_empty_output_no_updates(self):
        result = self._check(FakeExec())
        self.assertTrue(result["success"])
        self.assertEqual(result["updates"], [])

    def test_single_column_line_ignored(self):
        fake = FakeExec()
        fake.when("--user", "remote-ls", stdout="app/com.spotify.Client/x86_64/stable")
        result = self._check(fake)
        self.assertTrue(result["success"])
        self.assertEqual(result["updates"], [])

    def test_mixed_valid_and_invalid_lines(self):
        fake = FakeExec()
        fake.when(
            "--user", "remote-ls",
            stdout=remote_ls((SPOTIFY, "c1")) + "\nbadline\n" + remote_ls((DISCORD, "c2")),
        )
        result = self._check(fake)
        self.assertTrue(result["success"])
        self.assertEqual([u["id"] for u in result["updates"]], ["com.spotify.Client", "com.discord.Discord"])

    def test_whitespace_stripped(self):
        fake = FakeExec()
        fake.when("--user", "remote-ls", stdout=f"  app/{SPOTIFY} \t c1 \t flathub \t  50 MB  ")
        fake.when("--user", "list", LIST_NAMES_COLUMNS, stdout=f" {SPOTIFY} \t  Spotify  \t a1 ")
        update = self._check(fake)["updates"][0]
        self.assertEqual(update["id"], "com.spotify.Client")
        self.assertEqual(update["name"], "Spotify")
        self.assertEqual(update["downloadSize"], "50 MB")

    def test_empty_trailing_column_does_not_drop_row(self):
        fake = FakeExec()
        fake.when("--user", "remote-ls", stdout=f"app/{SPOTIFY}\tc1\tflathub\t")
        result = self._check(fake)
        self.assertEqual(result["updates"][0]["downloadSize"], "")

    def test_updates_include_scope(self):
        fake = FakeExec()
        fake.when("--system", "remote-ls", stdout=remote_ls((SPOTIFY, "c1")))
        result = self._check(fake, scopes=["system"])
        self.assertEqual(result["updates"][0]["scope"], "system")

    def test_both_scopes_combined(self):
        fake = FakeExec()
        fake.when("--user", "remote-ls", stdout=remote_ls((DISCORD, "c1")))
        fake.when("--system", "remote-ls", stdout=remote_ls((BREEZE, "c2")))
        fake.when("--system", "list", LIST_NAMES_COLUMNS, stdout=installed((BREEZE, "Breeze GTK theme", "a1")))
        result = self._check(fake, scopes=["user", "system"])
        self.assertTrue(result["success"])
        self.assertEqual([(u["scope"], u["id"]) for u in result["updates"]],
                         [("user", "com.discord.Discord"), ("system", "org.gtk.Gtk3theme.Breeze")])
        self.assertEqual(result["updates"][1]["name"], "Breeze GTK theme")

    def test_scopes_and_probes_run_concurrently(self):
        fake = FakeExec(delay=0.05)
        self._check(fake, scopes=["user", "system"])
        self.assertEqual(len(fake.calls), 6)
        self.assertEqual(fake.max_active, 6)

    def test_no_appstream_refresh(self):
        fake = FakeExec()
        self._check(fake, scopes=["user", "system"])
        self.assertTrue(all("--appstream" not in argv for argv in fake.calls))
        self.assertEqual(fake.count("update"), 0)

    def test_subprocess_exception(self):
        p = make_plugin(["user"])
        with patch("asyncio.create_subprocess_exec", AsyncMock(side_effect=OSError("no flatpak"))):
            result = run(p.check_flatpak_updates())
        self.assertFalse(result["success"])
        self.assertIn("no flatpak", result["error"])
        self.assertEqual(result["updates"], [])

    def test_check_passes_clean_env_and_closed_stdin(self):
        fake = FakeExec()
        self._check(fake, scopes=["user", "system"])
        self.assertTrue(fake.kwargs)
        for kwargs in fake.kwargs:
            env = kwargs["env"]
            self.assertNotIn("LD_LIBRARY_PATH", env)
            self.assertNotIn("STEAM_RUNTIME", env)
            self.assertIn("PATH", env)
            self.assertIn("XDG_RUNTIME_DIR", env)
            self.assertEqual(kwargs["stdin"], asyncio.subprocess.DEVNULL)

    def test_nonzero_return_code(self):
        fake = FakeExec()
        fake.when("--user", "remote-ls", rc=1, stderr="error: no remotes")
        result = self._check(fake)
        self.assertFalse(result["success"])
        self.assertIn("no remotes", result["error"])
        self.assertNotIn("errorKind", result)

    def test_partial_scope_failure_keeps_other_scope_updates(self):
        fake = FakeExec()
        fake.when("--user", "remote-ls", rc=1, stderr="error: boom")
        fake.when("--system", "remote-ls", stdout=remote_ls((BREEZE, "c2")))
        result = self._check(fake, scopes=["user", "system"])
        self.assertFalse(result["success"])
        self.assertIn("boom", result["error"])
        self.assertEqual([u["id"] for u in result["updates"]], ["org.gtk.Gtk3theme.Breeze"])


class TestOfflineClassification(unittest.TestCase):

    DNS = (
        "error: Unable to load summary from remote flathub: While fetching "
        "https://dl.flathub.org/repo/summary.idx: [6] Could not resolve hostname\n"
    )

    def _check(self, fake, scopes=("user", "system")):
        p = make_plugin(scopes)
        with patch("asyncio.create_subprocess_exec", fake):
            return run(p.check_flatpak_updates())

    def test_dns_failure_is_offline_and_deduplicated(self):
        fake = FakeExec()
        fake.when("remote-ls", rc=1, stderr=self.DNS)
        result = self._check(fake)
        self.assertFalse(result["success"])
        self.assertEqual(result["errorKind"], "offline")
        self.assertTrue(result["error"].startswith("Offline:"))
        self.assertEqual(result["error"].count("Could not resolve hostname"), 1)

    def test_other_network_errors_are_offline(self):
        for text in (
            "error: Temporary failure in name resolution",
            "error: Network is unreachable",
            "error: Unable to load summary from remote flathub: [7] Couldn't connect to server",
            "error: Unable to load summary from remote flathub: Failed to connect to dl.flathub.org port 443",
            "error: Unable to load summary from remote flathub: [28] Timeout was reached",
            "error: Unable to load summary from remote flathub: Error resolving 'dl.flathub.org': Name or service not known",
            "error: Unable to load summary from remote flathub: [6]",
            "error: Unable to load summary from remote flathub: [7]",
            "error: Unable to load summary from remote flathub: [28]",
        ):
            fake = FakeExec()
            fake.when("remote-ls", rc=1, stderr=text)
            result = self._check(fake, scopes=["system"])
            self.assertEqual(result["errorKind"], "offline", text)
            self.assertTrue(result["error"].startswith("Offline:"), text)

    def test_summary_failure_that_is_not_a_network_error_is_not_offline(self):
        for text in (
            "error: Unable to load summary from remote flathub: Server returned status 503: Service Unavailable",
            "error: Unable to load summary from remote flathub: Server returned status 404: Not Found",
            "error: Unable to load summary from remote flathub: GPG signatures found, but none are in trusted keyring",
            "error: Unable to load summary from remote flathub",
        ):
            fake = FakeExec()
            fake.when("remote-ls", rc=1, stderr=text)
            result = self._check(fake, scopes=["system"])
            self.assertFalse(result["success"], text)
            self.assertNotIn("errorKind", result, text)
            self.assertFalse(result["error"].startswith("Offline:"), text)
            self.assertIn("Unable to load summary", result["error"], text)

    def test_unrelated_error_is_not_offline(self):
        fake = FakeExec()
        fake.when("remote-ls", rc=1, stderr="error: Permission denied")
        result = self._check(fake, scopes=["system"])
        self.assertNotIn("errorKind", result)
        self.assertFalse(result["error"].startswith("Offline:"))

    def test_mixed_failures_are_not_offline(self):
        fake = FakeExec()
        fake.when("--user", "remote-ls", rc=1, stderr=self.DNS)
        fake.when("--system", "remote-ls", rc=1, stderr="error: Permission denied")
        result = self._check(fake)
        self.assertNotIn("errorKind", result)
        self.assertIn("Permission denied", result["error"])

    def test_offline_scope_does_not_hide_other_scope_updates(self):
        fake = FakeExec()
        fake.when("--user", "remote-ls", rc=1, stderr=self.DNS)
        fake.when("--system", "remote-ls", stdout=remote_ls((BREEZE, "c2")))
        result = self._check(fake)
        self.assertEqual(result["errorKind"], "offline")
        self.assertEqual(len(result["updates"]), 1)

    def test_identical_errors_deduplicated_without_offline(self):
        fake = FakeExec()
        fake.when("remote-ls", rc=1, stderr="error: Permission denied\n")
        result = self._check(fake)
        self.assertEqual(result["error"].count("Permission denied"), 1)


class TestMaskedRefs(unittest.TestCase):

    def _check(self, mask_stdout, ref="app/" + GEFORCE, scopes=("user",), mask_rc=0):
        fake = FakeExec()
        fake.when("--user", "remote-ls", stdout=f"{ref}\tc1\tflathub\t183.1 MB")
        fake.when("--user", "mask", stdout=mask_stdout, rc=mask_rc)
        p = make_plugin(scopes)
        with patch("asyncio.create_subprocess_exec", fake):
            return run(p.check_flatpak_updates()), fake

    def test_masked_by_exact_id(self):
        result, _ = self._check("  com.nvidia.geforcenow\n")
        self.assertEqual(result["updates"], [])
        self.assertEqual(result["masked"], [GEFORCE])
        self.assertTrue(result["success"])

    def test_masked_by_glob(self):
        result, _ = self._check("  com.nvidia.*\n")
        self.assertEqual(result["updates"], [])

    def test_masked_by_partial_ref(self):
        result, _ = self._check(f"  {GEFORCE}\n")
        self.assertEqual(result["updates"], [])

    def test_masked_by_full_ref(self):
        result, _ = self._check(f"  app/{GEFORCE}\n")
        self.assertEqual(result["updates"], [])

    def test_masked_runtime_by_kind_pattern(self):
        runtime = "org.freedesktop.Platform.GL.default/x86_64/26.08"
        result, _ = self._check("  runtime/org.freedesktop.Platform.GL.*\n", ref="runtime/" + runtime)
        self.assertEqual(result["updates"], [])
        self.assertEqual(result["masked"], [runtime])

    def test_header_line_is_not_a_pattern(self):
        result, _ = self._check("Masked patterns:\n  com.other.App\n")
        self.assertEqual([u["id"] for u in result["updates"]], ["com.nvidia.geforcenow"])
        self.assertEqual(result["masked"], [])

    def test_no_masks_reports_everything(self):
        result, _ = self._check("")
        self.assertEqual(len(result["updates"]), 1)

    def test_mask_lookup_failure_keeps_updates(self):
        result, _ = self._check("", mask_rc=1)
        self.assertTrue(result["success"])
        self.assertEqual(len(result["updates"]), 1)

    def test_mask_is_per_scope(self):
        fake = FakeExec()
        fake.when("--user", "remote-ls", stdout=remote_ls((GEFORCE, "c1")))
        fake.when("--system", "remote-ls", stdout=remote_ls((GEFORCE, "c1")))
        fake.when("--user", "mask", stdout="  com.nvidia.geforcenow\n")
        p = make_plugin(["user", "system"])
        with patch("asyncio.create_subprocess_exec", fake):
            result = run(p.check_flatpak_updates())
        self.assertEqual([(u["scope"], u["id"]) for u in result["updates"]], [("system", "com.nvidia.geforcenow")])
        self.assertEqual(result["masked"], [GEFORCE])

    def test_mask_uses_the_scope_flag_without_arguments(self):
        _, fake = self._check("")
        argv = fake.argvs("mask")[0]
        self.assertEqual(argv[-2:], ["--user", "mask"])


class TestApplyFlatpakUpdates(unittest.TestCase):

    def _apply(self, fake, scopes=("user",), apply_scopes=None):
        p = make_plugin(scopes)
        with patch("asyncio.create_subprocess_exec", fake):
            return run(p.apply_flatpak_updates(apply_scopes))

    def test_successful_apply(self):
        fake = FakeExec().when("update", stdout="Nothing to do.")
        result = self._apply(fake)
        self.assertTrue(result["success"])
        self.assertEqual(result["returncode"], 0)

    def test_failed_apply(self):
        fake = FakeExec().when("update", rc=1, stderr="error: permission denied")
        result = self._apply(fake)
        self.assertFalse(result["success"])
        self.assertEqual(result["returncode"], 1)
        self.assertIn("permission denied", result["stderr"])

    def test_apply_runs_every_detected_scope_by_default(self):
        fake = FakeExec()
        result = self._apply(fake, scopes=["user", "system"])
        self.assertTrue(result["success"])
        self.assertEqual(fake.count("--user", "update", "--noninteractive"), 1)
        self.assertEqual(fake.count("--system", "update", "--noninteractive"), 1)

    def test_apply_limited_to_requested_scopes(self):
        fake = FakeExec()
        self._apply(fake, scopes=["user", "system"], apply_scopes=["system"])
        self.assertEqual(fake.count("--user", "update"), 0)
        self.assertEqual(fake.count("--system", "update"), 1)

    def test_stderr_only_from_failing_scopes(self):
        fake = FakeExec()
        fake.when("--user", "update", rc=1, stderr="error: disk full")
        fake.when("--system", "update", rc=0, stderr="Note: path warning")
        result = self._apply(fake, scopes=["user", "system"])
        self.assertFalse(result["success"])
        self.assertIn("disk full", result["stderr"])
        self.assertNotIn("path warning", result["stderr"])

    def test_subprocess_exception(self):
        p = make_plugin(["user"])
        with patch("asyncio.create_subprocess_exec", AsyncMock(side_effect=OSError("crash"))):
            result = run(p.apply_flatpak_updates())
        self.assertFalse(result["success"])
        self.assertEqual(result["returncode"], -1)
        self.assertIn("crash", result["stderr"])

    def test_reports_refs_whose_commit_changed_or_appeared(self):
        fake = FakeExec()
        fake.when(
            "--user", "list", LIST_SNAPSHOT_COLUMNS,
            stdout=[
                installed((DISCORD, "a1"), (SPOTIFY, "b1")),
                installed((DISCORD, "a2"), (SPOTIFY, "b1"), (BREEZE, "c1")),
            ],
        )
        result = self._apply(fake)
        self.assertEqual(result["scopes"]["user"]["appliedRefs"], [DISCORD, BREEZE])

    def test_no_change_reports_no_applied_refs(self):
        fake = FakeExec()
        fake.when("--user", "list", LIST_SNAPSHOT_COLUMNS, stdout=installed((DISCORD, "a1")))
        result = self._apply(fake)
        self.assertTrue(result["success"])
        self.assertEqual(result["scopes"]["user"]["appliedRefs"], [])

    def test_unavailable_snapshot_means_unverified(self):
        fake = FakeExec()
        fake.when("--user", "list", LIST_SNAPSHOT_COLUMNS, rc=1, stderr="error")
        result = self._apply(fake)
        self.assertIsNone(result["scopes"]["user"]["appliedRefs"])

    def test_snapshot_taken_before_and_after_update(self):
        fake = FakeExec()
        self._apply(fake)
        order = [
            "update" if "update" in argv else "list"
            for argv in fake.calls
            if "update" in argv or LIST_SNAPSHOT_COLUMNS in argv
        ]
        self.assertEqual(order, ["list", "update", "list"])


class TestCheckAndApplyFlatpak(unittest.TestCase):

    def setUp(self):
        decky_stub.logger.records.clear()

    def _discord_fake(self, remote_commit="r2", before="r1", after="r2", snapshot_rc=0):
        fake = FakeExec()
        fake.when("--user", "remote-ls", stdout=remote_ls((DISCORD, remote_commit, "100 MB")))
        fake.when("--user", "list", LIST_NAMES_COLUMNS, stdout=installed((DISCORD, "Discord", before)))
        fake.when(
            "--user", "list", LIST_SNAPSHOT_COLUMNS,
            stdout=[installed((DISCORD, before)), installed((DISCORD, after))], rc=snapshot_rc,
        )
        return fake

    def _call(self, p, fake, auto_apply=True):
        with patch("asyncio.create_subprocess_exec", fake):
            return run(p.check_and_apply_flatpak(auto_apply))

    def test_check_only_does_not_apply(self):
        p = make_plugin(["system"])
        fake = FakeExec().when("--system", "remote-ls", stdout=remote_ls((BREEZE, "c1", "192.5 kB")))
        result = self._call(p, fake, auto_apply=False)
        self.assertTrue(result["success"])
        self.assertEqual(len(result["updates"]), 1)
        self.assertFalse(result["applied"])
        self.assertEqual(result["appliedRefs"], [])
        self.assertEqual(result["appliedCount"], 0)
        self.assertEqual(fake.count("update"), 0)

    def test_applied_when_installed_commit_changed(self):
        p = make_plugin(["user"])
        result = self._call(p, self._discord_fake())
        self.assertTrue(result["success"])
        self.assertTrue(result["applied"])
        self.assertEqual(result["appliedRefs"], [DISCORD])
        self.assertEqual(result["appliedCount"], 1)
        self.assertEqual(result["stuckRefs"], [])
        self.assertEqual(result["masked"], [])
        self.assertEqual(result["applyError"], "")
        self.assertEqual(len(result["updates"]), 1)

    def test_apply_runs_only_for_scopes_with_pending_refs(self):
        p = make_plugin(["user", "system"])
        fake = self._discord_fake()
        self._call(p, fake)
        self.assertEqual(fake.count("--user", "update", "--noninteractive"), 1)
        self.assertEqual(fake.count("--system", "update"), 0)
        self.assertEqual(fake.count("--system", LIST_SNAPSHOT_COLUMNS), 0)

    def test_no_updates_skips_apply(self):
        p = make_plugin(["user", "system"])
        fake = FakeExec()
        result = self._call(p, fake)
        self.assertTrue(result["success"])
        self.assertFalse(result["applied"])
        self.assertEqual(result["updates"], [])
        self.assertEqual(fake.count("update"), 0)

    def test_only_masked_refs_pending_skips_apply(self):
        p = make_plugin(["user", "system"])
        fake = FakeExec()
        fake.when("--user", "remote-ls", stdout=remote_ls((GEFORCE, "a6efb6892f34", "183.1 MB")))
        fake.when("--user", "mask", stdout="  com.nvidia.geforcenow\n")
        result = self._call(p, fake)
        self.assertEqual(result["updates"], [])
        self.assertEqual(result["masked"], [GEFORCE])
        self.assertFalse(result["applied"])
        self.assertEqual(fake.count("update"), 0)

    def test_rc_zero_without_change_is_not_applied_and_marks_ref_stuck(self):
        p = make_plugin(["user"])
        result = self._call(p, self._discord_fake(before="r1", after="r1"))
        self.assertTrue(result["success"])
        self.assertFalse(result["applied"])
        self.assertEqual(result["appliedRefs"], [])
        self.assertEqual(result["appliedCount"], 0)
        self.assertEqual(result["stuckRefs"], [DISCORD])
        self.assertEqual(result["applyError"], "")
        self.assertEqual(result["updates"], [])

    def _two_ref_fake(self, before, after, scope="user"):
        fake = FakeExec()
        fake.when(f"--{scope}", "remote-ls", stdout=remote_ls((DISCORD, "r2", "100 MB"), (SPOTIFY, "s2", "50 MB")))
        fake.when(
            f"--{scope}", "list", LIST_SNAPSHOT_COLUMNS,
            stdout=[installed(*before), installed(*after)],
        )
        return fake

    def test_partial_apply_reports_only_the_refs_that_changed(self):
        p = make_plugin(["user"])
        fake = self._two_ref_fake(
            before=[(DISCORD, "r1"), (SPOTIFY, "s1")], after=[(DISCORD, "r2"), (SPOTIFY, "s1")]
        )
        result = self._call(p, fake)
        self.assertTrue(result["success"])
        self.assertTrue(result["applied"])
        self.assertEqual(result["appliedCount"], 1)
        self.assertEqual(result["appliedRefs"], [DISCORD])
        self.assertEqual(result["stuckRefs"], [SPOTIFY])
        self.assertEqual([u["ref"] for u in result["updates"]], [DISCORD])
        self.assertEqual(result["applyError"], "")

    def test_partial_apply_logs_one_warning_naming_the_stuck_refs(self):
        p = make_plugin(["user"])
        fake = self._two_ref_fake(
            before=[(DISCORD, "r1"), (SPOTIFY, "s1")], after=[(DISCORD, "r1"), (SPOTIFY, "s1")]
        )
        self._call(p, fake)
        warnings = [m for m in decky_stub.logger.messages("warning") if DISCORD in m or SPOTIFY in m]
        self.assertEqual(len(warnings), 1)
        self.assertIn(DISCORD, warnings[0])
        self.assertIn(SPOTIFY, warnings[0])

    def test_no_warning_when_nothing_is_stuck(self):
        p = make_plugin(["user"])
        self._call(p, self._discord_fake())
        self.assertEqual([m for m in decky_stub.logger.messages("warning") if DISCORD in m], [])

    def test_change_to_a_ref_that_was_not_pending_is_not_an_apply(self):
        p = make_plugin(["user"])
        fake = FakeExec()
        fake.when("--user", "remote-ls", stdout=remote_ls((DISCORD, "r2", "100 MB")))
        fake.when(
            "--user", "list", LIST_SNAPSHOT_COLUMNS,
            stdout=[installed((DISCORD, "r1")), installed((DISCORD, "r1"), (BREEZE, "c1"))],
        )
        result = self._call(p, fake)
        self.assertFalse(result["applied"])
        self.assertEqual(result["appliedCount"], 0)
        self.assertEqual(result["stuckRefs"], [DISCORD])
        self.assertEqual(result["updates"], [])

    def test_applied_count_is_per_scope_when_the_same_ref_is_in_both_scopes(self):
        p = make_plugin(["user", "system"])
        fake = FakeExec()
        fake.when("--user", "remote-ls", stdout=remote_ls((DISCORD, "r2")))
        fake.when("--system", "remote-ls", stdout=remote_ls((DISCORD, "r2")))
        fake.when("--user", "list", LIST_SNAPSHOT_COLUMNS, stdout=[installed((DISCORD, "r1")), installed((DISCORD, "r2"))])
        fake.when("--system", "list", LIST_SNAPSHOT_COLUMNS, stdout=installed((DISCORD, "r1")))
        result = self._call(p, fake)
        self.assertTrue(result["applied"])
        self.assertEqual(result["appliedCount"], 1)
        self.assertEqual(result["stuckRefs"], [DISCORD])
        self.assertEqual([(u["scope"], u["ref"]) for u in result["updates"]], [("user", DISCORD)])

    def test_stuck_ref_is_excluded_until_remote_commit_changes(self):
        p = make_plugin(["user"])
        self._call(p, self._discord_fake(remote_commit="r2", before="r1", after="r1"))

        again = self._discord_fake(remote_commit="r2", before="r1", after="r1")
        result = self._call(p, again)
        self.assertEqual(result["updates"], [])
        self.assertFalse(result["applied"])
        self.assertEqual(again.count("update"), 0)

        newer = self._discord_fake(remote_commit="r3", before="r1", after="r3")
        result = self._call(p, newer)
        self.assertEqual(len(result["updates"]), 1)
        self.assertTrue(result["applied"])
        self.assertEqual(newer.count("--user", "update"), 1)

    def test_stuck_ref_suppression_is_logged_once(self):
        p = make_plugin(["user"])

        def mentions():
            return len([m for m in decky_stub.logger.messages() if DISCORD in m])

        self._call(p, self._discord_fake(before="r1", after="r1"))
        self._call(p, self._discord_fake(before="r1", after="r1"))
        after_first_suppression = mentions()
        self._call(p, self._discord_fake(before="r1", after="r1"))
        self.assertEqual(mentions(), after_first_suppression)

    def test_stuck_ref_hidden_from_check_only_calls(self):
        p = make_plugin(["user"])
        self._call(p, self._discord_fake(before="r1", after="r1"))
        result = self._call(p, self._discord_fake(before="r1", after="r1"), auto_apply=False)
        self.assertEqual(result["updates"], [])

    def test_failed_apply_is_reported_and_not_remembered_as_stuck(self):
        p = make_plugin(["user"])
        fake = self._discord_fake(before="r1", after="r1")
        fake.when("--user", "update", rc=1, stderr="error: network down")
        result = self._call(p, fake)
        self.assertFalse(result["applied"])
        self.assertEqual(result["appliedCount"], 0)
        self.assertIn("network down", result["applyError"])
        self.assertEqual(result["stuckRefs"], [])
        self.assertEqual(len(result["updates"]), 1)

        retry = self._discord_fake(before="r1", after="r2")
        result = self._call(p, retry)
        self.assertEqual(len(result["updates"]), 1)
        self.assertTrue(result["applied"])

    def test_partial_apply_with_failure_returns_only_applied_updates(self):
        p = make_plugin(["user"])
        fake = self._two_ref_fake(
            before=[(DISCORD, "r1"), (SPOTIFY, "s1")], after=[(DISCORD, "r2"), (SPOTIFY, "s1")]
        )
        fake.when("--user", "update", rc=1, stderr="Error: Failed to update spotify")
        result = self._call(p, fake)
        self.assertTrue(result["applied"])
        self.assertEqual(result["appliedCount"], 1)
        self.assertEqual([u["ref"] for u in result["updates"]], [DISCORD])
        self.assertEqual(result["stuckRefs"], [])
        self.assertIn("Failed to update spotify", result["applyError"])

    def test_apply_error_only_from_failing_scope(self):
        p = make_plugin(["user", "system"])
        fake = FakeExec()
        fake.when("--user", "remote-ls", stdout=remote_ls((DISCORD, "r2")))
        fake.when("--system", "remote-ls", stdout=remote_ls((BREEZE, "c2")))
        fake.when("--user", "update", rc=1, stderr="error: disk full")
        fake.when("--system", "update", rc=0, stderr="Note: path warning")
        fake.when("--user", "list", LIST_SNAPSHOT_COLUMNS, stdout=installed((DISCORD, "r1")))
        fake.when("--system", "list", LIST_SNAPSHOT_COLUMNS, stdout=[installed((BREEZE, "c1")), installed((BREEZE, "c2"))])
        result = self._call(p, fake)
        self.assertIn("disk full", result["applyError"])
        self.assertNotIn("path warning", result["applyError"])
        self.assertTrue(result["applied"])
        self.assertEqual(result["appliedRefs"], [BREEZE])
        self.assertEqual(result["appliedCount"], 1)

    def test_unverifiable_apply_falls_back_to_exit_code(self):
        p = make_plugin(["user"])
        result = self._call(p, self._discord_fake(snapshot_rc=1))
        self.assertTrue(result["applied"])
        self.assertEqual(result["appliedRefs"], [DISCORD])
        self.assertEqual(result["appliedCount"], 1)
        self.assertEqual(result["stuckRefs"], [])

    def test_check_failure_skips_apply(self):
        p = make_plugin(["user"])
        fake = FakeExec().when("remote-ls", rc=1, stderr="error: no remotes")
        result = self._call(p, fake)
        self.assertFalse(result["success"])
        self.assertFalse(result["applied"])
        self.assertIn("no remotes", result["error"])
        self.assertEqual(fake.count("update"), 0)

    def test_offline_error_surfaces_error_kind(self):
        p = make_plugin(["user"])
        fake = FakeExec().when("remote-ls", rc=1, stderr="error: [6] Could not resolve hostname")
        result = self._call(p, fake)
        self.assertEqual(result["errorKind"], "offline")
        self.assertTrue(result["error"].startswith("Offline:"))

    def test_scope_failure_still_applies_other_scope(self):
        p = make_plugin(["user", "system"])
        fake = FakeExec()
        fake.when("--user", "remote-ls", rc=1, stderr="error: boom")
        fake.when("--system", "remote-ls", stdout=remote_ls((BREEZE, "c2")))
        fake.when("--system", "list", LIST_SNAPSHOT_COLUMNS, stdout=[installed((BREEZE, "c1")), installed((BREEZE, "c2"))])
        result = self._call(p, fake)
        self.assertFalse(result["success"])
        self.assertTrue(result["applied"])
        self.assertEqual(fake.count("--user", "update"), 0)

    def test_unexpected_exception_is_reported_not_raised(self):
        p = make_plugin(["user"])
        with patch("asyncio.create_subprocess_exec", AsyncMock(side_effect=OSError("no flatpak"))):
            result = run(p.check_and_apply_flatpak(True))
        self.assertFalse(result["success"])
        self.assertFalse(result["applied"])
        self.assertEqual(result["appliedCount"], 0)
        self.assertIn("no flatpak", result["error"])


class TestFlatpakSingleFlight(unittest.TestCase):

    def _fake(self, delay=0.05, before="r1", after="r2"):
        fake = FakeExec(delay=delay)
        fake.when("--user", "remote-ls", stdout=remote_ls((DISCORD, "r2")))
        fake.when("--user", "list", LIST_SNAPSHOT_COLUMNS, stdout=[installed((DISCORD, before)), installed((DISCORD, after))])
        return fake

    def test_duplicate_call_joins_running_check(self):
        p = make_plugin(["user"])
        fake = self._fake()

        async def scenario():
            first = asyncio.ensure_future(p.check_and_apply_flatpak(False))
            await asyncio.sleep(0.01)
            second = await p.check_and_apply_flatpak(False)
            return await first, second

        with patch("asyncio.create_subprocess_exec", fake):
            first, second = run(scenario())
        self.assertIs(first, second)
        self.assertEqual(len(second["updates"]), 1)
        self.assertEqual(fake.count("remote-ls"), 1)

    def test_duplicate_call_joins_running_apply_and_gets_the_real_result(self):
        p = make_plugin(["user"])
        fake = self._fake()

        async def scenario():
            first = asyncio.ensure_future(p.check_and_apply_flatpak(True))
            await asyncio.sleep(0.01)
            second = await p.check_and_apply_flatpak(True)
            return await first, second

        with patch("asyncio.create_subprocess_exec", fake):
            first, second = run(scenario())
        self.assertIs(first, second)
        self.assertTrue(second["applied"])
        self.assertEqual(second["appliedRefs"], [DISCORD])
        self.assertEqual(fake.count("--user", "update"), 1)

    def test_call_after_completion_starts_a_new_run(self):
        p = make_plugin(["user"])
        fake = self._fake(delay=0)
        with patch("asyncio.create_subprocess_exec", fake):
            run(p.check_and_apply_flatpak(False))
            run(p.check_and_apply_flatpak(False))
        self.assertEqual(fake.count("remote-ls"), 2)

    def test_apply_request_joining_check_only_run_still_applies(self):
        p = make_plugin(["user"])
        fake = self._fake()

        async def scenario():
            first = asyncio.ensure_future(p.check_and_apply_flatpak(False))
            await asyncio.sleep(0.01)
            second = await p.check_and_apply_flatpak(True)
            return await first, second

        with patch("asyncio.create_subprocess_exec", fake):
            first, second = run(scenario())
        self.assertFalse(first["applied"])
        self.assertTrue(second["applied"])
        self.assertEqual(fake.count("--user", "update"), 1)

    def test_cancelled_waiter_does_not_cancel_the_run(self):
        p = make_plugin(["user"])
        fake = self._fake()

        async def scenario():
            first = asyncio.ensure_future(p.check_and_apply_flatpak(False))
            await asyncio.sleep(0.01)
            first.cancel()
            second = await p.check_and_apply_flatpak(False)
            return second

        with patch("asyncio.create_subprocess_exec", fake):
            second = run(scenario())
        self.assertEqual(len(second["updates"]), 1)
        self.assertEqual(fake.count("remote-ls"), 1)

    def test_failed_run_result_is_shared_with_joined_callers(self):
        p = make_plugin(["user"])
        fake = FakeExec(delay=0.05).when("remote-ls", rc=1, stderr="error: no remotes")

        async def scenario():
            first = asyncio.ensure_future(p.check_and_apply_flatpak(True))
            await asyncio.sleep(0.01)
            second = await p.check_and_apply_flatpak(True)
            return await first, second

        with patch("asyncio.create_subprocess_exec", fake):
            first, second = run(scenario())
        self.assertFalse(second["success"])
        self.assertIs(first, second)


if __name__ == "__main__":
    unittest.main()
