# Contributing to AutoUpdate

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [pnpm](https://pnpm.io/) 9+
- A Steam Deck or SteamOS device with [Decky Loader](https://decky.xyz) installed (for testing)

## Development Setup

```bash
# Clone the repository
git clone https://github.com/heinrichb/decky-autoupdate.git
cd decky-autoupdate

# Install dependencies
pnpm install

# Build the plugin
pnpm build

# Watch mode (rebuild on changes)
pnpm watch
```

## Deploying to Steam Deck for Testing

1. Build the plugin: `pnpm build`
2. Copy the entire project directory to your Steam Deck:
   ```bash
   rsync -avz --exclude node_modules --exclude .git \
     ./ deck@DECK_IP:~/homebrew/plugins/AutoUpdate/
   ```
3. Restart Decky Loader on the Steam Deck, or reboot

## CEF Remote Debugging

To discover or verify SteamClient API methods:

1. On the Steam Deck, create an empty file at `~/.steam/steam/.cef-enable-remote-debugging` (or enable via Decky developer settings)
2. Reboot the Steam Deck
3. From another machine on the same network, open `http://DECK_IP:8081` in Chrome
4. Click the **SharedJSContext** target
5. In the Console, explore:
   ```javascript
   Object.keys(SteamClient)
   Object.getOwnPropertyNames(Object.getPrototypeOf(SteamClient.Apps))
   Object.getOwnPropertyNames(Object.getPrototypeOf(SteamClient.Downloads))
   ```

## Project Structure

```
decky-autoupdate/
├── src/
│   ├── index.tsx              # Plugin entry point and UI panel
│   ├── autoUpdateService.ts   # Service singleton (timers, wake detection, checks)
│   ├── steamClient.ts         # SteamClient API abstraction
│   ├── providers.ts           # Update source wrappers (Steam, Flatpak)
│   ├── helpers.ts             # Pure utility functions (formatting, colors)
│   ├── types.ts               # Shared TypeScript interfaces and constants
│   └── __tests__/             # Vitest unit tests
├── main.py                    # Python backend (settings, history, Flatpak subprocess)
├── tests/                     # Python unit tests
├── .github/workflows/         # CI and release pipelines
├── defaults/
│   └── settings.json          # Default plugin settings
├── .prettierrc                # Prettier formatting config
├── plugin.json                # Decky plugin metadata
├── package.json               # Node.js project config
├── tsconfig.json              # TypeScript config
└── rollup.config.js           # Build config
```

## Code Style

- **Formatting**: Run `pnpm format` before committing. CI will reject unformatted code.
- TypeScript: strict mode, no `any` outside of `steamClient.ts`
- Python: standard library only, async methods
- Keep `steamClient.ts` as the single point of contact with `SteamClient`. No direct `SteamClient.*` calls elsewhere.

## Pull Requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-change`
3. Make your changes
4. Run `pnpm format` to auto-format
5. Ensure `pnpm build` succeeds
6. Test on a real Steam Deck if your change touches SteamClient interaction
7. Open a pull request with a clear description of what changed and why
