#!/bin/sh
# Renders an env file for docker-compose.app-vm.yml from non-secret settings and secret REFERENCES
# (docs/DEPLOY.md §12). The secrets are fetched with a command the operator supplies; this script knows no provider.
#
#   export SECRET_FETCH_CMD='<your secret store CLI, printing one secret named by its last argument>'
#   install -d -m 700 /run/realty
#   deploy/render-secrets.sh app.settings app.secrets.refs /run/realty/app.env
#   deploy/render-secrets.sh - owner.secrets.refs /run/realty/owner.env      # owner mode
#   docker compose -f docker-compose.app-vm.yml --profile release run --rm release
#   rm /run/realty/owner.env                                                  # right after the release step
#   docker compose -f docker-compose.app-vm.yml up -d
#
# usage: render-secrets.sh <settings|-> <refs> <out>
#
# Modes:
# - app mode (settings is a file): the settings lines are copied verbatim (comments and blanks dropped), then one
#   NAME=value line per reference. No owner credential (MIGRATION_DATABASE_URL, POSTGRES_OWNER_PASSWORD,
#   POSTGRES_PASSWORD, POSTGRES_OWNER_USER, POSTGRES_DB) and no libpq variable (PG*) may appear in either file (E488):
#   the api and the worker must never hold the owner's credentials, and a PG* variable would steer libpq around
#   DATABASE_URL and its TLS settings.
# - owner mode (settings is `-`): there are no settings, and the refs file must hold MIGRATION_DATABASE_URL and
#   nothing else (E488). The output is read only by the release profile.
#
# Each reference is fetched as  sh -c "$SECRET_FETCH_CMD \"\$1\"" _ "<ref>"  (the reference is an argument, never
# evaluated): its stdout is the value (one trailing newline stripped), its stderr is discarded so that a store's
# error text, which may quote the secret, never reaches this script's output. VERIFY that your provider's CLI prints
# the bare value with no decoration and exits non-zero when the secret is missing.
#
# Every refusal exits 1 with one `render-secrets: refused: ...` line on stderr naming the check and the variable,
# never a value, and leaves <out> untouched. The output is written with umask 077 to a temporary file in the target
# directory, then moved into place; the target directory must not be accessible by group or others.
set -eu
umask 077

refuse() {
  printf 'render-secrets: refused: %s\n' "$1" >&2
  exit 1
}

[ "$#" -eq 3 ] || refuse "usage: render-secrets.sh <settings|-> <refs> <out>"
settings=$1
refs=$2
out=$3

[ -n "${SECRET_FETCH_CMD:-}" ] || refuse "SECRET_FETCH_CMD is not set (the command that prints one secret by reference)"

owner_mode=false
[ "$settings" = "-" ] && owner_mode=true
if [ "$owner_mode" = false ]; then
  [ -f "$settings" ] && [ -r "$settings" ] || refuse "settings file not readable: $settings"
fi
[ -f "$refs" ] && [ -r "$refs" ] || refuse "refs file not readable: $refs"

dir=$(dirname -- "$out")
[ -d "$dir" ] || refuse "target directory does not exist: $dir"
[ ! -d "$out" ] || refuse "target is a directory: $out"
# group and others: no bit set (setgid/sticky without x, shown as S/T, grant nothing)
perms=$(ls -ld -- "$dir" | cut -c5-10)
case "$perms" in
  --[-S]--[-T]) ;;
  *) refuse "target directory is accessible by group or others (mode $perms): $dir" ;;
esac

nl='
'
OWNER_NAMES=' MIGRATION_DATABASE_URL POSTGRES_OWNER_PASSWORD POSTGRES_PASSWORD POSTGRES_OWNER_USER POSTGRES_DB '

# app mode: no owner credential and no libpq variable (E488)
check_name() { # <key> <file kind>
  case "$OWNER_NAMES" in
    *" $1 "*) refuse "E488 $1 is an owner credential: not allowed in the $2 file (it belongs in owner mode only)" ;;
  esac
  case "$1" in
    PG[A-Z]*) refuse "E488 $1 is a libpq variable: not allowed in the $2 file" ;;
  esac
}

settings_keys=' '
refs_keys=' '
ref_lines=''

