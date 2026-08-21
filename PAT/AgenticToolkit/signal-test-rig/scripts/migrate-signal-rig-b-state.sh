#!/usr/bin/env bash
# Migrate signal-cli state for burner B (+15550100006) from the local Mac
# to the pat-signal-rig-b Fly volume.
#
# This is the single-account companion to migrate-signal-rig-state.sh.
# The "split rig" topology (see README "Two-burner topology") gives each
# burner its own Fly app + volume + signal-cli identity store, so the
# multi-account daemon's shared identity store can't cross-contaminate
# sibling burners' decryption state.
#
# This script differs from the multi-account script in one place: after
# extracting the tarball it overwrites data/accounts.json on the volume
# with a single-account version (only the named account's entry). The
# local Mac's accounts.json typically lists multiple burners, so copying
# it verbatim would defeat the isolation we just paid for.
#
# Approach (same chicken-and-egg dance as the multi-account script):
#   1. Override the machine command to `sleep 3600` so SSH stays up even
#      when the volume is empty / the daemon crash-loops.
#   2. Resolve E164 → hash path via the local accounts.json.
#   3. Tarball data/<hash>/ + data/<hash>.d/ from the local Mac for the
#      single named account. accounts.json is NOT tarred — we rewrite it
#      in place on the volume.
#   4. SFTP the tarball into /tmp on the machine.
#   5. Extract on the volume, then write a single-account accounts.json
#      with only the named E164 + path + uuid.
#   6. Restore the original command and restart the machine.
#
# Idempotent.
#
# Usage:
#   scripts/migrate-signal-rig-b-state.sh +15550100006
#
# Env overrides:
#   PAT_SIGNAL_RIG_B_APP   default: pat-signal-rig-b

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: migrate-signal-rig-b-state.sh <E164>" >&2
  exit 64
fi

ACCOUNT="$1"
SIGNAL_DIR="${HOME}/.local/share/signal-cli"
ACCOUNTS_JSON="${SIGNAL_DIR}/data/accounts.json"
APP="${PAT_SIGNAL_RIG_B_APP:-pat-signal-rig-b}"
VOLUME_MOUNT="/root/.local/share/signal-cli"

if [ ! -f "$ACCOUNTS_JSON" ]; then
  echo "FATAL: accounts.json not found: $ACCOUNTS_JSON" >&2
  exit 1
fi

ACCOUNT_PATH=$(jq -r --arg num "$ACCOUNT" \
  '.accounts[] | select(.number == $num) | .path' "$ACCOUNTS_JSON")
ACCOUNT_UUID=$(jq -r --arg num "$ACCOUNT" \
  '.accounts[] | select(.number == $num) | .uuid' "$ACCOUNTS_JSON")
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
echo "    $ACCOUNT → data/${ACCOUNT_PATH}{,.d}  (uuid: $ACCOUNT_UUID)"

echo "==> Finding signal-rig-b machine on $APP"
MACHINE_ID=$(
  flyctl machines list -a "$APP" --json \
    | jq -r '.[0].id'
)
if [ -z "$MACHINE_ID" ] || [ "$MACHINE_ID" = "null" ]; then
  echo "FATAL: no machine found on $APP. Has the app been deployed?" >&2
  echo "       Run: flyctl deploy -c fly.b.toml --remote-only" >&2
  exit 1
fi
echo "    machine: $MACHINE_ID"

echo "==> Packing state from local Mac"
TAR_FILE=$(mktemp -t signal-rig-b-state.XXXXXX.tar.gz)
# COPYFILE_DISABLE=1 stops macOS bsdtar from emitting AppleDouble ._foo
# sidecars; the volume side's GNU tar will warn on `LIBARCHIVE.xattr.*`
# headers either way, but the actual entries we extract will be clean.
COPYFILE_DISABLE=1 tar -czf "$TAR_FILE" -C "${SIGNAL_DIR}" \
  "data/${ACCOUNT_PATH}" "data/${ACCOUNT_PATH}.d"
echo "    tar size: $(du -h "$TAR_FILE" | cut -f1)"

ORIGINAL_CMD="/app/entrypoint.sh"
echo "==> Overriding machine command to 'sleep 3600' so we can SSH safely"
flyctl machine update "$MACHINE_ID" -a "$APP" \
  --command "/bin/sh -c 'sleep 3600'" \
  --yes >/dev/null
flyctl machine start "$MACHINE_ID" -a "$APP" >/dev/null 2>&1 || true
sleep 5

echo "==> Uploading tarball via flyctl ssh sftp"
flyctl ssh sftp shell -a "$APP" <<EOF
put $TAR_FILE /tmp/signal-rig-b-state.tar.gz
EOF

echo "==> Extracting tarball + writing single-account accounts.json"
flyctl ssh console -a "$APP" -C "/bin/sh -c '
  set -e
  cd $VOLUME_MOUNT
  mkdir -p data
  tar -xzf /tmp/signal-rig-b-state.tar.gz
  rm /tmp/signal-rig-b-state.tar.gz
  cat > data/accounts.json <<JSON
{
  \"accounts\" : [ {
    \"path\" : \"${ACCOUNT_PATH}\",
    \"environment\" : \"LIVE\",
    \"number\" : \"${ACCOUNT}\",
    \"uuid\" : \"${ACCOUNT_UUID}\"
  } ],
  \"version\" : 2
}
JSON
  echo \"---- accounts.json ----\"
  cat data/accounts.json
  echo \"---- data/ listing ----\"
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
                                                       # then "rig.ready" with [${ACCOUNT}]
  2. URL="https://$APP.fly.dev"
     TOKEN="<the SIGNAL_TEST_RIG_TOKEN value>"
     curl -sS "\$URL/healthz"
     curl -sS -H "Authorization: Bearer \$TOKEN" "\$URL/status" | jq
                                                       # accounts: [${ACCOUNT}], bridge_connected: true
  3. Cross-app B2B test (see README "Two-burner topology" → "Verification").
EOM
