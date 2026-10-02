# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Quick Access panel no longer shifts 10 px left when the D-pad reaches the status rows (inline buttons overflowed the 300 px panel)
- Decky plugin auto-updates now confirm the install prompt (Decky sends events as message type 5, not 3)
- Decky Loader updates are detected (`updater/check_for_updates` returns `current` / `remote.tag_name`)
- Flatpak results reach the UI instead of a duplicate-call "up to date" placeholder; real updates are toasted and recorded again
- Masked Flatpak refs (`flatpak mask`) are no longer reported and "applied" on every check
- A Flatpak apply is only reported when an installed commit actually changed
- "Check All" shows live progress and cannot be started twice
- One wake no longer starts up to three overlapping check batches
- Error details are logged instead of `{}`

### Changed

- Backend calls share Decky's own connection instead of opening a WebSocket per call and per log line
- Frontend log lines are sent to the backend in batches
- Wake, game-close, and startup checks run Steam plus only the sources whose interval has elapsed; the last result per source survives reloads
- Periodic checks use due times, so waking or changing a setting no longer restarts every interval
- Steam is checked first by default (it is the fastest source and the one that starts downloads)
- The default pause between sources is 0.5 s instead of 2 s
- Flatpak checks run user and system scopes in parallel without the appstream-parsing name column (about 4 s to under 1 s)
- Steam force-start polls for the scheduled state to clear instead of fixed 3 s and 5 s waits, and ignores superseded duplicate and zero-byte download entries
- Settings, history, and check state are written atomically
- Status rows, interval dropdowns, collapsible Advanced settings, and a day-grouped history list replace the long settings panel
- CI uses pnpm 10 and Node 22 and runs a typecheck

### Added

- Steam game updates: periodic scan for pending/scheduled updates and force-start
- Flatpak app updates: periodic check and apply via backend subprocess
- Per-source toggles and configurable intervals (Steam 5-120 min, Flatpak 1-24 h)
- Flatpak auto-apply toggle (check-only vs. automatic)
- Wake-from-sleep detection via `SteamClient.System.RegisterForOnResumeFromSuspend` with heartbeat fallback
- Manual "Check Steam", "Check Flatpak", and "Check All" buttons
- Expandable update details (game/app names, download sizes, states)
- Color-coded status indicators and history log
- Toast notifications when updates are found (silent otherwise)
- Settings validation with type coercion, clamping, and migration in the Python backend
- Skips forcing updates when the system appears offline
- Flatpak section hidden when flatpak is not installed
- SteamClient abstraction layer isolating undocumented API calls
- Provider abstraction layer for multi-source handling
- Shared utilities for formatting, logging, and error handling
- Prettier formatting with CI enforcement
- CI pipeline: format check, build, TypeScript + Python tests on push/PR
- Auto-release pipeline: version bump, changelog update, tagging on merge to main
- Test suite (69 TypeScript + 53 Python)
