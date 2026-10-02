#!/usr/bin/env bash
#
# Build decky-autoupdate and install it into the running Decky Loader on
# a Steam Deck. Designed for local development: clone the repo, run
# `bun install`, then `bun run deploy`.
#
# Steps:
#   1. Build the frontend (dist/) via rollup
#   2. sudo-copy the built artifacts + Python backend + manifest files
#      into /home/deck/homebrew/plugins/AutoUpdate/
#   3. Restart plugin_loader so the new build is picked up
#
# Requires:
#   - Decky Loader installed on the device
#   - sudo access for the running user (you will be prompted for the password)
#   - A package manager that resolves the project's dependencies (bun, pnpm,
#     or npm — any works; the script uses whichever invoked it via the
#     npm_lifecycle_event/npm_execpath env, falling back to bun if available)

set -euo pipefail

# Always run from the repo root regardless of where the user invoked us.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
cd "$REPO_ROOT"

PLUGIN_NAME="AutoUpdate"
DECKY_PLUGIN_DIR="/home/deck/homebrew/plugins/$PLUGIN_NAME"

# Pick a package manager. Prefer the one that invoked us (npm/pnpm/bun set
# npm_execpath); else fall back to bun, then pnpm, then npm.
pkg_mgr="${npm_execpath:-}"
if [[ -z "$pkg_mgr" || "$pkg_mgr" == *node ]]; then
  if command -v bun >/dev/null 2>&1; then
    pkg_mgr="bun"
  elif command -v pnpm >/dev/null 2>&1; then
    pkg_mgr="pnpm"
  elif command -v npm >/dev/null 2>&1; then
    pkg_mgr="npm"
  else
    echo "deploy.sh: need bun, pnpm, or npm on PATH" >&2
    exit 1
  fi
fi

echo "==> Building plugin"
"$pkg_mgr" run build

if [[ ! -d dist ]]; then
  echo "deploy.sh: build did not produce dist/" >&2
  exit 1
fi

echo "==> Installing into $DECKY_PLUGIN_DIR (sudo required)"
sudo mkdir -p "$DECKY_PLUGIN_DIR"
sudo cp -r dist "$DECKY_PLUGIN_DIR/"
sudo cp main.py "$DECKY_PLUGIN_DIR/main.py"
sudo cp plugin.json "$DECKY_PLUGIN_DIR/plugin.json"
sudo cp package.json "$DECKY_PLUGIN_DIR/package.json"
sudo cp -r defaults "$DECKY_PLUGIN_DIR/"

# README is optional but Decky shows it in the loader's plugin UI when present
if [[ -f README.md ]]; then
  sudo cp README.md "$DECKY_PLUGIN_DIR/README.md"
fi

echo "==> Restarting plugin_loader"
sudo systemctl restart plugin_loader

echo "==> Done. Plugin v$(python3 -c "import json,sys; print(json.load(open('package.json'))['version'])") deployed."
echo "    Logs: tail -F /home/deck/homebrew/logs/$PLUGIN_NAME/*.log"
