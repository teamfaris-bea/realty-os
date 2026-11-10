#!/usr/bin/env bash
# Runs every time the codespace starts: API, job worker and web app in the background.
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p .devcontainer/logs
nohup pnpm dev:api    > .devcontainer/logs/api.log 2>&1 &
nohup pnpm dev:worker > .devcontainer/logs/worker.log 2>&1 &
nohup pnpm dev:web    > .devcontainer/logs/web.log 2>&1 &
echo "Realty OS is starting: open the 'Realty OS (open this)' port (5173) in the Ports tab."
