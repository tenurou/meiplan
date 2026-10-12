#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 20+ and npm are required. Install them, then run this script again."
  exit 1
fi
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 20 )); then
  echo "Node.js 20 or newer is required (found $(node --version))."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required to read Excel workbooks. Install python3, then run this script again."
  exit 1
fi

if [[ ! -d node_modules/playwright ]]; then
  npm ci --no-fund --no-audit
fi

chromium_path="$(node --input-type=module -e 'import { chromium } from "playwright"; process.stdout.write(chromium.executablePath())')"
if [[ ! -x "$chromium_path" ]]; then
  npx playwright install chromium
fi

playwright_cli="$PWD/node_modules/playwright/cli.js"
if ! node "$playwright_cli" install-deps --dry-run chromium >/dev/null 2>&1; then
  if [[ "$(id -u)" -eq 0 ]]; then
    node "$playwright_cli" install-deps chromium
  elif command -v sudo >/dev/null 2>&1; then
    echo "Installing Chromium's missing Ubuntu/Debian system libraries (sudo may ask for your password)."
    sudo "$(command -v node)" "$playwright_cli" install-deps chromium
  else
    echo "Chromium system libraries are missing. Install them with: sudo node $playwright_cli install-deps chromium"
    exit 1
  fi
fi

echo "Starting AGM Plan Assistant at http://127.0.0.1:8765"
exec node server.mjs
