# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Steam game updates — periodically scans for pending/scheduled updates and force-starts them
- Flatpak app updates — periodically checks for and applies Flatpak updates via backend subprocess
- Per-source toggles and configurable intervals (Steam: 5–120 min, Flatpak: 1–24 hours)
- Flatpak auto-apply toggle — choose between check-only or automatic installation
- Wake-from-sleep detection using `SteamClient.System.RegisterForOnResumeFromSuspend` with heartbeat fallback
- Manual "Check Steam", "Check Flatpak", and "Check All" buttons
- Expandable update details showing game/app names, download sizes, and states
- Color-coded status indicators and human-readable history log
- Toast notifications when updates are found (silent when nothing to report)
- Settings validation with type coercion, clamping, and migration in Python backend
- Network/offline awareness — skips forcing updates when system appears offline
- Graceful degradation — Flatpak section hidden if flatpak is not installed
- SteamClient abstraction layer isolating all undocumented API calls
- Provider abstraction layer for uniform multi-source handling
- Shared utility functions for formatting, logging, and error handling
- Prettier formatting with CI enforcement
- CI pipeline (format check, build, TypeScript + Python tests on push/PR)
- Auto-release pipeline (version bump, changelog update, tagging on merge to main)
- Comprehensive test suite (69 TypeScript + 53 Python tests)
