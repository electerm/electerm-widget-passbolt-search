#!/usr/bin/env bash
# Create the account on the local Passbolt server and print the exact values
# the passbolt-search widget needs.
#
#   ./scripts/passbolt-init.sh              start if needed, seed an account, print the values
#   ./scripts/passbolt-init.sh --browser    go through Passbolt's own setup page instead
#   ./scripts/passbolt-init.sh --no-start   assume the server is already up
#   ./scripts/passbolt-init.sh --no-samples skip the sample entries (they are seeded by default)
#
# Seeding (the default) writes the rows a completed setup would leave behind:
# an active user, a profile and a 4096-bit key. The account authenticates like
# any other one — the server verifies the JWT challenge against the key it has —
# it just never consumed a setup token. This is the only way to get an account
# without a browser: Passbolt 5's setup page refuses to run unless the Passbolt
# browser extension is installed.
#
# Sample entries: the seeded account also gets one entry per resource type the
# server ships — simple password, password with description, TOTP, the v5
# equivalents and a note — so the widget has something real to search, decrypt
# and open. They are encrypted to that account's key, so they need the seeded
# passphrase; --browser accounts skip them.
#
# --browser uses the real flow: register_user, open the setup link, wait until
# the account has a key, then copy the downloaded key into scripts/.passbolt/.
# Use it if you want to exercise Passbolt's own key generation as well; install
# the extension for Chrome/Edge/Firefox first, or the page will only show
# "Please install the browser extension".

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/passbolt-lib.sh"

MODE=seed
NO_START=0
NO_OPEN=0
NO_WAIT=0
SAMPLES=1
SAMPLES_SEEDED=0
PASSBOLT_SEED_PASSPHRASE="${PASSBOLT_SEED_PASSPHRASE:-passbolt-test}"

while [ $# -gt 0 ]; do
  case "$1" in
    --browser) MODE=browser ;;
    --seed) MODE=seed ;;
    --no-start) NO_START=1 ;;
    --samples) SAMPLES=1 ;;
    --no-samples) SAMPLES=0 ;;
    --no-open) NO_OPEN=1 ;;
    --no-wait) NO_WAIT=1 ;;
    --passphrase)
      shift
      [ $# -gt 0 ] || die "--passphrase needs a value"
      PASSBOLT_SEED_PASSPHRASE="$1"
      ;;
    --timeout)
      shift
      [ $# -gt 0 ] || die "--timeout needs a number of seconds"
      PASSBOLT_INIT_TIMEOUT="$1"
      ;;
    -h|--help)
      awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

require_docker
assert_email

user_id_by_email () {
  db_query "select id from users where username='${PASSBOLT_ADMIN_EMAIL}' and deleted=0 order by created asc limit 1" || true
}

user_has_key () {
  local n
  n="$(db_query "select count(*) from gpgkeys where user_id='$1' and deleted=0" || true)"
  [ -n "$n" ] && [ "$n" -gt 0 ] 2>/dev/null
}

state_value () {
  [ -f "${PASSBOLT_STATE_DIR}/state.env" ] || return 0
  sed -n "s/^$1=//p" "${PASSBOLT_STATE_DIR}/state.env" | head -1 || true
}

# Newest private key that landed in ~/Downloads in the last two hours and looks
# like this account's. Read-only: it only stats and reads the first 200 bytes.
newest_downloaded_key () {
  local dir="${HOME}/Downloads"
  [ -d "$dir" ] || return 0
  python3 - "$dir" "$PASSBOLT_ADMIN_EMAIL" <<'PY' 2>/dev/null || true
import os
import sys
import time

folder, email = sys.argv[1], sys.argv[2]
local_part = email.split('@')[0].lower()
now = time.time()
found = []

for name in os.listdir(folder):
    low = name.lower()
    if not low.endswith(('.asc', '.key', '.pgp', '.gpg', '.txt')):
        continue
    if 'passbolt' not in low and local_part not in low and 'private' not in low:
        continue
    path = os.path.join(folder, name)
    if not os.path.isfile(path):
        continue
    try:
        mtime = os.stat(path).st_mtime
        if now - mtime > 7200:
            continue
        with open(path, errors='replace') as handle:
            head = handle.read(200)
    except OSError:
        continue
    if 'PRIVATE KEY BLOCK' not in head:
        continue
    found.append((mtime, path))

if found:
    found.sort()
    print(found[-1][1])
PY
}

