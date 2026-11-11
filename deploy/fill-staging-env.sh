#!/bin/sh
# Prints deploy/env.staging.example with every secret generated and every <placeholder> filled (docs/STAGING.md):
#   sh deploy/fill-staging-env.sh <staging-host> <db-host> > /path/outside/the/repo/staging.env
# <db-host> is `postgres` for the compose database. Fresh random values on every run: run it ONCE per
# environment and keep the output in your secret manager (KEK_BASE64 cannot be regenerated: data encrypted
# under it is lost without it). Never commit the output. Needs openssl.
set -eu
[ $# -eq 2 ] || { echo "usage: $0 <staging-host> <db-host>" >&2; exit 2; }
host=$1; db=$2
case "$host" in *[!a-z0-9.-]*|'') echo "staging host must be a lowercase DNS name" >&2; exit 2;; esac
dir=$(dirname "$0")
owner=$(openssl rand -hex 24); app=$(openssl rand -hex 24)
sed -e "s#<owner-password>#$owner#" -e "s#<app-password>#$app#" -e "s#<db-host>#$db#g" -e "s#<staging-host>#$host#g" \
    -e "s#^POSTGRES_OWNER_PASSWORD=\$#POSTGRES_OWNER_PASSWORD=$owner#" "$dir/env.staging.example" |
while IFS= read -r line; do
  case "$line" in
    KEK_BASE64=|SESSION_SECRET_BASE64=) echo "$line$(openssl rand -base64 32)" ;;
    *_WEBHOOK_SECRET=|METRICS_TOKEN=) echo "$line$(openssl rand -hex 32)" ;;
    *) printf '%s\n' "$line" ;;
  esac
done
