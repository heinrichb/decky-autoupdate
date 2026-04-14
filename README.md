# AutoUpdate for Decky Loader

[![License: BSD-3-Clause](https://img.shields.io/badge/License-BSD--3--Clause-blue.svg)](LICENSE)
[![Decky Loader](https://img.shields.io/badge/Decky-Plugin-brightgreen)](https://decky.xyz)
[![Version](https://img.shields.io/badge/version-0.1.0-orange)]()

A [Decky Loader](https://decky.xyz) plugin that automatically keeps your Steam games and Flatpak apps up to date on Steam Deck.

## The Problem

Steam schedules game updates instead of downloading them immediately. On Steam Deck and always-on machines, this creates large queues of pending updates that may never fully process — especially if the system goes offline before the scheduled window. Flatpak apps have a similar problem: updates are available but require manual action through Discover or the command line.

## Features

- **Steam game updates** — Periodically scans for pending/scheduled game updates and force-starts them all
- **Flatpak app updates** — Periodically checks for and applies Flatpak updates in the background
- **Independent controls** — Enable or disable each update source separately
- **Manual trigger** — Per-source "Check" buttons and a "Check All" button in the Decky sidebar
- **Configurable intervals** — Steam: 5–120 minutes (default 30). Flatpak: 1–24 hours (default 12)
- **Background operation** — Runs continuously without needing the plugin panel open
- **Update details** — Expandable lists showing game names, app names, and download sizes
- **Color-coded status** — Green (up to date), yellow (pending), red (errors)
- **History log** — Track past update checks with timestamps, source, and counts
- **Toast notifications** — Optional notifications when updates are found

## Configuration

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| Steam updates | on | on/off | Enable periodic Steam game update checks |
| Steam interval | 30 min | 5–120 min | How often to scan for pending game updates |
| Flatpak updates | on | on/off | Enable periodic Flatpak update checks |
| Flatpak interval | 12 hours | 1–24 hours | How often to check for Flatpak updates |
| Auto-apply Flatpak | on | on/off | Automatically install Flatpak updates when found |
| Notifications | on | on/off | Show a toast notification after each check |
| Log history | on | on/off | Record past update checks for review |
| Check on wake | on | on/off | Run update checks when resuming from sleep |

All settings persist across plugin reloads and system reboots.

## Architecture

```
+-----------------------------------------------------+
| Frontend (TypeScript/React -- runs in Steam CEF)    |
|                                                     |
| src/index.tsx             Plugin UI, definePlugin() |
| src/autoUpdateService.ts  Timers, wake, check logic |
| src/providers.ts          Steam & Flatpak wrappers  |
| src/steamClient.ts        SteamClient API layer     |
| src/helpers.ts            Formatting, logging utils |
| src/types.ts              Shared types & constants  |
|                                                     |
| Owns: periodic timers, Steam interaction,           |
|       wake detection, all SteamClient.* API calls   |
+-----------------------------------------------------+
| Backend (Python -- runs as Decky plugin process)    |
|                                                     |
| main.py  Settings & history persistence             |
|          Flatpak subprocess execution               |
|                                                     |
| Owns: JSON read/write, flatpak CLI operations       |
+-----------------------------------------------------+
```

**Why frontend-driven for Steam?** `SteamClient` is a JavaScript global in Steam's CEF context — Python has no access to it. The frontend stays alive for the entire Decky session, so `setInterval` works as a background timer.

**Why backend-driven for Flatpak?** Flatpak operations require running system commands. The Python backend runs with root privileges (via the `root` flag in `plugin.json`) and uses `sudo -u deck` to execute flatpak commands as the deck user.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed development setup instructions.

Quick start:

```bash
git clone https://github.com/heinrichb/decky-autoupdate.git
cd decky-autoupdate
pnpm install
pnpm build
```

## FAQ

**Does this drain battery on Steam Deck?**
The Steam check is lightweight — it queries Steam's in-memory state and doesn't touch the network. Flatpak checks run infrequently (default every 12 hours). Battery impact is negligible.

**Does it work on desktop Linux/Windows?**
It runs wherever Decky Loader runs. The primary targets are Steam Deck and always-on SteamOS machines. Flatpak features are only shown if flatpak is installed.

**What if there are no pending updates?**
The check completes instantly with zero forced updates. No unnecessary work is done.

**Can I run this on a machine with thousands of games?**
Yes. The plugin is designed for large libraries. The SteamClient API enumeration is handled by Steam's own internal data structures.

**Can I use this alongside decky-autoflatpaks?**
You can, but there's no need — AutoUpdate handles Flatpak auto-updates natively. If you only want the full Flatpak package manager (browse, install, uninstall, mask, repair), keep decky-autoflatpaks for that.

## License

[BSD-3-Clause](LICENSE) — Copyright (c) 2026, Brennen Heinrich