write_state () {
  local uuid="${1:-}"
  local key="${2:-}"
  local setup="${3:-}"
  local passphrase="${4:-}"

  mkdir -p "$PASSBOLT_STATE_DIR"
  chmod 700 "$PASSBOLT_STATE_DIR"

  # register_user only prints the setup link once, so keep an earlier one
  if [ -z "$setup" ]; then
    setup="$(state_value PASSBOLT_SETUP_URL)"
  fi
  if [ -z "$passphrase" ]; then
    passphrase="$(state_value PASSBOLT_PASSPHRASE)"
  fi

  {
    printf 'PASSBOLT_URL=%s\n' "$PASSBOLT_URL"
    printf 'PASSBOLT_USER_ID=%s\n' "$uuid"
    printf 'PASSBOLT_ADMIN_EMAIL=%s\n' "$PASSBOLT_ADMIN_EMAIL"
    printf 'PASSBOLT_KEY_PATH=%s\n' "$key"
    printf 'PASSBOLT_FINGERPRINT=%s\n' "$(server_fingerprint)"
    if [ -n "$passphrase" ]; then
      printf 'PASSBOLT_PASSPHRASE=%s\n' "$passphrase"
    fi
    if [ -n "$setup" ]; then
      printf 'PASSBOLT_SETUP_URL=%s\n' "$setup"
    fi
  } > "${PASSBOLT_STATE_DIR}/state.env"
  chmod 600 "${PASSBOLT_STATE_DIR}/state.env"
}

print_widget_values () {
  local uuid="$1"
  local key="$2"
  local fingerprint="$3"
  local passphrase="$4"

  printf '\n%sPaste this into the passbolt-search widget%s\n' "$C_BOLD" "$C_OFF"
  printf '  %-12s %s\n' "Server URL" "$PASSBOLT_URL"
  printf '  %-12s %s\n' "User ID" "$uuid"
  if [ -n "$key" ]; then
    printf '  %-12s %s\n' "GPG key file" "$key"
  else
    printf '  %-12s %s\n' "GPG key file" "(the .asc you downloaded)"
  fi
  if [ -n "$passphrase" ]; then
    printf '  %-12s %s\n' "Passphrase" "$passphrase"
  else
    printf '  %-12s %s\n' "Passphrase" "(the one you typed in the setup page)"
  fi
  printf '  %-12s %s\n' "Search" "(anything, e.g. test)"
  printf '\n  On the first Connect the widget shows the server fingerprint:\n'
  printf '  %s\n' "${fingerprint:-<unavailable>}"
  dim "  Compare it with the line above, then Trust this key and connect."
  printf '\n'
  if [ "$SAMPLES_SEEDED" -eq 1 ]; then
    dim "  The account has the 8 sample entries — try searching for \"router\" or \"v5\"."
  else
    dim "  The account starts with no passwords, so Search returns an empty table"
    dim "  until you add an entry — that is not a bug."
  fi
}

# One entry per Passbolt resource type, encrypted to the account's own key:
# legacy (v4) simple password / password+description / TOTP, and v5 default,
# v5 with TOTP, v5 note. Needs the private key passphrase, which only the seeded
# account has, so --browser accounts skip this.
seed_sample_entries () {
  local uuid="$1"
  local passphrase key gpgkey_id sql out
  [ "$SAMPLES" -eq 1 ] || return 0
  passphrase="$(state_value PASSBOLT_PASSPHRASE)"
  key="$(state_value PASSBOLT_KEY_PATH)"
  if [ -z "$passphrase" ] || [ ! -f "$key" ]; then
    dim "  skipped the sample entries: the key passphrase is unknown (--browser account)"
    return 0
  fi
  gpgkey_id="$(db_query "select id from gpgkeys where user_id='$uuid' and deleted=0 order by created asc limit 1" || true)"
  [ -n "$gpgkey_id" ] || return 0

  sql="${PASSBOLT_STATE_DIR}/samples.sql"
  if ! out="$(node "${SCRIPT_DIR}/passbolt-samples.js" \
    --user-id "$uuid" \
    --gpgkey-id "$gpgkey_id" \
    --key "$key" \
    --passphrase "$passphrase" \
    --out "$sql")"; then
    warn "could not generate the sample entries; the account itself is fine"
    return 0
  fi
  if ! docker exec -i "$PASSBOLT_DB_CONTAINER" \
    mariadb -u"$PASSBOLT_DB_USER" -p"$PASSBOLT_DB_PASSWORD" "$PASSBOLT_DB_NAME" \
    < "$sql" 2>/dev/null; then
    rm -f "$sql"
    warn "could not insert the sample entries (schema changed?); the account itself is fine"
    return 0
  fi
  rm -f "$sql"
  SAMPLES_SEEDED=1
  printf '%s' "$out" | python3 -c 'import json,sys
data = json.load(sys.stdin)
print("  %d sample entries: %s" % (data["count"], ", ".join(data["names"])))'
}

