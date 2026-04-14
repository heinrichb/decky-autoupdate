# AutoUpdate — Decky Plugin

## Session Handoff Protocol

This file is a living document. Keep it up to date throughout development.

- **Before asking the user to switch to Game Mode** (or any action that will break the remote session): update this file FIRST with the current task state, what was changed, what to test, and what to do with the results. Do this automatically — do not wait to be asked.
- **At the start of each session**: read this file to understand where we left off. Act on whatever is here without the user needing to re-explain.
- **After completing a task**: clean up the "Current Task" section. Remove stale handoff notes. Keep architecture notes and git workflow permanent.
- **General rule**: anything a future agent needs to know to continue work without re-exploring the codebase should be written here before the session ends.

---

## Current Task

**Milestone C (reliability + new update sources)**: Deployed to `feature/decky-plugin-updates` branch 2026-04-12. Changes:

### Reliability fixes:
- Timer reset after wake (`rebuildPeriodicTimers()` called after wake handler completes)
- Initial startup check (10s delayed `handleStartupCheck()` on `start()`)
- `EnableAllDownloads()` called before per-app `ResumeAppUpdate` in `forceStartAllUpdates()`
- Post-force recheck: 3s delay then re-enumerate to report accurate status
- Flatpak appstream metadata refresh before `remote-ls --updates`
- Default flatpak interval lowered from 12h to 6h
- Startup check respects `checkDuringGameplay` setting

### New features:
- **Decky Loader self-update**: opt-in (`deckyLoaderUpdateEnabled`, default OFF). Uses `updater/get_version`, `updater/check_for_updates`, `updater/do_update` WebSocket routes. Auto-applies when update found.
- **SteamOS auto-update**: opt-in (`steamosUpdateEnabled`, default OFF). Uses `steamos-update check` (exit 0=available, 7=none, 8=already staged) and `steamos-update` (downloads+stages to inactive A/B partition). Never forces reboot. Configurable interval (`steamosCheckIntervalMinutes`, default 24h).

### Previous milestones:
- **Milestone A (game-aware checks)**: Deployed to develop 2026-04-10
- **Milestone B (Decky plugin auto-updates)**: Implemented on `feature/decky-plugin-updates`

## Architecture notes
- **Wake detection**: Uses `SteamClient.System.RegisterForOnResumeFromSuspend` (same as SDH-PauseGames, decky-autosuspend). Heartbeat polling is fallback only.
- **Service singleton**: `src/autoUpdateService.ts` — all background logic runs at plugin level via `definePlugin()`, not React hooks
- **React UI**: Pure subscriber via `service.subscribe()` — no timers, no background logic
- **Steam updates**: Frontend-driven (SteamClient is a JS global in CEF context)
- **Flatpak updates**: Python backend via `callable` (Decky IPC). Auto-detects user vs system scope via `_detect_flatpak_scope()`. User-level (common on SteamOS) runs via `runuser -u deck -- flatpak --user` with `_deck_env()`. System-level runs `flatpak --system` directly.
- **Subprocess env**: `_minimal_env()` builds a clean env from scratch (PATH, XDG_RUNTIME_DIR, LANG only). `_deck_env()` adds HOME for user-level flatpak access. Never copy os.environ — Steam runtime pollution causes hangs.
- **Settings validation**: Python `_validate_settings()` handles type coercion (int/float, bool vs int), clamping, migration. Frontend merges with `DEFAULT_SETTINGS` as safety net.
- **Shared helpers**: `src/helpers.ts` — `formatUpdateSummary`, `combinedToastBody`, `sourceLabel`, `triggerLabel`, `errorMessage`
- **Shared types**: `src/types.ts` — `FlatpakStatus`, `Trigger`, `emptyResult()` factory
- **Toast policy**: Only show toasts when actual updates are found. No "up to date" or "resuming from sleep" toasts.
- **History policy**: Only log entries when pendingCount > 0 or forcedCount > 0. Color-coded in UI.
- **Deploy path**: `/home/deck/homebrew/plugins/AutoUpdate/` (NOT `decky-autoupdate/`)

## Testing
- Format check: `pnpm format:check`
- Build: `pnpm run build`
- TypeScript tests: `pnpm test:ts` (69 tests)
- Python tests: `pnpm test:py` or `python3 -m unittest discover tests -v` (53 tests)
- All at once: `pnpm test`

## Debugging
- Check `journalctl -u plugin_loader` for Python backend errors
- CEF remote debugger (chrome://inspect) — look for `[AutoUpdate]` in console
- Wake detection logs its method on startup: "SteamClient.System.RegisterForOnResumeFromSuspend" or "falling back to heartbeat polling"

## Git workflow
- Work happens on `develop` branch
- Commits per milestone on develop, merge to main when ready
- Auto-release pipeline handles version bumps, changelog updates, and tagging on merge to main
