# AutoUpdate - Decky Plugin

## Session Handoff Protocol

This file is a living document. Keep it up to date throughout development.

- **Before asking the user to switch to Game Mode** (or any action that will break the remote session): update this file FIRST with the current task state, what was changed, what to test, and what to do with the results. Do this automatically - do not wait to be asked.
- **At the start of each session**: read this file to understand where we left off. Act on whatever is here without the user needing to re-explain.
- **After completing a task**: clean up the "Current Task" section. Remove stale handoff notes. Keep architecture notes and git workflow permanent.
- **General rule**: anything a future agent needs to know to continue work without re-exploring the codebase should be written here before the session ends.

---

## Current Task

**Milestone G (speed, reliability, QAM redesign)**: deployed 2026-10-02 16:16 and verified on device in Big Picture
over CEF: no horizontal shift (`scrollLeft` stays 0 across every row, `scrollWidth` 300), Check All shows
"Checking N of M", startup and manual batches run with no WS-closed retries and no `Dropping message` lines, the Flatpak
check is ~0.75-1.2 s and reports `0 update(s), 1 masked` with no `flatpak update`, Decky Loader check ~0.3 s. The
follow-up commit (history labels wrap, count moved to the description; default pause 0.5 s; JSON files take the
settings directory owner) was redeployed at 16:22 and verified: last check state restored after the reload, the
startup check ran Steam only (others not due) in 89 ms, `check_state.json` is deck-owned, history labels wrap.

Still to verify on device:
1. Open the QAM panel in Game Mode or Big Picture: no 10 px horizontal shift when the D-pad reaches the status rows;
   every row fits; Check All shows "Checking N of M".
2. Plugin log after a reload shows `Wake detection: registered User.RegisterForResumeSuspendedGamesProgress`,
   `Restored last check state`, frontend lines prefixed with their event time, and no `WS-closed` retries.
3. A Flatpak check returns `masked: [com.nvidia.geforcenow/...]` and runs no `flatpak update` (that ref is masked on
   this Deck).
4. After a sleep/wake: one batch per wake (`wake coalesced state=N` for the extra callbacks), Steam first, and only
   sources whose interval has elapsed.
5. When a Decky plugin update appears: `Auto-confirmed install request` followed by the plugin's download-finish
   event, and no Decky confirmation modal.

### Previous milestones:
- **Milestone F (scheduled-state force-start)**: Deployed 2026-05-20
- **Milestone E (post-Steam-update fixes)**: Deployed 2026-05-15
- **Milestone D (bug fixes + UI polish)**: Deployed 2026-04-14
- **Milestone C (reliability + new update sources)**: Deployed 2026-04-12
- **Milestone B (Decky plugin auto-updates)**: Implemented on `feature/decky-plugin-updates`
- **Milestone A (game-aware checks)**: Deployed to develop 2026-04-10