print_existing () {
  local uuid="$1"
  local key="${PASSBOLT_STATE_DIR}/me.asc"
  local passphrase
  [ -f "$key" ] || key=""
  passphrase="$(state_value PASSBOLT_PASSPHRASE)"
  write_state "$uuid" "$key"
  ok "$PASSBOLT_ADMIN_EMAIL already exists"
  seed_sample_entries "$uuid"
  print_widget_values "$uuid" "$key" "${PASSBOLT_FINGERPRINT:-}" "$passphrase"
}

# --- start -------------------------------------------------------------------

if [ "$NO_START" -eq 0 ] && ! (container_running "$PASSBOLT_CONTAINER" && wait_for_passbolt); then
  info "starting the local server ..."
  "$SCRIPT_DIR/passbolt-start.sh"
fi

if ! container_running "$PASSBOLT_CONTAINER"; then
  die "$PASSBOLT_CONTAINER is not running. Run ./scripts/passbolt-start.sh first, or drop --no-start."
fi

PASSBOLT_FINGERPRINT="$(server_fingerprint)"
[ -n "$PASSBOLT_FINGERPRINT" ] || die "the server at ${PASSBOLT_URL} is not answering /auth/verify.json"

# --- already there? ----------------------------------------------------------

existing_id="$(user_id_by_email)"
if [ -n "$existing_id" ]; then
  if user_has_key "$existing_id"; then
    print_existing "$existing_id"
    exit 0
  fi
  err "$PASSBOLT_ADMIN_EMAIL exists without a key — an interrupted setup."
  saved_url="$(state_value PASSBOLT_SETUP_URL)"
  if [ "$MODE" = browser ] && [ -n "$saved_url" ]; then
    info "Finish the setup page from the last run, then run this again:"
    printf '  %s\n' "$saved_url"
    info "If that link has expired, reset the rig:"
  else
    info "Reset the rig and start over:"
  fi
  dim "  ./scripts/passbolt-stop.sh --purge && ./scripts/passbolt-init.sh"
  exit 1
fi

# --- seed (default) ----------------------------------------------------------

if [ "$MODE" = seed ]; then
  command -v node >/dev/null 2>&1 || die "node is not on PATH; the key generator needs it (or use --browser)."
  if [ ! -d "${SCRIPT_DIR}/../node_modules/openpgp" ]; then
    die "openpgp is missing from node_modules/. Run npm install in the repo root (or use --browser)."
  fi

  role_id="$(db_query "select id from roles where name='admin' limit 1")"
  [ -n "$role_id" ] || die "could not read the admin role from the database"

  info "seeding test account $PASSBOLT_ADMIN_EMAIL ..."
  seed_json="$(node "${SCRIPT_DIR}/passbolt-seed.js" \
    --email "$PASSBOLT_ADMIN_EMAIL" \
    --first "$PASSBOLT_ADMIN_FIRST_NAME" \
    --last "$PASSBOLT_ADMIN_LAST_NAME" \
    --role "$role_id" \
    --out-dir "$PASSBOLT_STATE_DIR" \
    --passphrase "$PASSBOLT_SEED_PASSPHRASE")" || die "key generation failed"

  read_field () {
    printf '%s' "$seed_json" | python3 -c "import json,sys; print(json.load(sys.stdin).get('$1',''))"
  }
  uuid="$(read_field userId)"
  key_path="$(read_field keyPath)"
  seed_sql="$(read_field sqlPath)"
  [ -n "$uuid" ] && [ -f "$seed_sql" ] || die "the key generator did not produce a seed file"

  if ! docker exec -i "$PASSBOLT_DB_CONTAINER" \
    mariadb -u"$PASSBOLT_DB_USER" -p"$PASSBOLT_DB_PASSWORD" "$PASSBOLT_DB_NAME" \
    < "$seed_sql" 2>/dev/null; then
    rm -f "$seed_sql"
    die "inserting the account rows failed (schema changed?)"
  fi
  rm -f "$seed_sql"

  if ! user_has_key "$uuid"; then
    die "the account row did not land — check \`docker logs $PASSBOLT_DB_CONTAINER\`"
  fi

  chmod 600 "$key_path" 2>/dev/null || true
  write_state "$uuid" "$key_path" "" "$PASSBOLT_SEED_PASSPHRASE"
  ok "account ready"
  seed_sample_entries "$uuid"
  print_widget_values "$uuid" "$key_path" "$PASSBOLT_FINGERPRINT" "$PASSBOLT_SEED_PASSPHRASE"
  printf '\n'
  ok "done — open electerm → Settings → Widgets → Import → electerm-widget-passbolt-search/"
  dim "  the key and the values above are also in ${PASSBOLT_STATE_DIR}/state.env"
  exit 0
