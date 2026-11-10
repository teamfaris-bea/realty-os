#!/usr/bin/env bash
# Runs once when the codespace is created: install, create the dev database, load the demo team.
set -euo pipefail
cd "$(dirname "$0")/.."

sudo corepack enable || npm install -g pnpm@10
for _ in $(seq 1 60); do (echo > /dev/tcp/127.0.0.1/5432) 2>/dev/null && break; sleep 1; done

pnpm install --frozen-lockfile
pnpm db:setup            # writes .env with fresh dev keys, creates realty_dev, applies migrations

# The browser reaches the app through the codespace's forwarded https address, so the API must
# accept that origin (CSRF check). Put it first so invite/reset links use it too.
if [ -n "${CODESPACE_NAME:-}" ]; then
  url="https://${CODESPACE_NAME}-5173.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
  if grep -q '^WEB_ORIGIN=' .env; then
    sed -i "s#^WEB_ORIGIN=.*#WEB_ORIGIN=${url},http://localhost:5173#" .env
  else
    echo "WEB_ORIGIN=${url},http://localhost:5173" >> .env
  fi
fi

pnpm seed || echo "seed skipped (already seeded; run 'pnpm seed --reset' to start over)"
