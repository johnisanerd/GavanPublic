#!/usr/bin/env bash
# Migrate signal-cli state from the local Mac to the pat-transports Fly volume.
#
# One-shot. Run once after `flyctl volumes create pat_signal_state` and the
# first `flyctl deploy` that brought up the signal process group. After this,
# the identity (+15550100003, primary device re-registered 2026-05-11) lives
# on the volume and survives machine restarts.
#
# Approach:
#   1. Stop the signal Fly machine (so signal-cli releases its data dir lock)
#   2. Tarball ONLY data/<account>.d/ from the local Mac
#      (account.db + identity keys + prekeys. Cache subdirs — attachments/,
#      avatars/, stickers/, temp/ — auto-rebuild; safer to NOT carry them.)
#   3. SFTP the tarball into the Fly volume's mount path
#   4. Extract on the volume
#   5. Restart the signal machine
#   6. Smoke-test by checking signal-cli listIdentities reaches the daemon
#
# Idempotent in the sense that re-running with the same account just
# overwrites the data/<account>.d/ on the volume. Local Mac state is
# untouched (read-only tar source).
#
# Prereqs:
#   - flyctl on PATH, authenticated against the palisade org
#   - signal-cli identity already registered locally at
#     ~/.local/share/signal-cli/data/<account>.d/
#   - pat_signal_state volume exists on pat-transports
#   - signal process group has been deployed at least once
#
# Usage:
#   scripts/migrate-signal-state.sh +15550100003

set -euo pipefail

ACCOUNT="${1:?usage: migrate-signal-state.sh <E164>}"
SIGNAL_DIR="${HOME}/.local/share/signal-cli"
ACCOUNTS_JSON="${SIGNAL_DIR}/data/accounts.json"
APP="${PAT_TRANSPORTS_APP:-pat-transports}"
PROCESS_GROUP="signal"

if [ ! -f "$ACCOUNTS_JSON" ]; then
  echo "FATAL: accounts.json not found: $ACCOUNTS_JSON" >&2
  echo "       signal-cli must be registered locally first — see add-signal SKILL.md" >&2
  exit 1
fi

# signal-cli 0.14.x stores accounts under hash-keyed paths (e.g.
# data/925674.d/) rather than data/<E164>.d/. accounts.json maps
# numbers to those paths.
ACCOUNT_PATH=$(jq -r --arg num "$ACCOUNT" '.accounts[] | select(.number == $num) | .path' "$ACCOUNTS_JSON")
if [ -z "$ACCOUNT_PATH" ] || [ "$ACCOUNT_PATH" = "null" ]; then
  echo "FATAL: account $ACCOUNT not registered in $ACCOUNTS_JSON" >&2
  echo "       Available accounts: $(jq -r '.accounts[].number' "$ACCOUNTS_JSON" | tr '\n' ' ')" >&2
  exit 1
fi
LOCAL_DATA_DIR="${SIGNAL_DIR}/data/${ACCOUNT_PATH}.d"

if [ ! -d "$LOCAL_DATA_DIR" ]; then
  echo "FATAL: account data dir not found: $LOCAL_DATA_DIR" >&2
  exit 1
fi

echo "==> Stopping signal process group on $APP"
SIGNAL_MACHINE_ID=$(
  flyctl machines list -a "$APP" --json \
    | jq -r ".[] | select(.config.metadata.fly_process_group == \"$PROCESS_GROUP\") | .id" \
    | head -n1
)
if [ -z "$SIGNAL_MACHINE_ID" ]; then
  echo "FATAL: no machine found in process group '$PROCESS_GROUP'. Has the signal process group been deployed?" >&2
  exit 1
fi
flyctl machine stop "$SIGNAL_MACHINE_ID" -a "$APP"

echo "==> Packing data/{accounts.json, ${ACCOUNT_PATH}, ${ACCOUNT_PATH}.d/} from local Mac"
TAR_FILE=$(mktemp -t signal-state.XXXXXX.tar.gz)
tar -czf "$TAR_FILE" \
  -C "${SIGNAL_DIR}" \
  "data/accounts.json" \
  "data/${ACCOUNT_PATH}" \
  "data/${ACCOUNT_PATH}.d"
echo "    tar size: $(du -h "$TAR_FILE" | cut -f1)"

echo "==> Starting signal machine (so we can SFTP into it)"
flyctl machine start "$SIGNAL_MACHINE_ID" -a "$APP"

# Wait for the machine to be back so we can sftp.
sleep 5

echo "==> Uploading tarball via flyctl ssh sftp"
flyctl ssh sftp shell -a "$APP" --process-group "$PROCESS_GROUP" <<EOF
put $TAR_FILE /tmp/signal-state.tar.gz
EOF

echo "==> Extracting tarball into volume mount"
flyctl ssh console -a "$APP" --process-group "$PROCESS_GROUP" -C "/bin/sh -c '
  set -e
  cd /root/.local/share/signal-cli
  mkdir -p data
  tar -xzf /tmp/signal-state.tar.gz
  rm /tmp/signal-state.tar.gz
  ls -la data/
'"

echo "==> Restarting signal machine to pick up new state"
flyctl machine restart "$SIGNAL_MACHINE_ID" -a "$APP"

rm "$TAR_FILE"

cat <<'EOM'
==> Done.

Verify:
  1. flyctl logs -a pat-transports --process signal     # should show "Listening on fly-local-6pn:7583"
  2. flyctl ssh console -a pat-transports --process signal -C "signal-cli listIdentities" | head
  3. On pat-nanoclaw: flyctl logs -a pat-nanoclaw | grep "Signal channel connected"
  4. Send a DM from another Signal account, watch for routing.message-routed in host log
EOM
