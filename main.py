import os
import asyncio
import json
import re
import signal
import stat
import time
import decky

SETTINGS_FILENAME = "settings.json"
HISTORY_FILENAME = "history.json"
CHECK_STATE_FILENAME = "check_state.json"

CHECK_SOURCES = ("steam", "flatpak", "decky", "decky-loader", "steamos")
LIGHTEST_FIRST_ORDER = ["steam", "decky", "steamos", "decky-loader", "flatpak"]
LEGACY_LIGHTEST_ORDER = ["steamos", "decky-loader", "decky", "flatpak", "steam"]

FRONTEND_BATCH_MAX = 500
FRONTEND_MESSAGE_MAX = 2000
CHECK_STATE_MAX_ERRORS = 3
CHECK_STATE_MAX_ERROR_LENGTH = 200
KILL_WAIT_SECONDS = 5

OFFLINE_ERROR = re.compile(
    r"Could not resolve hostname|Temporary failure in name resolution|Network is unreachable"
    r"|Couldn't connect|Failed to connect|Timeout was reached|Error resolving|\[(?:6|7|28)\]"
)
END_OF_LIFE_INFO = re.compile(r"^Info:.*end-of-life", re.IGNORECASE)
TERMINAL_OSC = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
TERMINAL_CSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
TERMINAL_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class Plugin:
    settings: dict = {}
    settings_path: str = ""
    history_path: str = ""
    check_state_path: str = ""
    _defaults_cache: dict | None = None
    _history_lock: asyncio.Lock | None = None
    _flatpak_scopes: list[str] | None = None  # ["user"], ["system"], or ["user", "system"]
    _flatpak_task: asyncio.Task | None = None
    _flatpak_task_applies: bool = False
    _steamos_task: asyncio.Task | None = None
    _stuck_flatpak_refs: dict[tuple[str, str], str] | None = None
    _stuck_flatpak_logged: set[tuple[str, str, str]] | None = None

    async def _main(self):
        self._history_lock = asyncio.Lock()
        self.settings_path = os.path.join(
            decky.DECKY_PLUGIN_SETTINGS_DIR, SETTINGS_FILENAME
        )
        self.history_path = os.path.join(
            decky.DECKY_PLUGIN_SETTINGS_DIR, HISTORY_FILENAME
        )
        self.check_state_path = os.path.join(
            decky.DECKY_PLUGIN_SETTINGS_DIR, CHECK_STATE_FILENAME
        )
        self.settings = self._validate_settings(self._load_json(
            self.settings_path, self._default_settings()
        ))
        pkg_path = os.path.join(decky.DECKY_PLUGIN_DIR, "package.json")
        self._version = self._load_json(pkg_path, {}).get("version", "unknown")
        decky.logger.info(
            f"AutoUpdate v{self._version} loaded | "
            f"debug={'ON' if self.settings.get('debugLogging') else 'OFF'} | "
            f"settings={self.settings_path}"
        )

    async def _unload(self):
        decky.logger.info("AutoUpdate unloaded")

    async def _uninstall(self):
        decky.logger.info("AutoUpdate uninstalled")

    # --- Settings ---

    async def get_settings(self) -> dict:
        return self.settings

    async def save_settings(self, settings: dict) -> bool:
        self.settings = self._validate_settings(settings)
        return self._write_json(self.settings_path, self.settings)

    # Valid values for string-enum settings
    _ENUM_FIELDS = {
        "notificationLevel": ("off", "updates-only", "all"),
    }

    def _validate_settings(self, settings: dict) -> dict:
        defaults = self._default_settings()
        validated = {}

        # Migrations:
        # checkIntervalMinutes → steamCheckIntervalMinutes
        if "checkIntervalMinutes" in settings and "steamCheckIntervalMinutes" not in settings:
            settings["steamCheckIntervalMinutes"] = settings["checkIntervalMinutes"]

        # showNotifications (bool) → notificationLevel (string enum)
        if "showNotifications" in settings and "notificationLevel" not in settings:
            validated["notificationLevel"] = "updates-only" if settings["showNotifications"] else "off"
            decky.logger.info(f"Migrated showNotifications={settings['showNotifications']} → notificationLevel={validated['notificationLevel']}")

        for key, default_val in defaults.items():
            if key in validated:
                continue  # already set by migration
            val = settings.get(key, default_val)

            # String-enum fields
            if key in self._ENUM_FIELDS:
                if val not in self._ENUM_FIELDS[key]:
                    val = default_val
            elif isinstance(default_val, bool):
                # Must check bool before int because bool is a subclass of int
                if not isinstance(val, bool):
                    val = default_val
            elif isinstance(default_val, int):
                # Accept int/float interchangeably (JS sends floats over JSON IPC)
                if isinstance(val, (int, float)):
                    val = int(val)
                else:
                    val = default_val
            elif isinstance(default_val, list):
                if isinstance(val, list):
                    val = [item for item in val if isinstance(item, str)]
                else:
                    val = default_val
            elif not isinstance(val, type(default_val)):
                val = default_val
            validated[key] = val

        # Clamp numeric ranges
        validated["steamCheckIntervalMinutes"] = max(5, min(120, validated["steamCheckIntervalMinutes"]))
        validated["flatpakCheckIntervalMinutes"] = max(60, min(1440, validated["flatpakCheckIntervalMinutes"]))
        validated["maxHistoryEntries"] = max(1, min(1000, validated["maxHistoryEntries"]))
        validated["deckyCheckIntervalMinutes"] = max(60, min(2880, validated["deckyCheckIntervalMinutes"]))
        validated["steamosCheckIntervalMinutes"] = max(60, min(2880, validated["steamosCheckIntervalMinutes"]))
        validated["interCheckDelayMs"] = max(0, min(10000, validated["interCheckDelayMs"]))

        # Validate checkOrder: dedup, remove unknown sources, append missing
        valid_sources = set(CHECK_SOURCES)
        raw_order = validated.get("checkOrder", defaults["checkOrder"])
        if raw_order == LEGACY_LIGHTEST_ORDER:
            raw_order = list(LIGHTEST_FIRST_ORDER)
        seen: set[str] = set()
        clean: list[str] = []
        for src in raw_order:
            if src in valid_sources and src not in seen:
                clean.append(src)
                seen.add(src)
        # Append any valid sources that were missing (preserves default tail order)
        for src in defaults["checkOrder"]:
            if src not in seen:
                clean.append(src)
                seen.add(src)
        validated["checkOrder"] = clean

        return validated

    # --- History ---

    async def get_history(self) -> list:
        data = self._load_json(self.history_path, {"entries": []})
        return data.get("entries", [])

    async def add_history_entry(self, entry: dict) -> bool:
        async with self._history_lock:
            data = self._load_json(self.history_path, {"entries": []})
            entries = data.get("entries", [])
            entries.insert(0, entry)
            max_entries = self.settings.get("maxHistoryEntries", 100)
            entries = entries[:max_entries]
            return self._write_json(self.history_path, {"entries": entries})

    async def clear_history(self) -> bool:
        return self._write_json(self.history_path, {"entries": []})

    # --- Last-check summaries ---

    def _check_state_file(self) -> str:
        return self.check_state_path or os.path.join(
            decky.DECKY_PLUGIN_SETTINGS_DIR, CHECK_STATE_FILENAME
        )

    @staticmethod
    def _count_field(value) -> int | None:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        try:
            return max(0, int(value))
        except (ValueError, OverflowError):
            return None

    @staticmethod
    def _sanitize_check_state(raw) -> dict:
        if not isinstance(raw, dict):
            return {}
        clean: dict[str, dict] = {}
        for source in CHECK_SOURCES:
            entry = raw.get(source)
            if not isinstance(entry, dict):
                continue
            timestamp = Plugin._count_field(entry.get("timestamp"))
            pending = Plugin._count_field(entry.get("pendingCount"))
            forced = Plugin._count_field(entry.get("forcedCount"))
            if timestamp is None or pending is None or forced is None:
                continue
            errors = entry.get("errors")
            if not isinstance(errors, list):
                errors = []
            clean[source] = {
                "timestamp": timestamp,
                "pendingCount": pending,
                "forcedCount": forced,
                "errors": [
                    e[:CHECK_STATE_MAX_ERROR_LENGTH] for e in errors if isinstance(e, str)
                ][:CHECK_STATE_MAX_ERRORS],
            }
        return clean

    async def get_check_state(self) -> dict:
        return self._sanitize_check_state(self._load_json(self._check_state_file(), {}))

    async def save_check_state(self, state: dict) -> bool:
        if not isinstance(state, dict):
            return False
        path = self._check_state_file()
        merged = self._sanitize_check_state(self._load_json(path, {}))
        now_ms = int(time.time() * 1000)
        for source, incoming in self._sanitize_check_state(state).items():
            current = merged.get(source)
            # A stored timestamp in the future (clock stepped back since) must not block every later save.
            if current is None or incoming["timestamp"] >= current["timestamp"] or current["timestamp"] > now_ms:
                merged[source] = incoming
        return self._write_json(path, merged)

    # --- Steam force-update via manifest + URL handler ---

    # Cache of Steam library steamapps directories, read from libraryfolders.vdf
    _steam_library_dirs: list[str] | None = None

    @classmethod
    def _steam_library_steamapps_dirs(cls) -> list[str]:
        """Read libraryfolders.vdf to find every steamapps/ dir Steam knows about.

        Returns paths to the steamapps/ directories themselves (containing
        appmanifest_*.acf). Cached for the lifetime of the plugin.
        """
        if cls._steam_library_dirs is not None:
            return cls._steam_library_dirs

        _, home = Plugin._deck_user_info()
        primary = f"{home}/.steam/steam"
        vdf_path = f"{primary}/steamapps/libraryfolders.vdf"
        dirs: list[str] = []
        try:
            with open(vdf_path, "r") as f:
                content = f.read()
            # libraryfolders.vdf is a KeyValues file. Each library is a numbered
            # object with a "path" field. Regex is fine here — the format is
            # flat enough that we don't need a full VDF parser for this lookup.
            import re
            for m in re.finditer(r'"path"\s+"([^"]+)"', content):
                steamapps = os.path.join(m.group(1), "steamapps")
                if os.path.isdir(steamapps):
                    dirs.append(steamapps)
        except FileNotFoundError:
            decky.logger.warning(f"libraryfolders.vdf not found at {vdf_path}")
        except Exception as e:
            decky.logger.warning(f"Failed to parse libraryfolders.vdf: {e}")

        # Fall back to the primary library if the vdf yielded nothing
        if not dirs:
            dirs = [f"{primary}/steamapps"]

        cls._steam_library_dirs = dirs
        decky.logger.info(f"Steam library steamapps dirs: {dirs}")
        return dirs

    @classmethod
    def _steam_appmanifest_paths(cls, app_id: int) -> list[str]:
        """Possible locations of an app's manifest file across library folders."""
        return [
            os.path.join(d, f"appmanifest_{app_id}.acf")
            for d in cls._steam_library_steamapps_dirs()
            if os.path.isfile(os.path.join(d, f"appmanifest_{app_id}.acf"))
        ]

    async def get_app_state_flags(self, app_id: int) -> int:
        """Return StateFlags from an app's manifest, or -1 if no manifest.

        StateFlags is a bitmask Steam uses to track install state. The bits
        we care about:
          2    UpdateRequired — newer version available
          4    FullyInstalled — content on disk
          6    FullyInstalled + UpdateRequired (Steam's queue UI shows these)
          256  UpdateRunning, 512 UpdatePaused, 1024 UpdateStarted, etc.

        Steam's "scheduled downloads" queue surfaces items where
        (StateFlags & 6) == 6 — installed AND has an update to apply.
        """
        try:
            paths = self._steam_appmanifest_paths(app_id)
            if not paths:
                return -1
            with open(paths[0], "r") as f:
                content = f.read()
            import re
            m = re.search(r'"StateFlags"\s+"(\d+)"', content)
            return int(m.group(1)) if m else 0
        except Exception as e:
            decky.logger.warning(f"get_app_state_flags({app_id}) failed: {e}")
            return -1

    async def get_app_state_flags_batch(self, app_ids: list[int]) -> dict:
        """Batch version of get_app_state_flags. Returns {appid_str: state_flags}.

        Frontend uses this to filter the pending list to items that Steam
        considers fully-installed-with-update (StateFlags & 6 == 6).
        """
        out: dict[str, int] = {}
        for aid in app_ids or []:
            try:
                aid_int = int(aid)
            except (TypeError, ValueError):
                continue
            out[str(aid_int)] = await self.get_app_state_flags(aid_int)
        return out

    async def force_steam_app_update(self, app_id: int) -> dict:
        """Force a scheduled Steam app update to start now.

        Post-Steam-update (May 2026), the CEF SteamClient APIs no longer clear
        an app's ScheduledAutoUpdate (the user-visible "scheduled" state). The
        only reliable approach we've found is:

          1. Edit appmanifest_<app_id>.acf and set ScheduledAutoUpdate "0",
             which removes the deferral.
          2. Hand the appid to the running Steam client via
             `steam steam://updateapp/<app_id>` so it picks up the manifest
             change and queues the download immediately.

        Returns {success, manifest_path, manifest_modified, url_invoked, error}.
        """
        result = {
            "success": False,
            "manifest_path": "",
            "manifest_modified": False,
            "url_invoked": False,
            "error": "",
        }
        try:
            paths = self._steam_appmanifest_paths(app_id)
            if not paths:
                result["error"] = f"No manifest found for appid {app_id}"
                decky.logger.warning(result["error"])
                return result
            path = paths[0]
            result["manifest_path"] = path
            with open(path, "r") as f:
                content = f.read()

            # The ACF format uses tab-separated key/value pairs:
            #   "ScheduledAutoUpdate"\t\t"1778928300"
            # We replace any non-zero value with "0".
            import re
            new_content, n = re.subn(
                r'("ScheduledAutoUpdate"\s+")[^"]*(")',
                r'\g<1>0\g<2>',
                content,
                count=1,
            )
            if n > 0 and new_content != content:
                with open(path, "w") as f:
                    f.write(new_content)
                result["manifest_modified"] = True
                decky.logger.info(
                    f"Cleared ScheduledAutoUpdate in {path}"
                )
            else:
                self._debug(
                    f"No ScheduledAutoUpdate field to clear in {path} (already 0?)"
                )

            # Hand the URL to the running Steam client. We don't need to
            # capture output — Steam handles the URL asynchronously.
            uid, _ = Plugin._deck_user_info()
            rc, _, stderr = await self._run_cmd(
                [
                    "/usr/bin/runuser", "-u", "deck", "--",
                    "/usr/bin/steam", f"steam://updateapp/{app_id}",
                ],
                timeout=15,
                env={
                    "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                    "XDG_RUNTIME_DIR": f"/run/user/{uid}",
                    "DISPLAY": ":0",
                    "HOME": f"/home/deck",
                },
            )
            result["url_invoked"] = rc == 0
            if rc != 0:
                result["error"] = stderr.strip()[:200] or f"steam URL exited {rc}"

            result["success"] = result["manifest_modified"] or result["url_invoked"]
            return result
        except Exception as e:
            decky.logger.error(f"force_steam_app_update({app_id}) failed: {e}")
            result["error"] = str(e)
            return result

    async def ping(self) -> bool:
        """Fast IPC health check. Returns immediately."""
        return True

    async def get_decky_version(self) -> str:
        """Read the Decky Loader version from disk.

        The updater/get_version route returns an error on current Decky builds,
        so we read /home/deck/homebrew/services/.loader.version directly.
        """
        try:
            with open("/home/deck/homebrew/services/.loader.version", "r") as f:
                return f.read().strip()
        except Exception as e:
            decky.logger.warning(f"Failed to read .loader.version: {e}")
            return ""

    @staticmethod
    def _frontend_tag(ts_ms) -> str:
        if isinstance(ts_ms, bool) or not isinstance(ts_ms, (int, float)):
            return "[Frontend]"
        try:
            whole_ms = int(ts_ms)
            if whole_ms < 0:
                return "[Frontend]"
            clock = time.strftime("%H:%M:%S", time.localtime(whole_ms // 1000))
        except (ValueError, OverflowError, OSError):
            return "[Frontend]"
        return f"[Frontend {clock}.{whole_ms % 1000:03d}]"

    def _log_frontend_line(self, level, message: str, ts_ms=None):
        if len(message) > FRONTEND_MESSAGE_MAX:
            message = message[:FRONTEND_MESSAGE_MAX] + "...(truncated)"
        line = f"{self._frontend_tag(ts_ms)} {message}"
        if level == "error":
            decky.logger.error(line)
        elif level in ("warn", "warning"):
            decky.logger.warning(line)
        elif level == "debug":
            self._debug(line)
        else:
            decky.logger.info(line)

    async def log_frontend_message(self, level: str, message: str) -> bool:
        """Write a frontend log message to the plugin log file."""
        if not isinstance(message, str):
            return False
        self._log_frontend_line(level, message)
        return True

    async def log_frontend_batch(self, entries: list) -> int:
        """Write buffered frontend log entries [level, message, ts_ms] in one IPC call."""
        if not isinstance(entries, list):
            return 0
        logged = 0
        for entry in entries[:FRONTEND_BATCH_MAX]:
            if not isinstance(entry, (list, tuple)) or len(entry) < 2:
                continue
            if not isinstance(entry[1], str):
                continue
            self._log_frontend_line(entry[0], entry[1], entry[2] if len(entry) > 2 else None)
            logged += 1
        return logged

    # --- Subprocess helpers ---

    # Cached deck user info (never changes at runtime)
    _deck_uid: int | None = None
    _deck_home: str | None = None

    @staticmethod
    def _deck_user_info() -> tuple[int, str]:
        """Return (uid, home) for the deck user, cached after first call."""
        if Plugin._deck_uid is not None:
            return Plugin._deck_uid, Plugin._deck_home
        try:
            import pwd
            pw = pwd.getpwnam("deck")
            Plugin._deck_uid, Plugin._deck_home = pw.pw_uid, pw.pw_dir
        except (KeyError, ImportError):
            Plugin._deck_uid, Plugin._deck_home = 1000, "/home/deck"
        return Plugin._deck_uid, Plugin._deck_home

    @staticmethod
    def _minimal_env() -> dict[str, str]:
        """Build a minimal environment free of Steam runtime pollution.

        Never copy os.environ: Steam runtime pollution causes hangs.
        """
        uid, _ = Plugin._deck_user_info()
        return {
            "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "XDG_RUNTIME_DIR": f"/run/user/{uid}",
            "LANG": os.environ.get("LANG", "en_US.UTF-8"),
        }

    @staticmethod
    def _deck_env() -> dict[str, str]:
        """Minimal env plus HOME and XDG_DATA_DIRS for user-level flatpak."""
        env = Plugin._minimal_env()
        _, home = Plugin._deck_user_info()
        env["HOME"] = home
        env["XDG_DATA_DIRS"] = (
            f"{home}/.local/share/flatpak/exports/share"
            ":/usr/local/share:/usr/share"
        )
        return env

    def _debug(self, msg: str):
        """Log a debug message if debug logging is enabled in settings."""
        if self.settings.get("debugLogging"):
            decky.logger.info(f"[DEBUG] {msg}")

    @staticmethod
    def _kill_process(proc):
        if proc.returncode is None:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass

    @staticmethod
    def _loggable_stdout(text: str) -> str:
        return "\n".join(
            line
            for line in Plugin._clean_terminal_output(text).split("\n")
            if not END_OF_LIFE_INFO.match(line.strip())
        ).strip()

    async def _run_cmd(self, argv: list[str], timeout: int = 120, env: dict[str, str] | None = None) -> tuple[int, str, str]:
        """Run a command and return (returncode, stdout, stderr)."""
        cmd_str = " ".join(argv)
        started = time.monotonic()
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env or Plugin._minimal_env(),
            start_new_session=True,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            self._kill_process(proc)
            try:
                await asyncio.wait_for(proc.wait(), timeout=KILL_WAIT_SECONDS)
            except asyncio.TimeoutError:
                decky.logger.error(f"Process did not exit after kill: {cmd_str}")
            decky.logger.error(f"cmd timed out after {timeout}s: {cmd_str}")
            return -1, "", f"{argv[0]} timed out after {timeout}s"
        except asyncio.CancelledError:
            self._kill_process(proc)
            raise
        elapsed_ms = round((time.monotonic() - started) * 1000)
        rc = proc.returncode
        out_text = stdout.decode(errors="replace")
        err_text = stderr.decode(errors="replace")
        decky.logger.info(f"cmd rc={rc} {elapsed_ms}ms: {cmd_str}")
        if rc != 0 or self.settings.get("debugLogging"):
            err_snippet = self._clean_terminal_output(err_text)
            if err_snippet:
                decky.logger.info(f"  stderr: {err_snippet[:500]}")
            out_snippet = self._loggable_stdout(out_text)
            if out_snippet:
                decky.logger.info(f"  stdout: {out_snippet[:500]}")
        return rc, out_text, err_text

    # --- Flatpak ---

    async def get_flatpak_available(self) -> bool:
        return os.path.isfile("/usr/bin/flatpak")

    async def _detect_flatpak_scopes(self) -> list[str]:
        """Detect which flatpak scopes have installed apps.

        Returns a list of active scopes, e.g. ["user", "system"] or ["user"].
        Both scopes are checked so updates are never missed. The result is
        cached only when both probes ran cleanly.
        """
        if self._flatpak_scopes is not None:
            return self._flatpak_scopes

        async def probe(scope: str) -> tuple[int, bool]:
            try:
                rc, stdout, _ = await self._run_flatpak(
                    scope, ["list", "--app", "--columns=application"], timeout=15
                )
            except Exception as e:
                decky.logger.warning(f"Failed to count {scope} flatpaks: {e}")
                return 0, False
            if rc != 0:
                return 0, False
            return len(stdout.strip().splitlines()) if stdout.strip() else 0, True

        (user_count, user_ok), (system_count, system_ok) = await asyncio.gather(
            probe("user"), probe("system")
        )

        scopes = []
        if user_count > 0:
            scopes.append("user")
        if system_count > 0:
            scopes.append("system")
        if not scopes:
            scopes.append("user")

        summary = f"{scopes} (user={user_count}, system={system_count})"
        if user_ok and system_ok:
            self._flatpak_scopes = scopes
            decky.logger.info(f"Flatpak scopes detected: {summary}")
        else:
            decky.logger.warning(f"Flatpak scope probe failed, using {summary} without caching")
        return scopes

    def _flatpak_cmd(self, scope: str, flatpak_args: list[str]) -> tuple[list[str], dict[str, str]]:
        """Build argv and env for a flatpak command at the given scope."""
        if scope == "user":
            argv = [
                "/usr/bin/runuser", "-u", "deck", "--",
                "/usr/bin/flatpak", "--user",
            ] + flatpak_args
            env = Plugin._deck_env()
        else:
            argv = ["/usr/bin/flatpak", "--system"] + flatpak_args
            env = Plugin._minimal_env()
        return argv, env

    async def _run_flatpak(self, scope: str, flatpak_args: list[str], timeout: int = 120) -> tuple[int, str, str]:
        """Run a flatpak command for an explicit scope."""
        argv, env = self._flatpak_cmd(scope, flatpak_args)
        return await self._run_cmd(argv, timeout, env=env)

    @staticmethod
    def _tsv_rows(text: str) -> list[list[str]]:
        return [
            [cell.strip() for cell in line.split("\t")]
            for line in text.splitlines()
            if line.strip()
        ]

    @staticmethod
    def _strip_ref_kind(ref: str) -> str:
        kind, sep, rest = ref.partition("/")
        return rest if sep and kind in ("app", "runtime") else ref

    @staticmethod
    def _parse_mask_patterns(text: str) -> list[str]:
        patterns = []
        for line in text.splitlines():
            pattern = line.strip()
            if pattern and not pattern.lower().startswith(("masked", "no masked")):
                patterns.append(pattern)
        return patterns

    @staticmethod
    def _mask_regex(pattern: str) -> "re.Pattern[str]":
        parts = pattern.split("/")
        if parts[0] in ("app", "runtime"):
            prefix, parts = parts[0] + "/", parts[1:]
        else:
            prefix = "(?:app|runtime)/"
        if len(parts) > 3:
            return re.compile(r"(?!)")
        ident, *rest = (parts + ["", "", ""])[:3]
        ident = re.escape(ident).replace(r"\*", r"[.\-_a-zA-Z0-9]*")
        rest = [re.escape(part).replace(r"\*", "[^/]*") if part else "[^/]*" for part in rest]
        return re.compile(prefix + "/".join([ident, *rest]))

    @staticmethod
    def _is_masked(ref: str, patterns: list[str]) -> bool:
        kind = ref.partition("/")[0]
        full = ref if kind in ("app", "runtime") else f"app/{ref}"
        return any(Plugin._mask_regex(pattern).fullmatch(full) for pattern in patterns)

    def _stuck_refs(self) -> dict[tuple[str, str], str]:
        if self._stuck_flatpak_refs is None:
            self._stuck_flatpak_refs = {}
        return self._stuck_flatpak_refs

    def _stuck_logged(self) -> set[tuple[str, str, str]]:
        if self._stuck_flatpak_logged is None:
            self._stuck_flatpak_logged = set()
        return self._stuck_flatpak_logged

    async def _scan_flatpak_scope(self, scope: str) -> dict:
        """Pending, non-masked refs for one scope. Runs the three probes concurrently."""
        remote, listing, mask = await asyncio.gather(
            self._run_flatpak(
                scope, ["remote-ls", "--updates", "--columns=ref,commit,origin,download-size"]
            ),
            self._run_flatpak(scope, ["list", "--all", "--columns=ref,name,active"], timeout=30),
            self._run_flatpak(scope, ["mask"], timeout=15),
            return_exceptions=True,
        )
        for outcome in (remote, listing, mask):
            if isinstance(outcome, asyncio.CancelledError):
                raise outcome

        scan = {"scope": scope, "error": "", "updates": [], "masked": [], "pending": set()}
        if isinstance(remote, BaseException):
            decky.logger.error(f"flatpak --{scope} remote-ls failed: {remote}")
            scan["error"] = str(remote)
            return scan
        rc, stdout, stderr = remote
        if rc != 0:
            decky.logger.error(f"flatpak --{scope} remote-ls failed (rc={rc})")
            scan["error"] = stderr.strip()[:500] or f"flatpak --{scope} exited with code {rc}"
            return scan

        names: dict[str, str] = {}
        if not isinstance(listing, BaseException) and listing[0] == 0:
            for row in self._tsv_rows(listing[1]):
                if len(row) >= 2 and row[1]:
                    names[row[0]] = row[1]
        else:
            decky.logger.warning(f"flatpak --{scope} list failed; using ids as names")

        patterns: list[str] = []
        if not isinstance(mask, BaseException) and mask[0] == 0:
            patterns = self._parse_mask_patterns(mask[1])
        else:
            decky.logger.warning(f"flatpak --{scope} mask lookup failed; masked refs may be listed")

        for row in self._tsv_rows(stdout):
            if len(row) < 2:
                continue
            partial = self._strip_ref_kind(row[0])
            if "/" not in partial:
                continue
            scan["pending"].add(partial)
            if self._is_masked(row[0], patterns):
                scan["masked"].append(partial)
                continue
            app_id = partial.split("/")[0]
            scan["updates"].append({
                "id": app_id,
                "name": names.get(partial) or app_id,
                "downloadSize": row[3] if len(row) >= 4 else "",
                "scope": scope,
                "ref": partial,
                "commit": row[1],
            })
        return scan

    def _drop_stuck(self, scan: dict) -> list[dict]:
        """Remove updates remembered as stuck at the same remote commit; forget stale memories."""
        scope = scan["scope"]
        stuck = self._stuck_refs()
        kept = []
        for update in scan["updates"]:
            key = (scope, update["ref"])
            remembered = stuck.get(key)
            if remembered is None:
                kept.append(update)
            elif remembered == update["commit"]:
                logged = self._stuck_logged()
                token = (scope, update["ref"], update["commit"])
                if token not in logged:
                    logged.add(token)
                    decky.logger.info(
                        f"Ignoring stuck flatpak {update['ref']} ({scope}) "
                        f"until the remote commit changes from {update['commit']}"
                    )
            else:
                del stuck[key]
                kept.append(update)
        for key in [k for k in stuck if k[0] == scope and k[1] not in scan["pending"]]:
            del stuck[key]
        return kept

    async def _scan_flatpak(self) -> dict:
        scopes = await self._detect_flatpak_scopes()
        scans = await asyncio.gather(*(self._scan_flatpak_scope(scope) for scope in scopes))

        updates: list[dict] = []
        masked: list[str] = []
        failed = [scan for scan in scans if scan["error"]]
        for scan in scans:
            masked.extend(scan["masked"])
            if not scan["error"]:
                updates.extend(self._drop_stuck(scan))

        scan_result: dict = {
            "success": not failed,
            "updates": updates,
            "masked": list(dict.fromkeys(masked)),
            "error": "",
        }
        if failed:
            message = "; ".join(dict.fromkeys(scan["error"] for scan in failed))
            if all(OFFLINE_ERROR.search(scan["error"]) for scan in failed):
                scan_result["errorKind"] = "offline"
                message = f"Offline: {message}"
            scan_result["error"] = message

        decky.logger.info(
            f"Flatpak check complete: {len(updates)} update(s), {len(scan_result['masked'])} masked"
        )
        if updates:
            decky.logger.info(f"  Updates: {', '.join(u['name'] for u in updates[:10])}")
        return scan_result

    @staticmethod
    def _public_updates(updates: list[dict]) -> list[dict]:
        return [{k: v for k, v in update.items() if k != "commit"} for update in updates]

    async def check_flatpak_updates(self) -> dict:
        """List available flatpak updates across all active scopes."""
        try:
            scan = await self._scan_flatpak()
        except Exception as e:
            decky.logger.error(f"Failed to check flatpak updates: {e}")
            return {"success": False, "updates": [], "masked": [], "error": str(e)}
        return {**scan, "updates": self._public_updates(scan["updates"])}

    async def _flatpak_installed_commits(self, scope: str) -> dict[str, str] | None:
        try:
            rc, stdout, _ = await self._run_flatpak(
                scope, ["list", "--all", "--columns=ref,active"], timeout=30
            )
        except Exception as e:
            decky.logger.warning(f"flatpak --{scope} list snapshot failed: {e}")
            return None
        if rc != 0:
            decky.logger.warning(f"flatpak --{scope} list snapshot failed (rc={rc})")
            return None
        return {row[0]: row[1] if len(row) > 1 else "" for row in self._tsv_rows(stdout)}

    async def apply_flatpak_updates(self, scopes: list[str] | None = None) -> dict:
        """Run flatpak update for the given scopes (default: all active) and report what changed.

        Per scope, appliedRefs lists the refs whose installed commit changed or
        that newly appeared, or None when the before/after snapshot was unavailable.
        """
        try:
            if scopes is None:
                scopes = await self._detect_flatpak_scopes()
        except Exception as e:
            decky.logger.error(f"Failed to apply flatpak updates: {e}")
            return {"success": False, "stdout": "", "stderr": str(e), "returncode": -1, "scopes": {}}

        per_scope: dict[str, dict] = {}
        all_stdout, failed_stderr = [], []
        returncode = 0
        for scope in scopes:
            before = await self._flatpak_installed_commits(scope)
            try:
                rc, stdout, stderr = await self._run_flatpak(scope, ["update", "--noninteractive"], timeout=600)
            except Exception as e:
                decky.logger.error(f"Flatpak --{scope} update failed: {e}")
                rc, stdout, stderr = -1, "", str(e)
            after = await self._flatpak_installed_commits(scope)
            applied = None
            if before is not None and after is not None:
                applied = [ref for ref, commit in after.items() if before.get(ref) != commit]
            per_scope[scope] = {"returncode": rc, "stderr": stderr, "appliedRefs": applied}
            all_stdout.append(stdout)
            if rc != 0:
                failed_stderr.append(stderr.strip())
                returncode = returncode or rc
        return {
            "success": returncode == 0,
            "stdout": "\n".join(all_stdout),
            "stderr": "\n".join(failed_stderr),
            "returncode": returncode,
            "scopes": per_scope,
        }

    def _remember_stuck(self, scope: str, update: dict):
        self._stuck_refs()[(scope, update["ref"])] = update["commit"]

    async def _apply_pending_flatpaks(self, updates: list[dict], result: dict):
        by_scope: dict[str, list[dict]] = {}
        for update in updates:
            by_scope.setdefault(update["scope"], []).append(update)
        decky.logger.info(
            f"Auto-applying {len(updates)} flatpak update(s) in scope(s): {', '.join(by_scope)}"
        )
        apply = await self.apply_flatpak_updates(list(by_scope))

        applied_refs: list[str] = []
        applied_count = 0
        applied_keys: set[tuple[str, str]] = set()
        stuck: list[tuple[str, dict]] = []
        errors: list[str] = []
        for scope, outcome in apply["scopes"].items():
            rc = outcome["returncode"]
            if rc != 0:
                errors.append(outcome["stderr"].strip()[:500] or f"flatpak --{scope} update exited with code {rc}")
            pending = by_scope.get(scope, [])
            changed = outcome["appliedRefs"]
            if changed is None:
                decky.logger.warning(f"flatpak --{scope}: could not verify installed commits")
                if rc == 0:
                    applied_refs.extend(update["ref"] for update in pending)
                    applied_count += len(pending)
                    applied_keys.update((scope, update["ref"]) for update in pending)
                continue
            applied_refs.extend(changed)
            for update in pending:
                if update["ref"] in changed:
                    applied_count += 1
                    applied_keys.add((scope, update["ref"]))
            if rc == 0:
                for update in pending:
                    if update["ref"] not in changed:
                        stuck.append((scope, update))
                        self._remember_stuck(scope, update)

        stuck_keys = {(scope, update["ref"]) for scope, update in stuck}
        if stuck:
            decky.logger.warning(
                "Flatpak update left "
                + ", ".join(f"{update['ref']} ({scope})" for scope, update in stuck)
                + " unchanged; ignoring until the remote commit changes"
            )
        result["applied"] = applied_count > 0
        result["appliedCount"] = applied_count
        result["appliedRefs"] = applied_refs
        result["stuckRefs"] = [update["ref"] for _, update in stuck]
        if applied_count > 0:
            # The frontend counts every returned update as applied once anything applied, so return only those.
            result["updates"] = [u for u in result["updates"] if (u["scope"], u["ref"]) in applied_keys]
        else:
            result["updates"] = [u for u in result["updates"] if (u["scope"], u["ref"]) not in stuck_keys]
        result["applyError"] = "; ".join(dict.fromkeys(errors))
        decky.logger.info(
            f"Flatpak apply complete: {applied_count} applied, {len(stuck)} unchanged"
        )

    async def _flatpak_run(self, auto_apply: bool) -> dict:
        try:
            scan = await self._scan_flatpak()
            result = {
                **scan,
                "updates": self._public_updates(scan["updates"]),
                "applied": False,
                "appliedCount": 0,
                "appliedRefs": [],
                "stuckRefs": [],
                "applyError": "",
            }
            if auto_apply and scan["updates"]:
                await self._apply_pending_flatpaks(scan["updates"], result)
            return result
        except Exception as e:
            decky.logger.error(f"Flatpak check failed: {e}")
            return {
                "success": False,
                "updates": [],
                "applied": False,
                "appliedCount": 0,
                "appliedRefs": [],
                "stuckRefs": [],
                "masked": [],
                "applyError": "",
                "error": str(e),
            }

    def _clear_flatpak_task(self, task: asyncio.Task):
        if self._flatpak_task is task:
            self._flatpak_task = None

    async def check_and_apply_flatpak(self, auto_apply: bool) -> dict:
        """Check for flatpak updates and optionally apply them in one IPC call.

        A call that arrives while a run is in flight joins it and receives the
        same result, so a retried IPC call never gets an empty stand-in.
        """
        running = self._flatpak_task
        if running is not None and not running.done():
            decky.logger.info("Flatpak run already in progress, joining it")
            running_applies = self._flatpak_task_applies
            result = await asyncio.shield(running)
            if running_applies or not auto_apply:
                return result
            return await self.check_and_apply_flatpak(auto_apply)

        task = asyncio.create_task(self._flatpak_run(auto_apply))
        self._flatpak_task = task
        self._flatpak_task_applies = auto_apply
        task.add_done_callback(self._clear_flatpak_task)
        return await asyncio.shield(task)

    # --- SteamOS ---

    async def get_steamos_update_available(self) -> bool:
        return os.path.isfile("/usr/bin/steamos-update")

    @staticmethod
    def _steamos_result(*, success=False, hasUpdate=False, buildId="", needsReboot=False, error="") -> dict:
        return {"success": success, "hasUpdate": hasUpdate, "buildId": buildId, "needsReboot": needsReboot, "error": error}

    async def check_steamos_updates(self) -> dict:
        """Check for SteamOS updates using steamos-update check."""
        try:
            rc, stdout, stderr = await self._run_cmd(
                ["/usr/bin/steamos-update", "check"], timeout=60
            )

            # Exit 0 = update available (stdout contains build ID)
            # Exit 7 = no update available
            # Exit 8 = update already applied, reboot needed
            stderr_text = stderr.strip()
            if rc == 0:
                decky.logger.info(f"SteamOS update available: {stdout.strip()}")
                return self._steamos_result(success=True, hasUpdate=True, buildId=stdout.strip())
            elif rc == 7:
                self._debug("No SteamOS update available")
                return self._steamos_result(success=True)
            elif rc == 8:
                decky.logger.info("SteamOS update already staged, reboot needed")
                return self._steamos_result(success=True, needsReboot=True)
            else:
                decky.logger.error(f"steamos-update check failed (rc={rc}): {stderr_text}")
                return self._steamos_result(error=stderr_text or f"steamos-update check exited with code {rc}")
        except FileNotFoundError:
            return self._steamos_result(error="steamos-update not found")
        except Exception as e:
            decky.logger.error(f"Failed to check SteamOS updates: {e}")
            return self._steamos_result(error=str(e))

    @staticmethod
    def _clean_terminal_output(text: str) -> str:
        """Strip escape sequences and keep only the last carriage-return frame of each line."""
        text = TERMINAL_CSI.sub("", TERMINAL_OSC.sub("", text))
        lines = []
        for line in text.split("\n"):
            frames = [TERMINAL_CONTROL.sub("", frame) for frame in line.split("\r")]
            frames = [frame for frame in frames if frame.strip()]
            if frames:
                lines.append(frames[-1])
            elif not line:
                lines.append("")
        return "\n".join(lines).strip()

    def _clear_steamos_task(self, task: asyncio.Task):
        if self._steamos_task is task:
            self._steamos_task = None

    async def apply_steamos_update(self) -> dict:
        """Download and stage SteamOS update to inactive partition (no reboot).

        The GDBus interface rejects concurrent updates with 'one is already in
        progress', so a duplicate call joins the running update and receives
        its result instead of starting another process.
        """
        running = self._steamos_task
        if running is not None and not running.done():
            decky.logger.info("SteamOS update already in progress, joining it")
            return await asyncio.shield(running)

        task = asyncio.create_task(self._apply_steamos_update())
        self._steamos_task = task
        task.add_done_callback(self._clear_steamos_task)
        return await asyncio.shield(task)

    async def _apply_steamos_update(self) -> dict:
        try:
            rc, stdout, stderr = await self._run_cmd(
                ["/usr/bin/steamos-update"], timeout=600
            )
            if rc == 0:
                decky.logger.info("SteamOS update applied (reboot required to activate)")
            else:
                decky.logger.error(f"steamos-update failed (rc={rc}): {stderr.strip()[:500]}")
            return {
                "success": rc == 0,
                "stdout": self._clean_terminal_output(stdout),
                "stderr": self._clean_terminal_output(stderr),
                "returncode": rc,
            }
        except Exception as e:
            decky.logger.error(f"Failed to apply SteamOS update: {e}")
            return {"success": False, "stdout": "", "stderr": str(e), "returncode": -1}

    # --- Internals ---

    def _default_settings(self) -> dict:
        if self._defaults_cache is not None:
            return self._defaults_cache

        hardcoded = {
            "notificationLevel": "updates-only",
            "debugLogging": False,
            "logHistory": True,
            "maxHistoryEntries": 100,
            "steamEnabled": True,
            "steamCheckIntervalMinutes": 30,
            "flatpakEnabled": True,
            "flatpakCheckIntervalMinutes": 360,
            "flatpakAutoApply": True,
            "checkOnWake": True,
            "checkOnGameClose": True,
            "checkDuringGameplay": False,
            "deckyPluginUpdatesEnabled": False,
            "deckyCheckIntervalMinutes": 1440,
            "deckyPluginBlacklist": [],
            "deckyLoaderUpdateEnabled": False,
            "steamosUpdateEnabled": False,
            "steamosCheckIntervalMinutes": 1440,
            "interCheckDelayMs": 2000,
            "checkOrder": list(LIGHTEST_FIRST_ORDER),
        }
        defaults_path = os.path.join(
            decky.DECKY_PLUGIN_DIR, "defaults", SETTINGS_FILENAME
        )
        from_file = self._load_json(defaults_path, {})
        # Merge: file values override hardcoded, but missing keys get hardcoded defaults
        self._defaults_cache = {**hardcoded, **from_file}
        return self._defaults_cache

    def _load_json(self, path: str, fallback: dict | list) -> dict | list:
        try:
            with open(path, "r") as f:
                return json.load(f)
        except FileNotFoundError:
            pass
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            self._set_aside_corrupt(path, e)
        except Exception as e:
            decky.logger.error(f"Failed to read {path}: {e}")
        return fallback

    @staticmethod
    def _set_aside_corrupt(path: str, error: Exception):
        corrupt = f"{path}.corrupt"
        try:
            os.replace(path, corrupt)
            decky.logger.error(f"{path} is not valid JSON ({error}); moved to {corrupt}")
        except OSError as e:
            decky.logger.error(f"{path} is not valid JSON ({error}); could not move it aside: {e}")

    @staticmethod
    def _copy_owner_and_mode(tmp: str, path: str):
        try:
            existing = os.stat(path)
        except OSError:
            return
        try:
            os.chown(tmp, existing.st_uid, existing.st_gid)
            os.chmod(tmp, stat.S_IMODE(existing.st_mode))
        except OSError as e:
            decky.logger.warning(f"Could not copy owner/mode of {path} to its replacement: {e}")

    def _write_json(self, path: str, data: dict | list) -> bool:
        tmp = f"{path}.tmp"
        try:
            directory = os.path.dirname(path)
            if directory:
                os.makedirs(directory, exist_ok=True)
            with open(tmp, "w") as f:
                json.dump(data, f, indent=2)
                f.flush()
                os.fsync(f.fileno())
            self._copy_owner_and_mode(tmp, path)
            os.replace(tmp, path)
            return True
        except Exception as e:
            decky.logger.error(f"Failed to write {path}: {e}")
            try:
                os.remove(tmp)
            except OSError:
                pass
            return False
