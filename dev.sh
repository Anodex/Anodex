#!/usr/bin/env bash
# ============================================================
#  Anodex - launch the app in development mode (hot reload)
#  Linux counterpart of dev.cmd. Run `./dev.sh` from a terminal.
#
#  `npm run dev` runs scripts/dev-preflight.mjs first (as its
#  `predev` step), which stages the runtimes a packaged build
#  gets and closes any instance that would block this one.
# ============================================================
set -uo pipefail

cd "$(dirname "$(readlink -f "$0")")"

# Node 22 (what CI uses) comes from fnm, installed per-user.
FNM="$HOME/.local/share/fnm/fnm"
if ! command -v node >/dev/null && [ -x "$FNM" ]; then
  eval "$("$FNM" env)"
  "$FNM" use --silent-if-unchanged 22 >/dev/null 2>&1 || true
fi
if ! command -v node >/dev/null; then
  echo "  Node.js not found. Install Node 22 (e.g. with fnm) and try again."
  exit 1
fi

# Ubuntu 24.04+ blocks the unprivileged user namespaces Chromium's sandbox
# needs, so an unpackaged Electron exits at startup. Dev runs only; packaged
# builds are unaffected.
export ELECTRON_DISABLE_SANDBOX=1

# GNOME shows a dock icon only for windows it can match to a .desktop file;
# Electron takes its Wayland app id from this. The launcher itself lives in
# ~/.local/share/applications/anodex-dev.desktop.
export CHROME_DESKTOP=anodex-dev.desktop

echo
echo "  Anodex - starting development build (Node $(node -v))..."
echo

# Install dependencies on first run (or if node_modules is missing).
if [ ! -d node_modules ]; then
  echo "  node_modules not found - installing dependencies. This may take a few minutes..."
  echo
  if ! npm install; then
    echo
    echo "  Dependency install failed. Fix the errors above and try again."
    exit 1
  fi
fi

# Electron fetches its binary on first use, but electron-vite looks for it
# without triggering that fetch, so download it here if it is missing.
if [ ! -f node_modules/electron/path.txt ]; then
  echo "  Downloading the Electron binary..."
  node node_modules/electron/install.js || exit 1
fi

echo "  Launching Anodex (close the app window to stop)..."
npm run dev

echo
echo "  Anodex has exited."
