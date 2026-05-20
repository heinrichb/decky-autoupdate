# AutoUpdate - Decky Plugin

## Session Handoff Protocol

This file is a living document. Keep it up to date throughout development.

- **Before asking the user to switch to Game Mode** (or any action that will break the remote session): update this file FIRST with the current task state, what was changed, what to test, and what to do with the results. Do this automatically - do not wait to be asked.
- **At the start of each session**: read this file to understand where we left off. Act on whatever is here without the user needing to re-explain.
- **After completing a task**: clean up the "Current Task" section. Remove stale handoff notes. Keep architecture notes and git workflow permanent.
- **General rule**: anything a future agent needs to know to continue work without re-exploring the codebase should be written here before the session ends.

---

## Current Task

**Milestone E (post-Steam-update fixes)**: Deployed 2026-05-15.

### Changes in this milestone:
1. **Version injection at build time**: `rollup.config.js` uses `@rollup/plugin-replace` to inject `__PLUGIN_VERSION__` from `package.json`. New `src/version.ts` exposes `PLUGIN_VERSION`. Backend reads version from `plugin.json` / `package.json` at startup.
2. **Startup logging**: Plugin version, debug state, Decky Loader version, wake/game detection methods all logged at info level so post-deploy you can confirm exactly what's running. Backend log line: `AutoUpdate v{version} loaded | debug={ON|OFF} | settings={path}`.
3. **`trace` log level**: New `trace()` in `helpers.ts` — same gate as `debug` but CEF-console-only, never IPC'd. The 5 per-IPC-call lifecycle logs in `deckyApi.ts` converted to `trace`, breaking a 5x logging cascade that was saturating the Decky WS channel and causing apparent "stuck" states for minutes at a time.
4. **Decky Loader version**: Read directly from `/home/deck/homebrew/services/.loader.version` via new backend `get_decky_version` IPC. Decky's `updater/get_version` route returns an error on current builds.
5. **Decky plugin install retry + payload shape**: Wrapped `installPluginsAndConfirm` in a retry-once layer for WS-closed-before-confirmation. New `extractRequestId()` handles current Decky's payload shape where `msg.args[0]` is the request_id string directly (not `msg.args[0].request_id` as before).
6. **Source-specific verb in update summary**: `helpers.ts` `actionVerb()` returns "started" for steam (we trigger a download, Steam runs it async), "applied" for flatpak/decky (we ran the install), "staged" for steamos (needs reboot), "updated" for decky-loader. Tests in `helpers.test.ts` cover the steam/steamos cases.
7. **Steam: accurate forced count**: `forceStartUpdate` no longer counts items where "we called the API without throwing" — `forceStartAllUpdates` now reports `forcedCount` = items that actually transitioned out of scheduled. Was reporting "19 of 19 applied" when 16 were still stuck.
8. **Steam scheduled→queued**: Tried 8+ Downloads/Apps APIs (`SetQueueIndex`, `MoveAppUpdateUp`, `QueueAppUpdate`, `Pause`/`Resume`, `SetAppAutoUpdateBehavior`, `SetAppBackgroundDownloadsBehavior`, `SuspendDownloadThrottling`, `EnableAllDownloads`). All succeed but leave `deferred_time` and `queue_index` unchanged. See "Known Steam API regression" section below.
9. **UI**: "Steam" → "Steam Apps" label (ambiguous now that SteamOS is a separate category). Diagnostics dump button + version display at bottom of Advanced section.

### Previous milestones:
- **Milestone D (bug fixes + UI polish)**: Deployed 2026-04-14
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
- **Version is logged at startup** (backend + frontend) — confirm you're looking at the build you just deployed
- **Diagnostics dump button** in the Advanced section produces a complete state snapshot (version, settings, availability, last check per source, history count, Decky Loader version) — copy to clipboard for sharing

## Log levels and `trace` vs `debug`
- `log`, `logWarn`, `logError` (`helpers.ts`): always emit, also IPC'd to the backend `.log` file via `log_frontend_message`. Use for events the user might need to see.
- `debug` (`helpers.ts`): gated by `debugLogging` setting, IPC'd to backend when enabled. Use for one-shot lifecycle diagnostics.
- `trace` (`helpers.ts`): gated by `debugLogging`, CEF-console-only — **never** crosses IPC. Use for high-frequency events (per-IPC-call tracing, per-event-callback). Sending these through IPC caused a 5x cascade (each log was itself an IPC call generating 4 more logs) that saturated the WS channel and made legitimate calls hang for minutes. `callDeckyMethod` internal lifecycle logs are `trace`, not `debug`, for this reason.

