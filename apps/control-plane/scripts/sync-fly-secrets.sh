#!/usr/bin/env bash
# =============================================================================
# sync-fly-secrets.sh — push the control-plane's SECRET env vars to its Fly app.
#
# Source of truth: the repo-root `.env.control` (gitignored — see
# .env.control.example). This script copies ONLY the secret-class keys the
# control-plane reads into `fly secrets` for app `imsg-control-plane`.
#
# Deliberately NOT synced:
#   * Non-secret config (PORT, AGENTPHONE_API_BASE, LLM_MODEL) — those live in
#     fly.toml's [env] block; duplicating them as secrets only creates drift.
#   * Dashboard-only secrets (GOOGLE_*, BETTER_AUTH_*, CONTROL_PLANE_URL,
#     NEXT_PUBLIC_*) — the dashboard runs on Vercel, set them there.
#   * Device-only vars (TOKEN, IMSG_*) — consumed on the developer's machine.
#
# Usage (run from anywhere):
#   apps/control-plane/scripts/sync-fly-secrets.sh            # DRY RUN (plan)
#   apps/control-plane/scripts/sync-fly-secrets.sh --apply    # push for real
#   apps/control-plane/scripts/sync-fly-secrets.sh --apply --stage  # stage only
#
# Flags:
#   --apply           Actually run `fly secrets import` (default is a dry run).
#   --stage           With --apply: stage secrets WITHOUT restarting now; they
#                     apply on the next `fly deploy`.
#   --app NAME        Override the Fly app (default: read from fly.toml).
#   --env-file PATH   Override the env file (default: repo-root .env.control; also
#                     via the IMSG_ENV_FILE environment variable).
#   --offline         Skip the remote `fly secrets list` presence/orphan check.
#   -h, --help        Show this help and exit.
#
# Secrets are streamed to `fly secrets import` over stdin (never passed on the
# command line) so values never land in argv, `ps`, or shell history. Each run
# is a SINGLE atomic import → at most one machine restart.
# =============================================================================
set -euo pipefail

# --- the contract: which .env keys are control-plane secrets -----------------
# Required: the control-plane fails closed (or, for WEBHOOK_BASE_URL, silently
# falls back to localhost:8080) if these are unset, so a sync that left any of
# them out would be worse than useless. Missing one is a hard error.
# WEBHOOK_BASE_URL is the public control-plane origin; it was moved out of
# fly.toml [env] (0008cf7) so each deployment supplies it here via this script.
REQUIRED_SECRETS=(
  DATABASE_URL
  DEVICE_TOKEN_PEPPER
  AGENTPHONE_API_KEY
  AGENTPHONE_AGENT_ID
  AGENTPHONE_WEBHOOK_SECRET
  LLM_API_KEY
  WEBHOOK_BASE_URL
)
# Optional: an override for a non-secret default that fly.toml says to point at a
# private LiteLLM proxy, plus the dashboard SSE ticket secret (the control plane
# reads it optionally and the dashboard SSE route fail-closes without it, so a
# not-yet-provisioned value must not hard-fail the sync). SSE_TICKET_SECRET MUST
# match the dashboard's SSE_TICKET_SECRET (Vercel env) for tickets to verify.
# Synced only when present in .env.
OPTIONAL_SECRETS=(
  LLM_API_BASE
  SSE_TICKET_SECRET
)

say()  { printf '[sync-fly-secrets] %s\n' "$*"; }
die()  { printf '[sync-fly-secrets] error: %s\n' "$*" >&2; exit 1; }
# Print the header comment block (between the `# ===` dividers), de-commented.
help() { awk 'NR==1{next} !/^#/{exit} /^# ===/{next} {sub(/^# ?/,""); print}' "$0"; }

# --- locate ourselves: fly.toml beside us, .env at the repo root -------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"          # apps/control-plane
FLY_TOML="$CP_DIR/fly.toml"
REPO_ROOT="$(cd "$CP_DIR/../.." && pwd)"        # monorepo root

# --- args --------------------------------------------------------------------
APPLY=false
STAGE=false
OFFLINE=false
APP=""
ENV_FILE="${IMSG_ENV_FILE:-$REPO_ROOT/.env.control}"

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
[ -f "$ENV_FILE" ] || die "env file not found at $ENV_FILE (copy .env.control.example -> .env.control, or pass --env-file)"