## Architecture notes
- **Decky IPC**: Decky's `/ws` router keeps only the newest socket; a second socket evicts Decky's own
  (`window.DeckyBackend`), which reconnects 5 s later and evicts the newcomer. All backend calls therefore go through
  `call` from `@decky/api` and loader routes through `window.DeckyBackend.call` (`src/deckyApi.ts`), each wrapped in
  a timeout. Only two paths open a private socket: the plugin install flow (so the prompt event reaches us instead of
  Decky's modal) and `updater/do_update` (so a FULL_SYNC replay cannot re-run it after the loader restarts). Message
  types: ERROR -1, CALL 0, REPLY 1, DISCARD 2, RECEIVED_RESPONSE 3, FULL_SYNC 4, EVENT 5. Reference:
  `workspaces/general/docs/reference/decky-loader/api.md`.
- **Wake detection**: `SteamClient.User.RegisterForResumeSuspendedGamesProgress` (current Steam builds have no
  `System.RegisterForOnResumeFromSuspend`). It fires once per progress state, so the service coalesces callbacks
  within 60 s or while a wake is in flight. Heartbeat polling is the fallback only.
- **Scheduling**: one due-time timer (`src/autoUpdateService.ts`). Due = last check + interval; a failed check is due
  again within 30 min. Manual checks run every enabled source; startup, wake, and game-close run Steam plus only the
  sources that are due. Last results persist in `check_state.json` via `get_check_state` / `save_check_state`.
- **Service singleton**: `src/autoUpdateService.ts` - all background logic runs at plugin level via `definePlugin()`, not React hooks
- **React UI**: Pure subscriber via `service.subscribe()` - no timers, no background logic. The panel is not
  `alwaysRender`; collapsible state lives in a module-level map.
- **QAM layout**: the panel is 300 px wide (268 px content). Steam's `DialogButton` has `min-width: 160px` and an
  inline Field's right column is capped at 50% (134 px), so never put a `DialogButton` in an inline Field. Status rows
  are focusable `Field`s with an icon; dropdowns that need width use `Field childrenLayout="below"
  childrenContainerWidth="max"` around a plain `Dropdown` (a fixed-width `DropdownItem` gets `min-width: 270px` in
  `#QuickAccess-Menu`).
- **Steam updates**: Frontend-driven (SteamClient is a JS global in CEF context)
- **Flatpak updates**: Python backend. All active scopes (`_detect_flatpak_scopes()`) are checked in parallel with
  `remote-ls --updates --columns=ref,commit,origin,download-size` (no name column: it forces an appstream parse); names
  come from `flatpak list`. Refs matching `flatpak --<scope> mask` patterns are dropped. Apply runs only for scopes
  with pending refs and is verified by comparing installed commits before and after (`applied` / `appliedCount`
  count only pending refs that changed); refs that do not change are dropped from the result and remembered as stuck
  until their remote commit changes. Concurrent calls join the in-flight run. User-level runs via
  `runuser -u deck -- flatpak --user` with `_deck_env()`; system-level runs `flatpak --system` directly.
- **Subprocesses**: `_run_cmd` starts each command in its own session and kills the whole process group on timeout
  or cancel, so the real `flatpak` under `runuser` dies with it.
- **Subprocess env**: `_minimal_env()` builds a clean env from scratch (PATH, XDG_RUNTIME_DIR, LANG only). `_deck_env()` adds HOME for user-level flatpak access. Never copy os.environ - Steam runtime pollution causes hangs.
- **Settings validation**: Python `_validate_settings()` handles type coercion (int/float, bool vs int), clamping, migration. Frontend merges with `DEFAULT_SETTINGS` as safety net.
- **JSON files**: settings, history, and check state are written atomically (tmp, fsync, `os.replace`, owner kept).
- **Shared helpers**: `src/helpers.ts` - formatting, status text, history grouping, palette, logging
- **Shared types**: `src/types.ts` - `FlatpakStatus`, `Trigger`, `emptyResult()` factory
- **Toast policy**: Only show toasts when actual updates are found. No "up to date" or "resuming from sleep" toasts.
- **History policy**: Only log entries when pendingCount > 0 or forcedCount > 0. Color-coded in UI.
- **Deploy path**: `/home/deck/homebrew/plugins/AutoUpdate/` (NOT `decky-autoupdate/`)

## Testing
- Format check: `pnpm format:check`
- Typecheck: `pnpm typecheck`
- Build: `pnpm run build`
- TypeScript tests: `pnpm test:ts` (334 tests)
- Python tests: `pnpm test:py` or `python3 -m unittest discover tests -v` (261 tests; `tests/_stub.py` provides the
  shared `decky` stub and an argv-aware subprocess fake)
- All at once: `pnpm test`
- pnpm 10 is required (`pnpm-workspace.yaml` uses `allowBuilds`); without a global pnpm use `npx -y pnpm@10 ...`.

## Debugging
- **Always check plugin logs first**: `~/homebrew/logs/AutoUpdate/` - one line per subprocess (`cmd rc=N Xms: argv`),
  stdout/stderr only on failure or with debug on. Frontend lines carry their own event time
  (`[Frontend HH:MM:SS.mmm]`) because they arrive in batches.
- `journalctl -u plugin_loader` for Python backend errors and `Dropping message as there is no connected socket`
  (a sign something opened a private socket)
- CEF remote debugger (chrome://inspect, or `http://localhost:8080/json` from desktop mode with Big Picture open):
  the QAM is its own target `QuickAccess_uid*`
- **Version is logged at startup** (backend + frontend) — confirm you're looking at the build you just deployed
- **Diagnostics dump button** in Advanced settings produces a complete state snapshot (version, settings, availability, last check per source, history count, Decky Loader version) — copy to clipboard for sharing

## Log levels and `trace` vs `debug`
- `log`, `logWarn`, `logError` (`helpers.ts`): always emit; buffered and sent to the backend log in batches through
  `log_frontend_batch` (at most once per second, sooner for warn/error, flushed on stop).
- `debug` (`helpers.ts`): gated by the `debugLogging` setting, batched the same way.
- `trace` (`helpers.ts`): gated by `debugLogging`, CEF-console-only — never sent to the backend. Use it inside IPC
  machinery and for high-frequency events.

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
