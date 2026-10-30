#!/usr/bin/env bash
# Shared configuration and helpers for the local Passbolt rig.
#
# Sourced by passbolt-start.sh / passbolt-stop.sh / passbolt-init.sh, never run
# directly. Everything is a plain `docker run` — the rig deliberately does not
# need docker compose, so it works on a machine that only has the docker CLI.
#
# Override any value from the environment, e.g.:
#
#   PASSBOLT_PORT=8443 PASSBOLT_ADMIN_EMAIL=me@example.com ./scripts/passbolt-init.sh
#
# The server is throwaway. It listens on http://localhost:<port>, which is fine
# for the widget (it talks JSON over fetch, not the browser extension), and it
# holds no data you would cry about.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

# --- ports, names, credentials ------------------------------------------------

PASSBOLT_PORT="${PASSBOLT_PORT:-8088}"
PASSBOLT_URL="${PASSBOLT_URL:-http://localhost:${PASSBOLT_PORT}}"

PASSBOLT_IMAGE="${PASSBOLT_IMAGE:-passbolt/passbolt:latest-ce}"
PASSBOLT_DB_IMAGE="${PASSBOLT_DB_IMAGE:-mariadb:10.11}"

PASSBOLT_PREFIX="${PASSBOLT_PREFIX:-electerm-passbolt}"
PASSBOLT_CONTAINER="${PASSBOLT_PREFIX}"
PASSBOLT_DB_CONTAINER="${PASSBOLT_PREFIX}-db"
PASSBOLT_NETWORK="${PASSBOLT_PREFIX}-net"
PASSBOLT_GPG_VOLUME="${PASSBOLT_PREFIX}-gpg"
PASSBOLT_JWT_VOLUME="${PASSBOLT_PREFIX}-jwt"
PASSBOLT_DB_VOLUME="${PASSBOLT_PREFIX}-db-data"

PASSBOLT_DB_NAME="${PASSBOLT_DB_NAME:-passbolt}"
PASSBOLT_DB_USER="${PASSBOLT_DB_USER:-passbolt}"
PASSBOLT_DB_PASSWORD="${PASSBOLT_DB_PASSWORD:-passbolt}"
PASSBOLT_DB_ROOT_PASSWORD="${PASSBOLT_DB_ROOT_PASSWORD:-passbolt-root}"

PASSBOLT_ADMIN_EMAIL="${PASSBOLT_ADMIN_EMAIL:-admin@passbolt.local}"
PASSBOLT_ADMIN_FIRST_NAME="${PASSBOLT_ADMIN_FIRST_NAME:-Admin}"
PASSBOLT_ADMIN_LAST_NAME="${PASSBOLT_ADMIN_LAST_NAME:-User}"

# `<repo>/scripts/.passbolt` — gitignored, holds the exported test key
PASSBOLT_STATE_DIR="${PASSBOLT_STATE_DIR:-${SCRIPT_DIR}/.passbolt}"

PASSBOLT_START_TIMEOUT="${PASSBOLT_START_TIMEOUT:-420}"
PASSBOLT_INIT_TIMEOUT="${PASSBOLT_INIT_TIMEOUT:-900}"

# --- output ------------------------------------------------------------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_DIM=$'\033[2m'
  C_OK=$'\033[32m'
  C_WARN=$'\033[33m'
  C_ERR=$'\033[31m'
  C_BOLD=$'\033[1m'
  C_OFF=$'\033[0m'
else
  C_DIM='' C_OK='' C_WARN='' C_ERR='' C_BOLD='' C_OFF=''
fi

