#!/usr/bin/env bash
# Start (creating on first run) a throwaway Passbolt server on localhost, for
# testing the passbolt-search widget against a real instance.
#
#   ./scripts/passbolt-start.sh
#
# First run pulls mariadb and the Passbolt CE image, generates the server key
# and runs the migrations — that takes a couple of minutes. Later runs reuse
# the same containers and volumes, so start is a few seconds.
#
# Stop with ./scripts/passbolt-stop.sh, wipe with ./scripts/passbolt-stop.sh --purge.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/passbolt-lib.sh"

require_docker
ensure_image "$PASSBOLT_DB_IMAGE"
ensure_image "$PASSBOLT_IMAGE"

if ! network_exists "$PASSBOLT_NETWORK"; then
  docker network create "$PASSBOLT_NETWORK" >/dev/null
  dim "created network $PASSBOLT_NETWORK"
fi

# --- database ----------------------------------------------------------------

if container_exists "$PASSBOLT_DB_CONTAINER"; then
  if container_running "$PASSBOLT_DB_CONTAINER"; then
    dim "$PASSBOLT_DB_CONTAINER already running"
  else
    docker start "$PASSBOLT_DB_CONTAINER" >/dev/null
    dim "started $PASSBOLT_DB_CONTAINER"
  fi
else
  docker run -d \
    --name "$PASSBOLT_DB_CONTAINER" \
    --network "$PASSBOLT_NETWORK" \
    -e MARIADB_ROOT_PASSWORD="$PASSBOLT_DB_ROOT_PASSWORD" \
    -e MARIADB_DATABASE="$PASSBOLT_DB_NAME" \
    -e MARIADB_USER="$PASSBOLT_DB_USER" \
    -e MARIADB_PASSWORD="$PASSBOLT_DB_PASSWORD" \
    -v "${PASSBOLT_DB_VOLUME}:/var/lib/mysql" \
    "$PASSBOLT_DB_IMAGE" >/dev/null
  dim "created $PASSBOLT_DB_CONTAINER"
fi

if ! wait_for_db; then
  tail_log "$PASSBOLT_DB_CONTAINER"
  die "the database did not become ready in 120s"
fi
ok "database ready"

# --- passbolt ----------------------------------------------------------------

if container_exists "$PASSBOLT_CONTAINER"; then
  if container_running "$PASSBOLT_CONTAINER"; then
    dim "$PASSBOLT_CONTAINER already running"
  else
    docker start "$PASSBOLT_CONTAINER" >/dev/null
    dim "started $PASSBOLT_CONTAINER"
  fi
else
  # APP_FULL_BASE_URL is what the server signs into the JWT challenge and what
  # the setup links point at, so it has to match the URL the widget is given.
  # The CE image reads CakePHP's own datasource variables, not DATABASE_URL:
  # app.default.php does `env('DATASOURCES_DEFAULT_HOST', 'localhost')`, so a
  # single DATABASE_URL is silently ignored and the installer ends up on a
  # unix socket ("SQLSTATE[HY000] [2002] No such file or directory").
  docker run -d \
    --name "$PASSBOLT_CONTAINER" \
    --network "$PASSBOLT_NETWORK" \
    -p "${PASSBOLT_PORT}:80" \
    -e APP_FULL_BASE_URL="$PASSBOLT_URL" \
    -e DATASOURCES_DEFAULT_HOST="$PASSBOLT_DB_CONTAINER" \
    -e DATASOURCES_DEFAULT_PORT="3306" \
    -e DATASOURCES_DEFAULT_DATABASE="$PASSBOLT_DB_NAME" \
    -e DATASOURCES_DEFAULT_USERNAME="$PASSBOLT_DB_USER" \
    -e DATASOURCES_DEFAULT_PASSWORD="$PASSBOLT_DB_PASSWORD" \
    -e EMAIL_DEFAULT_FROM="passbolt@localhost" \
    -v "${PASSBOLT_GPG_VOLUME}:/etc/passbolt/gpg" \
    -v "${PASSBOLT_JWT_VOLUME}:/etc/passbolt/jwt" \
    "$PASSBOLT_IMAGE" >/dev/null
  dim "created $PASSBOLT_CONTAINER"
fi

info "waiting for ${PASSBOLT_URL}/auth/verify.json (migrations on first run take a while) ..."
if ! wait_for_passbolt; then
  tail_log "$PASSBOLT_CONTAINER"
  die "the server did not answer at ${PASSBOLT_URL} within ${PASSBOLT_START_TIMEOUT}s"
fi

fingerprint="$(server_fingerprint)"
ok "server ready"
print_rig
if [ -n "$fingerprint" ]; then
  printf '  fingerprint %s\n' "$fingerprint"
  dim "  this is the value the widget shows when it asks you to trust the server"
fi

if ! db_query "select id from users where deleted=0 limit 1" | grep -q .; then
  printf '\n'
  warn "no account yet — finish it with: ./scripts/passbolt-init.sh"
fi
