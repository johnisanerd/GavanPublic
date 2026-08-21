#!/usr/bin/env bash
# Migrate signal-cli state from the local Mac to the pat-signal-rig Fly volume.
#
# Accepts N E164 numbers (each must already be registered locally with
# `signal-cli -a +1XXX register`) and packs all of their state into ONE
# tarball, then SFTPs it onto the volume. Multi-account daemons need
# every burner's data/<hash>/ + data/<hash>.d/ on disk, plus the shared
# data/accounts.json that maps E164s to hash paths.
#
# Approach (mirrors scripts/migrate-signal-state.sh from transports/):
#   1. Stop the Fly machine so signal-cli releases its data dir lock
#      (chicken-and-egg: if the volume has no state yet, the daemon
#      crash-loops to "stopped" and SSH closes off — handled by the
#      `flyctl machine update --command "sleep 3600"` override below).
#   2. Resolve E164 → hash path via the local accounts.json.
#   3. Tarball data/accounts.json + every data/<hash>/ + data/<hash>.d/
#      from the local Mac. Skip cache dirs (attachments/, avatars/,
#      stickers/, temp/) — they auto-rebuild and would bloat the tar.
#   4. SFTP the tarball into /tmp on the volume's machine.
#   5. Extract on the volume.
#   6. Restart the machine.
#
# Idempotent: re-running overwrites the on-volume copy of each named
# account's state. Local Mac state is untouched (read-only tar source).
#
# Prereqs:
#   - flyctl on PATH, authenticated against the org owning pat-signal-rig
#   - signal-cli registered locally for every named account
#     (~/.local/share/signal-cli/data/accounts.json must list them)
#   - pat_signal_rig_state volume exists on pat-signal-rig
#   - app has been deployed at least once (so there's a machine to SSH into)
#
# Usage:
#   scripts/migrate-signal-rig-state.sh +15550100005 +15550100006
#
# Env overrides:
#   PAT_SIGNAL_RIG_APP   default: pat-signal-rig

set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: migrate-signal-rig-state.sh <E164> [<E164> ...]" >&2
  exit 64
fi

ACCOUNTS=("$@")
SIGNAL_DIR="${HOME}/.local/share/signal-cli"
ACCOUNTS_JSON="${SIGNAL_DIR}/data/accounts.json"
APP="${PAT_SIGNAL_RIG_APP:-pat-signal-rig}"
VOLUME_MOUNT="/root/.local/share/signal-cli"

if [ ! -f "$ACCOUNTS_JSON" ]; then
  echo "FATAL: accounts.json not found: $ACCOUNTS_JSON" >&2
  echo "       signal-cli must be registered locally first." >&2
  exit 1
fi

# Resolve each E164 to its hash-keyed path. signal-cli 0.14.x stores
# accounts under data/<hash>.d/ (not data/<E164>.d/); accounts.json
# maps numbers to those paths.
TAR_PATHS=("data/accounts.json")
for ACCOUNT in "${ACCOUNTS[@]}"; do
  ACCOUNT_PATH=$(jq -r --arg num "$ACCOUNT" \
    '.accounts[] | select(.number == $num) | .path' "$ACCOUNTS_JSON")
  if [ -z "$ACCOUNT_PATH" ] || [ "$ACCOUNT_PATH" = "null" ]; then
    AVAILABLE=$(jq -r '.accounts[].number' "$ACCOUNTS_JSON" | tr '\n' ' ')
    echo "FATAL: account $ACCOUNT not registered in $ACCOUNTS_JSON" >&2
    echo "       Available accounts: $AVAILABLE" >&2
    exit 1
  fi
  LOCAL_DATA_DIR="${SIGNAL_DIR}/data/${ACCOUNT_PATH}.d"
  if [ ! -d "$LOCAL_DATA_DIR" ]; then
    echo "FATAL: account data dir not found: $LOCAL_DATA_DIR" >&2
    exit 1
  fi
  TAR_PATHS+=("data/${ACCOUNT_PATH}" "data/${ACCOUNT_PATH}.d")
  echo "    $ACCOUNT → data/${ACCOUNT_PATH}{,.d}"
done

echo "==> Finding signal-rig machine on $APP"
MACHINE_ID=$(
  flyctl machines list -a "$APP" --json \
    | jq -r '.[0].id'
)
if [ -z "$MACHINE_ID" ] || [ "$MACHINE_ID" = "null" ]; then
  echo "FATAL: no machine found on $APP. Has the app been deployed?" >&2
  echo "       Run: flyctl deploy --remote-only" >&2
  exit 1
fi
echo "    machine: $MACHINE_ID"

echo "==> Packing state from local Mac"
TAR_FILE=$(mktemp -t signal-rig-state.XXXXXX.tar.gz)
tar -czf "$TAR_FILE" -C "${SIGNAL_DIR}" "${TAR_PATHS[@]}"
echo "    tar size: $(du -h "$TAR_FILE" | cut -f1)"

# Chicken-and-egg handling: the volume might be empty on first run, in
# which case signal-cli crash-loops and the machine can't be SSH'd. We
# override the machine command to `sleep` so we can SSH in, upload state,
# then restore the original entrypoint and restart.
ORIGINAL_CMD="/app/entrypoint.sh"
echo "==> Overriding machine command to 'sleep 3600' so we can SSH safely"
flyctl machine update "$MACHINE_ID" -a "$APP" \
  --command "/bin/sh -c 'sleep 3600'" \
  --yes >/dev/null
# If the VM was stopped (e.g. crashed past restart-cap on an earlier failed
# deploy), `machine update` leaves it stopped — subsequent SSH would fail
# with "no started VMs". Force-start; idempotent if already running.
flyctl machine start "$MACHINE_ID" -a "$APP" >/dev/null 2>&1 || true
# Give Fly a moment to apply the update + bring the override up.
sleep 5

echo "==> Uploading tarball via flyctl ssh sftp"
flyctl ssh sftp shell -a "$APP" <<EOF
put $TAR_FILE /tmp/signal-rig-state.tar.gz
EOF

echo "==> Extracting tarball into volume mount ($VOLUME_MOUNT)"
flyctl ssh console -a "$APP" -C "/bin/sh -c '
  set -e
  cd $VOLUME_MOUNT
  mkdir -p data
  tar -xzf /tmp/signal-rig-state.tar.gz
  rm /tmp/signal-rig-state.tar.gz
  ls -la data/ | head -20
'"

echo "==> Restoring machine command and restarting"
flyctl machine update "$MACHINE_ID" -a "$APP" \
  --command "$ORIGINAL_CMD" \
  --yes >/dev/null
flyctl machine restart "$MACHINE_ID" -a "$APP" >/dev/null

rm "$TAR_FILE"

cat <<EOM
==> Done.

Verify:
  1. flyctl logs -a $APP                              # expect "starting signal-cli multi-account daemon"
                                                       # then "rig.ready" with accounts list
  2. URL="https://$APP.fly.dev"
     TOKEN="<the SIGNAL_TEST_RIG_TOKEN value>"
     curl -sS "\$URL/healthz"                         # {"status":"ok",...}
     curl -sS -H "Authorization: Bearer \$TOKEN" "\$URL/status" | jq
                                                       # accounts: [+A, +B], bridge_connected: true
  3. Send a DM from one configured burner to another, watch the rig's
     WS for an inbound.text with the right data.account.
EOM
