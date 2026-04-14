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
    _flatpak_scope: str | None = None  # "user", "system", or None (not yet detected)

    async def _main(self):
        self._history_lock = asyncio.Lock()
        self.settings_path = os.path.join(
            decky.DECKY_PLUGIN_SETTINGS_DIR, SETTINGS_FILENAME
        )
        self.history_path = os.path.join(
            decky.DECKY_PLUGIN_SETTINGS_DIR, HISTORY_FILENAME
        )
        self.settings = self._validate_settings(self._load_json(
            self.settings_path, self._default_settings()
        ))
        decky.logger.info("AutoUpdate loaded")

    async def _unload(self):
        decky.logger.info("AutoUpdate unloaded")

    async def _uninstall(self):
        decky.logger.info("AutoUpdate uninstalled")

    # ── Settings ────────────────────────────────────────────

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

        # ── Migrations ──
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
        return validated

    # ── History ─────────────────────────────────────────────

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

    async def ping(self) -> bool:
        """Fast IPC health check — returns immediately."""
        self._debug("ping received")
        return True

    # ── Subprocess helpers ──────────────────────────────────

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

        Never copy os.environ — Steam runtime pollution causes hangs.
        """
        uid, _ = Plugin._deck_user_info()
        return {
            "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "XDG_RUNTIME_DIR": f"/run/user/{uid}",
            "LANG": os.environ.get("LANG", "en_US.UTF-8"),
        }

    @staticmethod
    def _deck_env() -> dict[str, str]:
        """Minimal env plus HOME for user-level flatpak access."""
        env = Plugin._minimal_env()
        _, home = Plugin._deck_user_info()
        env["HOME"] = home
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

    # ── Flatpak ─────────────────────────────────────────────

    async def get_flatpak_available(self) -> bool:
        return os.path.isfile("/usr/bin/flatpak")

    async def _detect_flatpak_scope(self) -> str:
        """Detect whether flatpaks are installed at user or system level.

        Returns "user" or "system". Checks user-level first (as deck user)
        since that's the common case on SteamOS when apps are installed via
        desktop mode or Discover.
        """
        if self._flatpak_scope is not None:
            self._debug(f"Flatpak scope cached: {self._flatpak_scope}")
            return self._flatpak_scope
        self._debug("Detecting flatpak scope...")

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

        if user_count >= system_count:
            self._flatpak_scope = "user"
        else:
            self._flatpak_scope = "system"

        decky.logger.info(
            f"Flatpak scope detected: {self._flatpak_scope} "
            f"(user={user_count}, system={system_count})"
        )
        return self._flatpak_scope

    async def _run_flatpak(self, flatpak_args: list[str], timeout: int = 120) -> tuple[int, str, str]:
        """Run a flatpak command targeting the detected installation scope.

        For user-level: runs via runuser as the deck user with --user flag.
        For system-level: runs directly as root.
        """
        scope = await self._detect_flatpak_scope()

        if scope == "user":
            argv = [
                "/usr/bin/runuser", "-u", "deck", "--",
                "/usr/bin/flatpak", "--user",
            ] + flatpak_args
            env = Plugin._deck_env()
        else:
            argv = ["/usr/bin/flatpak", "--system"] + flatpak_args
            env = Plugin._minimal_env()

        return await self._run_cmd(argv, timeout, env=env)

    async def check_flatpak_updates(self) -> dict:
        """List available flatpak updates without applying them."""
        self._debug("check_flatpak_updates called")
        try:

            # Refresh appstream metadata if stale (throttled to once per 6 hours)
            now = time.monotonic()
            if now - self._last_appstream_refresh > APPSTREAM_REFRESH_INTERVAL:
                try:
                    await self._run_flatpak(["update", "--appstream", "--noninteractive"], timeout=30)
                    self._last_appstream_refresh = now
                except Exception as e:
                    decky.logger.warning(f"Appstream refresh failed (non-critical): {e}")

            rc, stdout, stderr = await self._run_flatpak(
                ["remote-ls", "--updates", "--columns=application:f,name:f,download-size:f"]
            )

            if rc != 0:
                decky.logger.error(f"flatpak remote-ls failed (rc={rc}): {stderr}")
                return {"success": False, "updates": [], "error": stderr or f"flatpak exited with code {rc}"}

            updates = []
            for line in stdout.strip().splitlines():
                parts = line.split("\t")
                if len(parts) >= 2:
                    updates.append({
                        "id": parts[0].strip(),
                        "name": parts[1].strip(),
                        "downloadSize": parts[2].strip() if len(parts) >= 3 else "",
                    })

            decky.logger.info(f"Flatpak check complete: {len(updates)} update(s) found")
            if updates:
                names = ", ".join(u["name"] for u in updates[:10])
                decky.logger.info(f"  Updates: {names}")

            return {"success": True, "updates": updates, "error": ""}
        except Exception as e:
            decky.logger.error(f"Failed to check flatpak updates: {e}")
            return {"success": False, "updates": [], "error": str(e)}

    async def apply_flatpak_updates(self) -> dict:
        """Apply all available flatpak updates."""
        try:
            rc, stdout, stderr = await self._run_flatpak(["update", "--noninteractive"], timeout=600)
            if rc == 0:
                decky.logger.info("Flatpak updates applied successfully")
            else:
                decky.logger.error(f"Flatpak update failed (rc={rc}): {stderr[:500]}")
            return {
                "success": rc == 0,
                "stdout": stdout,
                "stderr": stderr,
                "returncode": rc,
            }
        except Exception as e:
            decky.logger.error(f"Failed to apply flatpak updates: {e}")
            return {
                "success": False,
                "stdout": "",
                "stderr": str(e),
                "returncode": -1,
            }

    # ── SteamOS ─────────────────────────────────────────────

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
            if stderr_text:
                decky.logger.warning(f"steamos-update stderr: {stderr_text}")
            if rc == 0:
                return self._steamos_result(success=True, hasUpdate=True, buildId=stdout.strip())
            elif rc == 7:
                return self._steamos_result(success=True)
            elif rc == 8:
                return self._steamos_result(success=True, needsReboot=True)
            else:
                return self._steamos_result(error=stderr_text or f"steamos-update check exited with code {rc}")
        except FileNotFoundError:
            return self._steamos_result(error="steamos-update not found")
        except Exception as e:
            decky.logger.error(f"Failed to check SteamOS updates: {e}")
            return self._steamos_result(error=str(e))

    async def apply_steamos_update(self) -> dict:
        """Download and stage SteamOS update to inactive partition (no reboot)."""
        try:
            rc, stdout, stderr = await self._run_cmd(
                ["/usr/bin/steamos-update"], timeout=600
            )
            return {
                "success": rc == 0,
                "stdout": stdout,
                "stderr": stderr,
                "returncode": rc,
            }
        except Exception as e:
            decky.logger.error(f"Failed to apply SteamOS update: {e}")
            return {"success": False, "stdout": "", "stderr": str(e), "returncode": -1}

    # ── Internals ───────────────────────────────────────────

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