info () { printf '%s\n' "$*"; }
dim () { printf '%s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }
ok () { printf '%s✓%s %s\n' "$C_OK" "$C_OFF" "$*"; }
warn () { printf '%s!%s %s\n' "$C_WARN" "$C_OFF" "$*" >&2; }
err () { printf '%sx%s %s\n' "$C_ERR" "$C_OFF" "$*" >&2; }

die () {
  err "$*"
  exit 1
}

# --- docker plumbing ---------------------------------------------------------

require_docker () {
  command -v docker >/dev/null 2>&1 || die "docker is not installed. Install Docker Desktop or colima, then run this again."
  docker info >/dev/null 2>&1 || die "cannot talk to the docker daemon. Start Docker (or \`colima start\`) first."
}

container_exists () {
  docker container inspect "$1" >/dev/null 2>&1
}

container_running () {
  [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || echo false)" = "true" ]
}

network_exists () {
  docker network inspect "$1" >/dev/null 2>&1
}

volume_exists () {
  docker volume inspect "$1" >/dev/null 2>&1
}

# ensure_image <canonical-ref> <path-under-the-mirror>
#
# Pulls docker.io/<canonical-ref>; if that is unreachable (the usual case
# behind the GFW) and PASSBOLT_REGISTRY_MIRROR is set, pulls the same image
# from the mirror and tags it with the canonical name, so the rest of the
# script — and later runs — only ever see the canonical reference.
ensure_image () {
  local canonical="$1"
  local mirror_path="$canonical"
  case "${canonical%:*}" in
    */*) ;;
    *) mirror_path="library/$canonical" ;;
  esac

  docker image inspect "$canonical" >/dev/null 2>&1 && return 0

  info "pulling $canonical (first run only, a few hundred MB) ..."
  if docker pull "$canonical" >/dev/null 2>&1; then
    return 0
  fi

  if [ -n "${PASSBOLT_REGISTRY_MIRROR:-}" ]; then
    local mirror_ref="${PASSBOLT_REGISTRY_MIRROR%/}/${mirror_path}"
    warn "docker.io unreachable, trying ${mirror_ref}"
    docker pull "$mirror_ref" >/dev/null 2>&1 || die "failed to pull ${mirror_ref} too"
    docker tag "$mirror_ref" "$canonical"
    return 0
  fi

  die "failed to pull ${canonical}.
Docker Hub is unreachable from here. Retry through a registry mirror:
  PASSBOLT_REGISTRY_MIRROR=docker.1panel.live ./scripts/passbolt-start.sh
or point at images you already have:
  PASSBOLT_IMAGE=<ref> PASSBOLT_DB_IMAGE=<ref> ./scripts/passbolt-start.sh"
}

db_query () {
  docker exec -i "$PASSBOLT_DB_CONTAINER" \
    mariadb -u"$PASSBOLT_DB_USER" -p"$PASSBOLT_DB_PASSWORD" "$PASSBOLT_DB_NAME" \
    -N -B -e "$1" 2>/dev/null
}

# --- readiness ---------------------------------------------------------------

# mariadb-admin ping answers once the server accepts connections, which is
# earlier than "the passbolt schema exists" — that is wait_for_passbolt's job.
wait_for_db () {
  local deadline=$((SECONDS + 120))
  while [ $SECONDS -lt $deadline ]; do
    if docker exec "$PASSBOLT_DB_CONTAINER" \
      mariadb-admin ping -h 127.0.0.1 -uroot -p"$PASSBOLT_DB_ROOT_PASSWORD" --silent \
      >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# /auth/verify.json carries the server key, so a 200 with keydata means the
# migrations are done, the server key exists and the web server is serving.
wait_for_passbolt () {
  local deadline=$((SECONDS + PASSBOLT_START_TIMEOUT))
  local body=''
  while [ $SECONDS -lt $deadline ]; do
    body="$(curl -fsS --max-time 5 "${PASSBOLT_URL}/auth/verify.json" 2>/dev/null || true)"
    if printf '%s' "$body" | grep -q '"keydata"'; then
      return 0
    fi
    sleep 3
  done
  return 1
}

server_fingerprint () {
  local body
  body="$(curl -fsS --max-time 5 "${PASSBOLT_URL}/auth/verify.json" 2>/dev/null || true)"
  # Passbolt 5 wraps payloads as {header, body}; older builds answered flat
  printf '%s' "$body" | python3 -c 'import json,sys
try:
    data = json.load(sys.stdin)
except Exception:
    print("")
    raise SystemExit
body = data.get("body") if isinstance(data.get("body"), dict) else data
print(body.get("fingerprint", ""))' 2>/dev/null || true
}

print_rig () {
  printf '\n%sLocal Passbolt%s  %s\n' "$C_BOLD" "$C_OFF" "$PASSBOLT_URL"
  dim "  containers  $PASSBOLT_CONTAINER, $PASSBOLT_DB_CONTAINER"
  dim "  volumes     $PASSBOLT_DB_VOLUME, $PASSBOLT_GPG_VOLUME, $PASSBOLT_JWT_VOLUME"
  dim "  admin       $PASSBOLT_ADMIN_EMAIL"
  dim "  state       $PASSBOLT_STATE_DIR"
}

assert_email () {
  printf '%s' "$PASSBOLT_ADMIN_EMAIL" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$' ||
    die "PASSBOLT_ADMIN_EMAIL is not a valid email: $PASSBOLT_ADMIN_EMAIL"
}

tail_log () {
  local container="$1"
  dim "--- last lines of docker logs $container ---"
  docker logs --tail 25 "$container" 2>&1 || true
  dim '---'
}