fi

# --- browser setup -----------------------------------------------------------

info "creating admin user $PASSBOLT_ADMIN_EMAIL ..."
set +e
register_output="$(
  docker exec "$PASSBOLT_CONTAINER" \
    su -m -c "cd /usr/share/php/passbolt/ && bin/cake passbolt register_user -u '${PASSBOLT_ADMIN_EMAIL}' -f '${PASSBOLT_ADMIN_FIRST_NAME}' -l '${PASSBOLT_ADMIN_LAST_NAME}' -r admin" -s /bin/bash www-data 2>&1
)"
register_status=$?
set -e

if [ $register_status -ne 0 ]; then
  printf '%s\n' "$register_output"
  die "register_user failed (exit $register_status)"
fi

# cake colours its output; strip the escapes before looking for the link
plain_output="$(printf '%s\n' "$register_output" | tr -d '\033' | sed 's/\[[0-9;]*m//g')"
setup_url="$(printf '%s\n' "$plain_output" | grep -oE 'https?://[^[:space:]]+' | grep '/setup/' | head -1 || true)"
if [ -z "$setup_url" ]; then
  setup_url="$(printf '%s\n' "$plain_output" | grep -oE 'https?://[^[:space:]]+' | tail -1 || true)"
fi
[ -n "$setup_url" ] || {
  printf '%s\n' "$register_output"
  die "could not find the setup URL in the register_user output"
}

uuid="$(user_id_by_email)"
write_state "$uuid" "" "$setup_url"

printf '\n'
ok "user created"
printf '  setup link  %s\n' "$setup_url"
printf '  server key  %s\n' "$PASSBOLT_FINGERPRINT"
printf '\n%sFinish in the browser%s\n' "$C_BOLD" "$C_OFF"
warn "Passbolt 5 only runs its setup page with the browser extension installed."
dim "  1. install the Passbolt extension (Chrome / Edge / Firefox), then open the link"
dim "  2. pick a passphrase — that is the widget's \"Key passphrase\""
dim "  3. let it download the private key, keep the file"
dim "  4. do not enable MFA: the widget has no TOTP prompt"

if [ "$NO_OPEN" -eq 0 ]; then
  if command -v open >/dev/null 2>&1; then
    open "$setup_url" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$setup_url" >/dev/null 2>&1 || true
  fi
fi

if [ "$NO_WAIT" -eq 1 ]; then
  printf '\n'
  dim "Run ./scripts/passbolt-init.sh --browser again when the setup page is done."
  exit 0
fi

# --- wait for the setup page to be completed ---------------------------------

printf '\nwaiting for the account to be set up (max %ss, ctrl-c is fine) ' "$PASSBOLT_INIT_TIMEOUT"
deadline=$((SECONDS + PASSBOLT_INIT_TIMEOUT))
last_notice=$SECONDS
while [ $SECONDS -lt $deadline ]; do
  if user_has_key "$uuid"; then
    break
  fi
  if [ $((SECONDS - last_notice)) -ge 20 ]; then
    printf '.'
    last_notice=$SECONDS
  fi
  sleep 3
done
printf '\n'

if ! user_has_key "$uuid"; then
  err "the account is still unregistered after ${PASSBOLT_INIT_TIMEOUT}s"
  info "The setup link above is still valid — finish it, then run this again:"
  dim "  ./scripts/passbolt-init.sh --browser"
  exit 1
fi

key_path="$(newest_downloaded_key)"
if [ -n "$key_path" ]; then
  mkdir -p "$PASSBOLT_STATE_DIR"
  chmod 700 "$PASSBOLT_STATE_DIR"
  cp "$key_path" "${PASSBOLT_STATE_DIR}/me.asc"
  chmod 600 "${PASSBOLT_STATE_DIR}/me.asc"
  key_path="${PASSBOLT_STATE_DIR}/me.asc"
  ok "copied the downloaded key to $key_path"
else
  warn "no freshly downloaded private key found in ~/Downloads"
  info "In the web UI: profile menu (top right) → Download my key, then either pick that"
  info "file in the widget, or drop it at ${PASSBOLT_STATE_DIR}/me.asc"
fi

write_state "$uuid" "$key_path"
seed_sample_entries "$uuid"
print_widget_values "$uuid" "$key_path" "$PASSBOLT_FINGERPRINT" ""

ok "done — open electerm → Settings → Widgets → Import → electerm-widget-passbolt-search/"