# App name: explicit flag wins, else read `app = "..."` from fly.toml.
if [ -z "$APP" ]; then
  APP="$(grep -E '^app[[:space:]]*=' "$FLY_TOML" | head -n1 | sed -E 's/^app[[:space:]]*=[[:space:]]*"?([^"]*)"?.*/\1/')"
fi
[ -n "$APP" ] || die "could not determine the Fly app name (set it with --app NAME)"

FLY="$(command -v fly || command -v flyctl || true)"

# --- helpers: read a value from .env / from fly.toml [env] -------------------
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

# Value of KEY in fly.toml's [env] block (best-effort; used to skip redundant
# optional overrides). Returns empty if absent.
toml_env_value() {
  grep -E "^[[:space:]]+$1[[:space:]]*=" "$FLY_TOML" | head -n1 \
    | sed -E 's/^[^=]*=[[:space:]]*"?([^"]*)"?.*/\1/' || true
}

# --- build the sync set ------------------------------------------------------
SYNC_KEYS=()      # keys we will push
MISSING=()        # required keys absent/empty in .env

say "app:      $APP"
say "env file: $ENV_FILE"
say "fly.toml: $FLY_TOML"
printf '\n'
say "planned secrets:"

for k in "${REQUIRED_SECRETS[@]}"; do
  v="$(env_value "$k")"
  if [ -z "$v" ]; then
    MISSING+=("$k")
    printf '  %-26s MISSING (required)\n' "$k"
  else
    SYNC_KEYS+=("$k")
    printf '  %-26s set (%d chars)\n' "$k" "${#v}"
  fi
done

for k in "${OPTIONAL_SECRETS[@]}"; do
  v="$(env_value "$k")"
  if [ -z "$v" ]; then
    printf '  %-26s skipped (optional, unset)\n' "$k"
  elif [ "$v" = "$(toml_env_value "$k")" ]; then
    printf '  %-26s skipped (matches fly.toml [env])\n' "$k"
  else
    SYNC_KEYS+=("$k")
    printf '  %-26s set (%d chars, optional override)\n' "$k" "${#v}"
  fi
done
printf '\n'

# --- remote presence + orphan check (read-only) ------------------------------
if ! $OFFLINE && [ -n "$FLY" ]; then
  remote="$("$FLY" secrets list -a "$APP" 2>/dev/null | awk 'NR>1{print $1}' || true)"
  if [ -n "$remote" ]; then
    # Bash 3.2 (the macOS system bash) has no associative arrays, so test
    # membership against a space-delimited list of the managed keys. Secret names
    # are bare identifiers (no spaces), so the space-padded substring match is exact.
    managed=" ${REQUIRED_SECRETS[*]} ${OPTIONAL_SECRETS[*]} "
    orphans=()
    while IFS= read -r r; do
      [ -n "$r" ] || continue
      case "$managed" in
        *" $r "*) ;;            # managed by this script → leave untouched
        *) orphans+=("$r") ;;   # not in our contract → report as an orphan
      esac
    done <<< "$remote"
    if [ "${#orphans[@]}" -gt 0 ]; then
      say "note: Fly has secrets not managed by this script (left untouched): ${orphans[*]}"
      printf '\n'
    fi
  else
    say "note: could not read remote secrets (not logged in, or app not created yet)"
    printf '\n'
  fi
fi

# --- fail closed on missing required secrets ---------------------------------
if [ "${#MISSING[@]}" -gt 0 ]; then
  die "refusing to sync — required secret(s) missing from $ENV_FILE: ${MISSING[*]}"
fi
[ "${#SYNC_KEYS[@]}" -gt 0 ] || die "nothing to sync"

# --- dry run stops here ------------------------------------------------------
if ! $APPLY; then
  say "DRY RUN — ${#SYNC_KEYS[@]} secret(s) would be imported into '$APP'."
  say "Re-run with --apply to push (add --stage to defer the restart to next deploy)."
  exit 0
fi

# --- apply: stream KEY=VALUE pairs to fly over stdin (one atomic release) ----
[ -n "$FLY" ] || die "fly CLI not found on PATH (install flyctl: https://fly.io/docs/flyctl/install/)"

payload=""
for k in "${SYNC_KEYS[@]}"; do
  payload+="$k=$(env_value "$k")"$'\n'
done

import_args=(secrets import --app "$APP")
$STAGE && import_args+=(--stage)

say "importing ${#SYNC_KEYS[@]} secret(s) into '$APP'$($STAGE && printf ' (staged)' || true)…"
printf '%s' "$payload" | "$FLY" "${import_args[@]}"

if $STAGE; then
  say "done — secrets staged. They apply on the next: fly deploy -c apps/control-plane/fly.toml"
else
  say "done — Fly is rolling the machines with the new secrets."
fi
