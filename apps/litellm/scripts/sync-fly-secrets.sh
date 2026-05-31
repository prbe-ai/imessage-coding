#!/usr/bin/env bash
# =============================================================================
# sync-fly-secrets.sh — push the LiteLLM proxy's SECRET env vars to its Fly app.
#
# Source of truth: the repo-root `.env` (gitignored — the single env contract
# documented in .env.example). This script copies ONLY the secret-class keys the
# LiteLLM proxy reads into `fly secrets` for app `imsg-litellm`.
#
# The proxy is a SEPARATE Fly app from the control-plane, with its OWN secrets:
#   LITELLM_MASTER_KEY   sk-... admin key (mints virtual keys)
#   LITELLM_SALT_KEY     sk-... encrypts stored creds — set ONCE, never rotate
#   DATABASE_URL         Neon Postgres — DIRECT/UNPOOLED (Prisma migrate needs it)
#   GEMINI_API_KEY       Google AI Studio key
#
# .env-key -> fly-secret-name MAPPING (see SECRET_MAP below): the proxy needs an
# UNPOOLED DATABASE_URL, distinct from the control-plane's pooled DATABASE_URL.
# To keep ONE .env without a key collision, the proxy's URL lives in .env as
# LITELLM_DATABASE_URL and is pushed to Fly under the name DATABASE_URL.
#
# Deliberately NOT synced:
#   * Non-secret config (PORT, model_list) — baked into the image / config.yaml.
#   * Control-plane secrets (DATABASE_URL, DEVICE_TOKEN_PEPPER, AGENTPHONE_*,
#     LLM_API_KEY) — those belong to imsg-control-plane; sync them with
#     apps/control-plane/scripts/sync-fly-secrets.sh.
#
# Usage (run from anywhere):
#   apps/litellm/scripts/sync-fly-secrets.sh            # DRY RUN (plan)
#   apps/litellm/scripts/sync-fly-secrets.sh --apply    # push for real
#   apps/litellm/scripts/sync-fly-secrets.sh --apply --stage  # stage only
#
# Flags:
#   --apply           Actually run `fly secrets import` (default is a dry run).
#   --stage           With --apply: stage secrets WITHOUT restarting now; they
#                     apply on the next `fly deploy`.
#   --app NAME        Override the Fly app (default: read from fly.toml).
#   --env-file PATH   Override the env file (default: repo-root .env; also via
#                     the IMSG_ENV_FILE environment variable).
#   --offline         Skip the remote `fly secrets list` presence/orphan check.
#   -h, --help        Show this help and exit.
#
# Secrets are streamed to `fly secrets import` over stdin (never passed on the
# command line) so values never land in argv, `ps`, or shell history. Each run
# is a SINGLE atomic import → at most one machine restart.
# =============================================================================
set -euo pipefail

# --- the contract: which .env keys are LiteLLM secrets, and the Fly name each ---
# maps to. Format: "<ENV_KEY>:<FLY_SECRET_NAME>". When the names are identical
# the mapping is 1:1; LITELLM_DATABASE_URL is the one rename (see header).
# Required: the proxy fails to boot if any is unset, so a sync that left one out
# would be worse than useless. Missing one is a hard error.
REQUIRED_SECRETS=(
  "LITELLM_MASTER_KEY:LITELLM_MASTER_KEY"
  "LITELLM_SALT_KEY:LITELLM_SALT_KEY"
  "LITELLM_DATABASE_URL:DATABASE_URL"
  "GEMINI_API_KEY:GEMINI_API_KEY"
)

say()  { printf '[sync-fly-secrets] %s\n' "$*"; }
die()  { printf '[sync-fly-secrets] error: %s\n' "$*" >&2; exit 1; }
# Print the header comment block (between the `# ===` dividers), de-commented.
help() { awk 'NR==1{next} !/^#/{exit} /^# ===/{next} {sub(/^# ?/,""); print}' "$0"; }

# --- locate ourselves: fly.toml beside us, .env at the repo root -------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"          # apps/litellm
FLY_TOML="$APP_DIR/fly.toml"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"        # monorepo root

# --- args --------------------------------------------------------------------
APPLY=false
STAGE=false
OFFLINE=false
APP=""
ENV_FILE="${IMSG_ENV_FILE:-$REPO_ROOT/.env}"

while [ $# -gt 0 ]; do
  case "$1" in
    --apply)    APPLY=true ;;
    --stage)    STAGE=true ;;
    --offline)  OFFLINE=true ;;
    --app)      APP="${2:-}"; shift ;;
    --app=*)    APP="${1#*=}" ;;
    --env-file) ENV_FILE="${2:-}"; shift ;;
    --env-file=*) ENV_FILE="${1#*=}" ;;
    -h|--help)  help; exit 0 ;;
    *)          die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

$STAGE && ! $APPLY && die "--stage only makes sense with --apply"

