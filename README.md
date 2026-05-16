# AutoUpdate for Decky Loader

[![License: BSD-3-Clause](https://img.shields.io/badge/License-BSD--3--Clause-blue.svg)](LICENSE)
[![Decky Loader](https://img.shields.io/badge/Decky-Plugin-brightgreen)](https://decky.xyz)
[![Version](https://img.shields.io/badge/version-0.1.0-orange)]()

A [Decky Loader](https://decky.xyz) plugin that automatically keeps your Steam games and Flatpak apps up to date on Steam Deck.

## Why

Steam schedules game updates instead of downloading them immediately, so on an always-on Steam Deck you can end up with a queue of pending downloads that never finishes. Flatpak apps have the same issue: updates sit there until you open Discover or run `flatpak update` by hand.

## Features

- Steam game updates: periodic scan for pending/scheduled updates and force-start
- Flatpak app updates: periodic check and background apply
- Independent toggles for each update source
- Manual per-source "Check" buttons plus "Check All"
- Configurable intervals (Steam 5-120 min, Flatpak 1-24 h)
- Runs in the background with the panel closed
- Color-coded status (green for handled / up-to-date, yellow for items pending action, red for errors)
- History log of past checks
- Optional toast notifications when updates are found

## Configuration

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| Steam updates | on | on/off | Enable periodic Steam game update checks |
| Steam interval | 30 min | 5-120 min | How often to scan for pending game updates |
| Flatpak updates | on | on/off | Enable periodic Flatpak update checks |
| Flatpak interval | 12 hours | 1-24 hours | How often to check for Flatpak updates |
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

Steam logic lives on the frontend because `SteamClient` is a JS global in Steam's CEF context (no Python access). The frontend is alive for the whole Decky session, so `setInterval` is enough for a background timer.

Flatpak logic lives in the Python backend because it needs to run system commands. The backend runs with root (via the `root` flag in `plugin.json`) and drops to the `deck` user via `runuser` to run user-scope flatpak commands.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed development setup instructions.

### Install from source onto your Steam Deck

Clone, install deps, build + deploy. Works with **bun** (fastest), **pnpm**, or **npm**:

```bash
git clone https://github.com/heinrichb/decky-autoupdate.git
cd decky-autoupdate
bun install            # or: pnpm install / npm install
bun run deploy         # or: pnpm run deploy / npm run deploy
```

The `deploy` script (see `scripts/deploy.sh`) builds the frontend, copies the plugin files into `/home/deck/homebrew/plugins/AutoUpdate/` (via `sudo` — you'll be prompted), and restarts `plugin_loader`. The plugin shows up in Decky immediately after.

To install `bun` first if you don't have it:

```bash
curl -fsSL https://bun.sh/install | bash
```

### Build only

```bash
bun run build          # produces dist/
bun run test:ts        # vitest
bun run test:py        # python unittest
```

## FAQ

**Does this drain battery on Steam Deck?**
The Steam check reads Steam's in-memory state and doesn't touch the network. Flatpak checks run at a configurable interval (default 12 hours). Battery impact is negligible.

**Does it work on desktop Linux?**
It runs wherever Decky Loader runs. The primary targets are Steam Deck and always-on SteamOS machines. The Flatpak section is only shown if flatpak is installed.

**What if there are no pending updates?**
The check returns immediately with zero forced updates.

**Can I run this on a machine with thousands of games?**
Yes. Enumeration is handled by Steam's own internal data structures.

**Can I use this alongside decky-autoflatpaks?**
Yes. AutoUpdate covers Flatpak auto-updates; decky-autoflatpaks adds the full package manager UI (browse, install, uninstall, mask, repair) if you need it.

## License

[BSD-3-Clause](LICENSE). Copyright (c) 2026, Brennen Heinrich.
