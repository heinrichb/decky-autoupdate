# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