## Steam pending-updates filter: match the user's Library UI exactly
SteamClient's `RegisterForDownloadItems` is over-permissive — it returns every
owned app with `update_type_info[0].has_update === true`, including:

- Owned games that aren't installed locally (no `appmanifest_*.acf`)
- System runtimes (e.g. Steam Linux Runtime 2.0) where Steam keeps the
  has_update flag set even when `buildid == TargetBuildID`
- Stale entries with `BytesToDownload == 0`

Steam's user-facing queue UI filters by manifest `StateFlags & 6 == 6`
(`FullyInstalled` bit + `UpdateRequired` bit). The plugin mirrors this:

1. `getPendingUpdates()` in `steamClient.ts` calls backend
   `get_app_state_flags_batch(appIds)` which reads each app's manifest from
   the library folders listed in `libraryfolders.vdf`.
2. Items with no local manifest (`flags == -1`) or `StateFlags & 6 != 6`
   are excluded with a debug log line citing the reason.
3. If the backend lookup fails, the plugin degrades to the loose filter so
   nothing breaks — pending count just won't match Steam's UI exactly.

This is the contract that keeps phantom items from messing with force-start
counts, toasts, and history. Any new "Steam reports has_update but item
isn't actually queued" scenario should hit this filter automatically.

If you see a pending count that doesn't match the Steam Library UI, dump
`SteamClient.Downloads.RegisterForDownloadItems`'s output and look for items
where `(StateFlags & 6) != 6` — that's almost always the culprit.

## Cleaning up half-installed cruft
Stale partial downloads accumulate in `steamapps/downloading/` (across all
Steam libraries in `libraryfolders.vdf`) as `.delta` files and per-appid
subdirs. Steam doesn't garbage-collect these on its own. Safe to remove
the contents at any time — Steam will re-download what it needs.

Orphan Wine prefixes for uninstalled games live at
`steamapps/compatdata/<appid>/`. These may contain save files; only remove
if Steam Cloud has the saves OR the user explicitly says.

## SteamClient.Downloads.* — the two-arg contract (load-bearing)

All mutating methods on `SteamClient.Downloads` take a `remoteClientId: string`
as their **last** argument. Pass `"0"` for the local Steam client. **Calls
made without the second arg silently no-op** — no exception, no error, no
log line. This is the single most painful gotcha in the API; if you observe
"the call ran but state didn't change", check the arity first.

Verified call signatures (Steam build ~1778921000, May 2026):

```
ResumeAppUpdate(appId, remoteClientId)
PauseAppUpdate(appId, remoteClientId)
QueueAppUpdate(appId, remoteClientId)
MoveAppUpdateUp(appId, remoteClientId)
MoveAppUpdateDown(appId, remoteClientId)
SetQueueIndex(appId, index, remoteClientId)       // 3-arg form
RemoveFromDownloadList(appId, remoteClientId)
EnableAllDownloads(enable, remoteClientId)
SuspendDownloadThrottling(suspend, remoteClientId)
SuspendLanPeerContent(suspend, remoteClientId)
SetLaunchOnUpdateComplete(appIdOrLaunchCode)      // 1-arg exception
```

Working force-start recipe for an item stuck in `scheduled` state:

```ts
const LOCAL = "0";
SteamClient.Apps.SetAppAutoUpdateBehavior(appId, 0);     // "always update"
SteamClient.Downloads.QueueAppUpdate(appId, LOCAL);      // clear scheduled state
SteamClient.Downloads.ResumeAppUpdate(appId, LOCAL);     // start the download
```

The recipe is in `src/steamClient.ts` `forceStartUpdate()`. Discovered via
reading the Steam UI bundle (`/home/deck/.local/share/Steam/steamui/chunk~*.js`)
where every call site of these methods passes `h.hj.CurrentViewingRemoteClientID`
as the second arg, and the local-self constant `n.O` resolves to the string `"0"`.

Full reference: `workspaces/general/docs/reference/steam/cef-api.md`.

## Git workflow
- Work happens on `develop` branch
- Commits per milestone on develop, merge to main when ready
- Auto-release pipeline handles version bumps, changelog updates, and tagging on merge to main