# ---- pass 1: check both files; nothing is fetched yet ----
if [ "$owner_mode" = false ]; then
  lineno=0
  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    stripped=${line#"${line%%[! 	]*}"}
    case "$stripped" in
      '' | '#'*) continue ;;
    esac
    key=${line%%=*}
    case "$line" in
      *=*) ;;
      *) refuse "settings line $lineno is not KEY=value" ;;
    esac
    case "$key" in
      '' | [!A-Z_]* | *[!A-Z0-9_]*) refuse "settings line $lineno is not KEY=value (KEY is [A-Z_][A-Z0-9_]*)" ;;
    esac
    value=${line#*=}
    case "$value" in
      *'$'* | *\'* | *'"'* | *' #'* | *'	#'*) refuse "settings value of $key holds \$, a quote or ' #'" ;;
    esac
    check_name "$key" settings
    case "$settings_keys" in
      *" $key "*) refuse "duplicate key $key in the settings file" ;;
    esac
    settings_keys="$settings_keys$key "
  done <"$settings"
fi

lineno=0
while IFS= read -r line || [ -n "$line" ]; do
  lineno=$((lineno + 1))
  stripped=${line#"${line%%[! 	]*}"}
  case "$stripped" in
    '' | '#'*) continue ;;
  esac
  case "$line" in
    *=*) ;;
    *) refuse "refs line $lineno is not NAME=ref" ;;
  esac
  key=${line%%=*}
  ref=${line#*=}
  case "$key" in
    '' | [!A-Z_]* | *[!A-Z0-9_]*) refuse "refs line $lineno is not NAME=ref (NAME is [A-Z_][A-Z0-9_]*)" ;;
  esac
  if [ "$owner_mode" = true ]; then
    [ "$key" = MIGRATION_DATABASE_URL ] || refuse "E488 owner mode renders MIGRATION_DATABASE_URL only, not $key"
  else
    check_name "$key" refs
  fi
  case "$ref" in
    '' | *[!A-Za-z0-9/_.:@-]*) refuse "reference of $key is not [A-Za-z0-9/_.:@-]+" ;;
  esac
  case "$refs_keys" in
    *" $key "*) refuse "duplicate key $key in the refs file" ;;
  esac
  case "$settings_keys" in
    *" $key "*) refuse "$key is in both the settings and the refs file" ;;
  esac
  refs_keys="$refs_keys$key "
  ref_lines="$ref_lines$key=$ref$nl"
done <"$refs"

if [ "$owner_mode" = true ]; then
  [ "$refs_keys" = ' MIGRATION_DATABASE_URL ' ] || refuse "E488 owner mode needs MIGRATION_DATABASE_URL in the refs file"
fi

# ---- pass 2: write the settings, fetch and write each secret ----
tmp=$(mktemp "$dir/.render-secrets.XXXXXX") || refuse "cannot create a temporary file in $dir"
trap 'rm -f "$tmp"' EXIT
trap 'exit 1' HUP INT TERM

if [ "$owner_mode" = false ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    stripped=${line#"${line%%[! 	]*}"}
    case "$stripped" in
      '' | '#'*) continue ;;
    esac
    printf '%s\n' "$line" >>"$tmp"
  done <"$settings"
fi

# A value lands unquoted in an env file that two readers parse: compose interpolates an unquoted `$` and strips a
# ` #` comment, while `docker run --env-file` is said to keep quotes literally (VERIFY). One narrow charset, with no
# quote, `$`, space, `#` or newline, makes both readers see the same value (E487). A URL such as
# postgres://app_user:pw@db.example.com:5432/realty fits it; percent-encode anything else in a password.
while IFS= read -r line; do
  [ -n "$line" ] || continue
  key=${line%%=*}
  ref=${line#*=}
  # the trailing `x` keeps every newline of the value until exactly one is stripped below
  if raw=$(sh -c "$SECRET_FETCH_CMD \"\$1\"" _ "$ref" 2>/dev/null </dev/null && printf x); then
    :
  else
    refuse "fetch failed for $key (reference $ref)"
  fi
  raw=${raw%x}
  value=${raw%"$nl"}
  case "$value" in
    '') refuse "E487 $key: the fetched value is empty" ;;
    *[!A-Za-z0-9+/=:._@%,~-]*) refuse "E487 $key: the fetched value holds a character outside [A-Za-z0-9+/=:._@%,~-]" ;;
  esac
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
done <<REFS
$ref_lines
REFS

mv -f -- "$tmp" "$out"
trap - EXIT
