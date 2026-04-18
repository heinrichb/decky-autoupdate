# AutoUpdate - Decky Plugin

## Session Handoff Protocol

This file is a living document. Keep it up to date throughout development.

- **Before asking the user to switch to Game Mode** (or any action that will break the remote session): update this file FIRST with the current task state, what was changed, what to test, and what to do with the results. Do this automatically - do not wait to be asked.
- **At the start of each session**: read this file to understand where we left off. Act on whatever is here without the user needing to re-explain.
- **After completing a task**: clean up the "Current Task" section. Remove stale handoff notes. Keep architecture notes and git workflow permanent.
- **General rule**: anything a future agent needs to know to continue work without re-exploring the codebase should be written here before the session ends.

---

## Current Task

**Milestone D (bug fixes + UI polish)**: Deployed 2026-04-14, user is monitoring over longer periods.

### Changes in this milestone:
1. **Flatpak partial-scope failure**: `check_and_apply_flatpak` no longer blocks apply when one scope's check fails but updates exist. Frontend prioritizes apply errors over check errors (`providers.ts:83-88`).
2. **Stale-instance IPC retry**: `callDeckyMethod` in `deckyApi.ts` retries once (2s delay) when Decky's WS router closes the connection due to stale plugin instance. This is the most impactful fix - was causing all flatpak calls to fail after plugin reloads.
3. **Steam count mismatch**: `forceStartAllUpdates` recheck uses `Math.max(pending.length, recheck.length)` for `pendingCount` so "applied X of Y" never shows Y < X (`steamClient.ts:298`).
4. **Wake delay**: 8s delay in `handleWake` before running checks, letting Steam's download manager re-initialize (`autoUpdateService.ts:349-350`).
5. **Loading spinner**: Animated CSS spinner on all check buttons using Web Animations API (CSS @keyframes don't work in Steam CEF). `Spinner` and `StatusButton` components in `index.tsx`.

### Previous milestones:
- **Milestone C (reliability + new update sources)**: Deployed 2026-04-12
- **Milestone B (Decky plugin auto-updates)**: Implemented on `feature/decky-plugin-updates`
- **Milestone A (game-aware checks)**: Deployed to develop 2026-04-10

## Architecture notes
- **Wake detection**: Uses `SteamClient.System.RegisterForOnResumeFromSuspend` (same as SDH-PauseGames, decky-autosuspend). Heartbeat polling is fallback only.
- **Service singleton**: `src/autoUpdateService.ts` - all background logic runs at plugin level via `definePlugin()`, not React hooks
- **React UI**: Pure subscriber via `service.subscribe()` - no timers, no background logic
- **Steam updates**: Frontend-driven (SteamClient is a JS global in CEF context)
- **Flatpak updates**: Python backend via `callable` (Decky IPC). Auto-detects **all active scopes** via `_detect_flatpak_scopes()` - returns a list like `["user", "system"]` when both have installed apps. Check and apply iterate over all scopes so no updates are missed. User-level runs via `runuser -u deck -- flatpak --user` with `_deck_env()`. System-level runs `flatpak --system` directly.
- **Subprocess env**: `_minimal_env()` builds a clean env from scratch (PATH, XDG_RUNTIME_DIR, LANG only). `_deck_env()` adds HOME for user-level flatpak access. Never copy os.environ - Steam runtime pollution causes hangs.
- **Settings validation**: Python `_validate_settings()` handles type coercion (int/float, bool vs int), clamping, migration. Frontend merges with `DEFAULT_SETTINGS` as safety net.
- **Shared helpers**: `src/helpers.ts` - `formatUpdateSummary`, `combinedToastBody`, `sourceLabel`, `triggerLabel`, `errorMessage`
- **Shared types**: `src/types.ts` - `FlatpakStatus`, `Trigger`, `emptyResult()` factory
- **Toast policy**: Only show toasts when actual updates are found. No "up to date" or "resuming from sleep" toasts.
- **History policy**: Only log entries when pendingCount > 0 or forcedCount > 0. Color-coded in UI.
- **Deploy path**: `/home/deck/homebrew/plugins/AutoUpdate/` (NOT `decky-autoupdate/`)

## Testing
- Format check: `pnpm format:check`
- Build: `pnpm run build`
- TypeScript tests: `pnpm test:ts` (133 tests)
- Python tests: `pnpm test:py` or `python3 -m unittest discover tests -v` (53 tests)
- All at once: `pnpm test`

## Debugging
- **Always check plugin logs first**: `~/homebrew/logs/AutoUpdate/` - the backend logs all commands, env keys, return codes, stdout/stderr. Read these before speculating about what's wrong.
- `journalctl -u plugin_loader` for Python backend errors
- CEF remote debugger (chrome://inspect) - look for `[AutoUpdate]` in console
- Wake detection logs its method on startup: "SteamClient.System.RegisterForOnResumeFromSuspend" or "falling back to heartbeat polling"

## Git workflow
- Work happens on `develop` branch
- Commits per milestone on develop, merge to main when ready
- Auto-release pipeline handles version bumps, changelog updates, and tagging on merge to main
