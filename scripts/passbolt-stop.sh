#!/usr/bin/env bash
# Stop the local Passbolt server started by passbolt-start.sh.
#
#   ./scripts/passbolt-stop.sh          stop both containers, keep the data
#   ./scripts/passbolt-stop.sh --purge  remove containers, volumes and the key
#
# --purge asks first; add --yes to use it from a script. The rig holds nothing
# but test data, but it does hold the admin user's private key under
# scripts/.passbolt/, so it is not deleted silently.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/passbolt-lib.sh"

PURGE=0
YES=0

for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    --yes|-y) YES=1 ;;
    -h|--help)
      sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $arg (try --help)" ;;
  esac
done

require_docker

stopped=0
# passbolt first: letting it see the database go away only creates noise in the log
for name in "$PASSBOLT_CONTAINER" "$PASSBOLT_DB_CONTAINER"; do
  if container_running "$name"; then
    docker stop "$name" >/dev/null
    ok "stopped $name"
    stopped=$((stopped + 1))
  elif container_exists "$name"; then
    dim "$name already stopped"
  else
    dim "$name does not exist"
  fi
done

if [ "$PURGE" = 0 ]; then
  if [ "$stopped" -eq 0 ]; then
    info "nothing to stop"
  else
    dim "data is kept; \`./scripts/passbolt-start.sh\` resumes the same server"
  fi
  exit 0
fi

if [ "$YES" -eq 0 ] && [ -t 0 ]; then
  printf 'Remove the containers, the volumes (%s, %s, %s) and %s? [y/N] ' \
    "$PASSBOLT_DB_VOLUME" "$PASSBOLT_GPG_VOLUME" "$PASSBOLT_JWT_VOLUME" "$PASSBOLT_STATE_DIR"
  read -r answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) info "kept everything"; exit 0 ;;
  esac
fi

for name in "$PASSBOLT_CONTAINER" "$PASSBOLT_DB_CONTAINER"; do
  container_exists "$name" && docker rm -f "$name" >/dev/null && dim "removed container $name"
done

for vol in "$PASSBOLT_DB_VOLUME" "$PASSBOLT_GPG_VOLUME" "$PASSBOLT_JWT_VOLUME"; do
  volume_exists "$vol" && docker volume rm "$vol" >/dev/null && dim "removed volume $vol"
done

network_exists "$PASSBOLT_NETWORK" && docker network rm "$PASSBOLT_NETWORK" >/dev/null && dim "removed network $PASSBOLT_NETWORK"

if [ -d "$PASSBOLT_STATE_DIR" ]; then
  rm -rf "$PASSBOLT_STATE_DIR"
  dim "removed $PASSBOLT_STATE_DIR (contained the test key)"
fi

ok "purged — the next passbolt-start.sh builds a fresh server"