# --- preconditions -----------------------------------------------------------
[ -f "$FLY_TOML" ] || die "fly.toml not found at $FLY_TOML"
[ -f "$ENV_FILE" ] || die "env file not found at $ENV_FILE (copy .env.example -> .env, or pass --env-file)"

# App name: explicit flag wins, else read `app = "..."` from fly.toml.
if [ -z "$APP" ]; then
  APP="$(grep -E '^app[[:space:]]*=' "$FLY_TOML" | head -n1 | sed -E 's/^app[[:space:]]*=[[:space:]]*"?([^"]*)"?.*/\1/')"
fi
[ -n "$APP" ] || die "could not determine the Fly app name (set it with --app NAME)"

FLY="$(command -v fly || command -v flyctl || true)"

# --- helper: read a value from .env ------------------------------------------
# Print the raw value for KEY=... (first match, optional `export ` prefix, one
# layer of surrounding quotes and a trailing CR stripped). Never `source` the
# file — that would execute arbitrary shell and choke on URLs/special chars.
env_value() {
  local key="$1" line val
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$ENV_FILE" | head -n1 || true)"
  [ -n "$line" ] || return 0
  val="${line#*=}"
  val="${val%$'\r'}"
  case "$val" in
    \"*\") val="${val#\"}"; val="${val%\"}" ;;
    \'*\') val="${val#\'}"; val="${val%\'}" ;;
  esac
  printf '%s' "$val"
}

# --- build the sync set ------------------------------------------------------
SYNC_ENV=()       # .env keys we will push (parallel to SYNC_FLY)
SYNC_FLY=()       # fly secret names (parallel to SYNC_ENV)
MISSING=()        # required keys absent/empty in .env

say "app:      $APP"
say "env file: $ENV_FILE"
say "fly.toml: $FLY_TOML"
printf '\n'
say "planned secrets (.env key -> fly name):"

for pair in "${REQUIRED_SECRETS[@]}"; do
  env_key="${pair%%:*}"
  fly_name="${pair##*:}"
  v="$(env_value "$env_key")"
  if [ -z "$v" ]; then
    MISSING+=("$env_key")
    printf '  %-22s -> %-20s MISSING (required)\n' "$env_key" "$fly_name"
  else
    SYNC_ENV+=("$env_key")
    SYNC_FLY+=("$fly_name")
    printf '  %-22s -> %-20s set (%d chars)\n' "$env_key" "$fly_name" "${#v}"
  fi
done
printf '\n'

# --- remote presence + orphan check (read-only) ------------------------------
if ! $OFFLINE && [ -n "$FLY" ]; then
  remote="$("$FLY" secrets list -a "$APP" 2>/dev/null | awk 'NR>1{print $1}' || true)"
  if [ -n "$remote" ]; then
    declare -A managed=()
    for pair in "${REQUIRED_SECRETS[@]}"; do managed["${pair##*:}"]=1; done
    orphans=()
    while IFS= read -r r; do
      [ -n "$r" ] || continue
      [ -n "${managed[$r]:-}" ] || orphans+=("$r")
    done <<< "$remote"
    if [ "${#orphans[@]}" -gt 0 ]; then
      say "note: Fly has secrets not managed by this script (left untouched): ${orphans[*]}"
      printf '\n'
    fi
  else
    say "note: could not read remote secrets (not logged in, or app has none yet)"
    printf '\n'
  fi
fi

# --- fail closed on missing required secrets ---------------------------------
if [ "${#MISSING[@]}" -gt 0 ]; then
  die "refusing to sync — required secret(s) missing from $ENV_FILE: ${MISSING[*]}"
fi
[ "${#SYNC_ENV[@]}" -gt 0 ] || die "nothing to sync"

# --- dry run stops here ------------------------------------------------------
if ! $APPLY; then
  say "DRY RUN — ${#SYNC_ENV[@]} secret(s) would be imported into '$APP'."
  say "Re-run with --apply to push (add --stage to defer the restart to next deploy)."
  exit 0
fi

# --- apply: stream KEY=VALUE pairs to fly over stdin (one atomic release) ----
[ -n "$FLY" ] || die "fly CLI not found on PATH (install flyctl: https://fly.io/docs/flyctl/install/)"

payload=""
i=0
while [ "$i" -lt "${#SYNC_ENV[@]}" ]; do
  payload+="${SYNC_FLY[$i]}=$(env_value "${SYNC_ENV[$i]}")"$'\n'
  i=$((i + 1))
done

import_args=(secrets import --app "$APP")
$STAGE && import_args+=(--stage)

say "importing ${#SYNC_ENV[@]} secret(s) into '$APP'$($STAGE && printf ' (staged)' || true)…"
printf '%s' "$payload" | "$FLY" "${import_args[@]}"

if $STAGE; then
  say "done — secrets staged. They apply on the next: fly deploy -c apps/litellm/fly.toml"
else
  say "done — Fly is rolling the machines with the new secrets."
fi
