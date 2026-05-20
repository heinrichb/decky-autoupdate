import os
import asyncio
import json
import time
import decky

SETTINGS_FILENAME = "settings.json"
HISTORY_FILENAME = "history.json"


APPSTREAM_REFRESH_INTERVAL = 6 * 3600  # 6 hours


class Plugin:
    settings: dict = {}
    settings_path: str = ""
    history_path: str = ""
    _defaults_cache: dict | None = None
    _last_appstream_refresh: float = 0
    _history_lock: asyncio.Lock | None = None
    _flatpak_lock: asyncio.Lock | None = None
    _steamos_lock: asyncio.Lock | None = None
    _flatpak_scopes: list[str] | None = None  # ["user"], ["system"], or ["user", "system"]

    async def _main(self):
        self._history_lock = asyncio.Lock()
        self._flatpak_lock = asyncio.Lock()
        self._steamos_lock = asyncio.Lock()
        self.settings_path = os.path.join(
            decky.DECKY_PLUGIN_SETTINGS_DIR, SETTINGS_FILENAME
        )
        self.history_path = os.path.join(
            decky.DECKY_PLUGIN_SETTINGS_DIR, HISTORY_FILENAME
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
        valid_sources = {"steam", "flatpak", "decky", "decky-loader", "steamos"}
        raw_order = validated.get("checkOrder", defaults["checkOrder"])
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
        self._debug("ping received")
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

    async def log_frontend_message(self, level: str, message: str) -> bool:
        """Write a frontend log message to the plugin log file."""
        if not isinstance(message, str):
            return False
        if len(message) > 2000:
            message = message[:2000] + "...(truncated)"
        tag = "[Frontend]"
        if level == "error":
            decky.logger.error(f"{tag} {message}")
        elif level == "warn":
            decky.logger.warning(f"{tag} {message}")
        elif level == "debug":
            self._debug(f"{tag} {message}")
        else:
            decky.logger.info(f"{tag} {message}")
        return True

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

    async def _run_cmd(self, argv: list[str], timeout: int = 120, env: dict[str, str] | None = None) -> tuple[int, str, str]:
        """Run a command and return (returncode, stdout, stderr)."""
        cmd_str = ' '.join(argv)
        decky.logger.info(f"Running: {cmd_str}")
        used_env = env or Plugin._minimal_env()
        self._debug(f"timeout={timeout}s, env={list(used_env.keys())}")
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=used_env,
        )
        self._debug(f"Process started: pid={proc.pid}")
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            decky.logger.error(f"Timed out after {timeout}s: {cmd_str}")
            return -1, "", f"{argv[0]} timed out after {timeout}s"
        rc = proc.returncode
        out_text = stdout.decode()
        err_text = stderr.decode()
        decky.logger.info(f"Completed (rc={rc}): {cmd_str}")
        if err_text.strip():
            decky.logger.info(f"  stderr: {err_text.strip()[:500]}")
        self._debug(f"stdout ({len(out_text)} chars): {out_text.strip()[:200]}")
        return rc, out_text, err_text

    # --- Flatpak ---

    async def get_flatpak_available(self) -> bool:
        return os.path.isfile("/usr/bin/flatpak")

    async def _detect_flatpak_scopes(self) -> list[str]:
        """Detect which flatpak scopes have installed apps.

        Returns a list of active scopes, e.g. ["user", "system"] or ["user"].
        Both scopes are checked so updates are never missed.
        """
        if self._flatpak_scopes is not None:
            self._debug(f"Flatpak scopes cached: {self._flatpak_scopes}")
            return self._flatpak_scopes
        self._debug("Detecting flatpak scopes...")

        async def _count_user() -> int:
            try:
                rc, stdout, _ = await self._run_cmd(
                    ["/usr/bin/runuser", "-u", "deck", "--",
                     "/usr/bin/flatpak", "--user", "list", "--app", "--columns=application"],
                    timeout=15, env=Plugin._deck_env(),
                )
                return len(stdout.strip().splitlines()) if rc == 0 and stdout.strip() else 0
            except Exception as e:
                decky.logger.warning(f"Failed to count user flatpaks: {e}")
                return 0

        async def _count_system() -> int:
            try:
                rc, stdout, _ = await self._run_cmd(
                    ["/usr/bin/flatpak", "--system", "list", "--app", "--columns=application"],
                    timeout=15,
                )
                return len(stdout.strip().splitlines()) if rc == 0 and stdout.strip() else 0
            except Exception as e:
                decky.logger.warning(f"Failed to count system flatpaks: {e}")
                return 0

        user_count, system_count = await asyncio.gather(_count_user(), _count_system())

        scopes = []
        if user_count > 0:
            scopes.append("user")
        if system_count > 0:
            scopes.append("system")
        if not scopes:
            scopes.append("user")

        self._flatpak_scopes = scopes
        decky.logger.info(
            f"Flatpak scopes detected: {self._flatpak_scopes} "
            f"(user={user_count}, system={system_count})"
        )
        return self._flatpak_scopes

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

    async def check_flatpak_updates(self) -> dict:
        """List available flatpak updates across all active scopes."""
        self._debug("check_flatpak_updates called")
        try:
            scopes = await self._detect_flatpak_scopes()

            # Refresh appstream metadata if stale (throttled to once per 6 hours)
            now = time.monotonic()
            if now - self._last_appstream_refresh > APPSTREAM_REFRESH_INTERVAL:
                for scope in scopes:
                    try:
                        await self._run_flatpak(scope, ["update", "--appstream", "--noninteractive"], timeout=30)
                    except Exception as e:
                        decky.logger.warning(f"Appstream refresh failed for {scope} (non-critical): {e}")
                self._last_appstream_refresh = now

            updates = []
            errors = []
            for scope in scopes:
                rc, stdout, stderr = await self._run_flatpak(
                    scope, ["remote-ls", "--updates", "--columns=application:f,name:f,download-size:f"]
                )
                if rc != 0:
                    decky.logger.error(f"flatpak remote-ls --{scope} failed (rc={rc}): {stderr}")
                    errors.append(stderr or f"flatpak --{scope} exited with code {rc}")
                    continue
                for line in stdout.strip().splitlines():
                    parts = line.split("\t")
                    if len(parts) >= 2:
                        updates.append({
                            "id": parts[0].strip(),
                            "name": parts[1].strip(),
                            "downloadSize": parts[2].strip() if len(parts) >= 3 else "",
                            "scope": scope,
                        })

            decky.logger.info(f"Flatpak check complete: {len(updates)} update(s) found")
            if updates:
                names = ", ".join(u["name"] for u in updates[:10])
                decky.logger.info(f"  Updates: {names}")

            return {"success": len(errors) == 0, "updates": updates, "error": "; ".join(errors)}
        except Exception as e:
            decky.logger.error(f"Failed to check flatpak updates: {e}")
            return {"success": False, "updates": [], "error": str(e)}

    async def apply_flatpak_updates(self) -> dict:
        """Apply all available flatpak updates across all active scopes."""
        self._debug("apply_flatpak_updates called")
        try:
            scopes = await self._detect_flatpak_scopes()
            all_stdout, all_stderr = [], []
            failed = False

            for scope in scopes:
                rc, stdout, stderr = await self._run_flatpak(scope, ["update", "--noninteractive"], timeout=600)
                if rc == 0:
                    decky.logger.info(f"Flatpak --{scope} updates applied successfully")
                else:
                    decky.logger.error(f"Flatpak --{scope} update failed (rc={rc}): {stderr[:500]}")
                    failed = True
                all_stdout.append(stdout)
                all_stderr.append(stderr)

            return {
                "success": not failed,
                "stdout": "\n".join(all_stdout),
                "stderr": "\n".join(all_stderr),
                "returncode": 1 if failed else 0,
            }
        except Exception as e:
            decky.logger.error(f"Failed to apply flatpak updates: {e}")
            return {
                "success": False,
                "stdout": "",
                "stderr": str(e),
                "returncode": -1,
            }

    async def check_and_apply_flatpak(self, auto_apply: bool) -> dict:
        """Check for flatpak updates and optionally apply them in one IPC call.

        Uses a lock to prevent duplicate concurrent operations when the
        frontend reloads and both old/new instances call simultaneously.
        """
        self._debug(f"check_and_apply_flatpak called (auto_apply={auto_apply})")
        if self._flatpak_lock is None:
            self._flatpak_lock = asyncio.Lock()
        if self._flatpak_lock.locked():
            decky.logger.info("Flatpak operation already in progress, skipping duplicate call")
            return {"success": True, "updates": [], "error": "", "applied": False, "applyError": ""}

        async with self._flatpak_lock:
            check = await self.check_flatpak_updates()
            if not auto_apply or not check["updates"]:
                self._debug(f"check_and_apply_flatpak returning without apply (auto_apply={auto_apply}, updates={len(check['updates'])})")
                return {**check, "applied": False, "applyError": ""}

            decky.logger.info(f"Auto-applying {len(check['updates'])} flatpak update(s)")
            apply = await self.apply_flatpak_updates()
            return {
                **check,
                "applied": apply["success"],
                "applyError": apply["stderr"] if not apply["success"] else "",
            }

    # --- SteamOS ---

    async def get_steamos_update_available(self) -> bool:
        return os.path.isfile("/usr/bin/steamos-update")

    @staticmethod
    def _steamos_result(*, success=False, hasUpdate=False, buildId="", needsReboot=False, error="") -> dict:
        return {"success": success, "hasUpdate": hasUpdate, "buildId": buildId, "needsReboot": needsReboot, "error": error}

    async def check_steamos_updates(self) -> dict:
        """Check for SteamOS updates using steamos-update check."""
        self._debug("check_steamos_updates called")
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

    async def apply_steamos_update(self) -> dict:
        """Download and stage SteamOS update to inactive partition (no reboot).

        Uses a lock to prevent duplicate concurrent steamos-update processes.
        The GDBus interface rejects concurrent updates with 'one is already in
        progress', so we skip the call entirely if another is running.
        """
        self._debug("apply_steamos_update called")
        if self._steamos_lock is None:
            self._steamos_lock = asyncio.Lock()
        if self._steamos_lock.locked():
            decky.logger.info("SteamOS update already in progress, skipping duplicate call")
            return {"success": True, "stdout": "Skipped: already in progress", "stderr": "", "returncode": 0}

        async with self._steamos_lock:
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
                    "stdout": stdout,
                    "stderr": stderr,
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
            "checkOrder": ["steamos", "decky-loader", "decky", "flatpak", "steam"],
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
        except Exception as e:
            decky.logger.error(f"Failed to read {path}: {e}")
        return fallback

    def _write_json(self, path: str, data: dict | list) -> bool:
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as f:
                json.dump(data, f, indent=2)
            return True
        except Exception as e:
            decky.logger.error(f"Failed to write {path}: {e}")
            return False
