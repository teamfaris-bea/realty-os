#!/bin/sh
# Prints a staging env file with every secret generated and every <placeholder> filled (docs/STAGING.md):
#   sh deploy/fill-staging-env.sh <staging-host> <db-host>        > /path/outside/the/repo/staging.env
#   sh deploy/fill-staging-env.sh <staging-host> <db-host> owner  > /path/outside/the/repo/staging.owner.env
# The first is the app's environment (deploy/env.staging.example, .env.production next to the compose file); the
# second the database owner's credentials (deploy/env.owner.example, .env.owner), which only the postgres service and
# the release step read. The two share no secret. <db-host> is `postgres` for the compose database. Fresh random
# values on every run: run each ONCE per environment and keep the output in your secret manager (KEK_BASE64 cannot be
# regenerated: data encrypted under it is lost without it). Never commit the output. Needs openssl.
set -eu
usage() { echo "usage: $0 <staging-host> <db-host> [app|owner]" >&2; exit 2; }
[ $# -eq 2 ] || [ $# -eq 3 ] || usage
host=$1; db=$2; which=${3:-app}
case "$host" in *[!a-z0-9.-]*|'') echo "staging host must be a lowercase DNS name" >&2; exit 2;; esac
case "$which" in app) template=env.staging.example ;; owner) template=env.owner.example ;; *) usage ;; esac
dir=$(dirname "$0")
owner=$(openssl rand -hex 24); app=$(openssl rand -hex 24)
sed -e "s#<owner-password>#$owner#" -e "s#<app-password>#$app#" -e "s#<db-host>#$db#g" -e "s#<staging-host>#$host#g" \
    -e "s#^POSTGRES_OWNER_PASSWORD=\$#POSTGRES_OWNER_PASSWORD=$owner#" "$dir/$template" |
while IFS= read -r line; do
  case "$line" in
    KEK_BASE64=|SESSION_SECRET_BASE64=) echo "$line$(openssl rand -base64 32)" ;;
    *_WEBHOOK_SECRET=|METRICS_TOKEN=) echo "$line$(openssl rand -hex 32)" ;;
    *) printf '%s\n' "$line" ;;
  esac
done
