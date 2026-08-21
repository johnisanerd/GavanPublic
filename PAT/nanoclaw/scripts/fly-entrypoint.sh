#!/usr/bin/env bash
# Fly Machine entrypoint for pat-nanoclaw.
#
# Boot order:
#   1. Prepare /data tree (volume may be empty on first boot).
#   2. Start dockerd (background); wait for /var/run/docker.sock.
#   2.5. Ensure OneCLI gateway is up (idempotent; bootstraps if missing).
#   3. Build nanoclaw-agent image if not already in dockerd's cache.
#   3.5. Bridge Fly secrets → /app/nanoclaw/.env (allowlisted keys).
#   4. Drop to uid 1000 for the nanoclaw process.
#   5. Exec `node /app/dist/index.js` (the host process).
#
# Agent-group bootstrap is still done out-of-band via `flyctl ssh
# console` on a fresh deploy (one-time identity seeding).
set -eu

log() { echo "[fly-entrypoint] $(date -u +%FT%TZ) $*"; }

# ── 1. /data tree ─────────────────────────────────────────────────────────
# Volume is empty on the first boot of a new Fly Volume. Create the
# subdirs nanoclaw + dockerd expect; idempotent on subsequent boots.
log "preparing /data tree"
mkdir -p /data/nanoclaw/data /data/nanoclaw/groups /data/nanoclaw/store /data/docker

# PAT (task #41): wiki seed-import step removed. The Karpathy wiki
# skill (container/skills/wiki/) is still installed and the back-mind
# can grow the wiki organically — we just no longer pre-load it with
# 48 auto-memory entries on first boot. If you're looking for the
# prior `cp -rn /app/nanoclaw/container/wiki-seed/...` block, see
# commit 319f281^..HEAD for the removal context.

# nanoclaw uses process.cwd() as PROJECT_ROOT — that has to be the
# source directory, both because it's how install-slug derives the
# agent image tag (so the runtime asks for the same image we built at
# /app/nanoclaw) AND because container-runner bind-mounts
# `${PROJECT_ROOT}/container/agent-runner/src` into spawned containers.
# Set cwd to /app/nanoclaw and redirect the per-install state subdirs
# (data/, groups/, store/) into the volume via symlinks so they
# persist across deploys.
for sub in data groups store; do
  src="/app/nanoclaw/$sub"
  tgt="/data/nanoclaw/$sub"
  if [ -L "$src" ]; then
    continue                # already linked from a prior boot
  fi
  if [ -e "$src" ]; then
    log "WARNING: $src exists from image, removing so volume link wins"
    rm -rf "$src"
  fi
  ln -s "$tgt" "$src"
done

# ── 2. dockerd ────────────────────────────────────────────────────────────
log "starting dockerd"
# --host=unix:///var/run/docker.sock is the default but we set it explicitly
# so the docker CLI in this image picks it up without DOCKER_HOST gymnastics.
dockerd \
  --host=unix:///var/run/docker.sock \
  --pidfile=/var/run/docker.pid \
  >/var/log/dockerd.log 2>&1 &
DOCKERD_PID=$!
log "dockerd pid=$DOCKERD_PID"

# Wait up to 60s for the socket to come up. If dockerd fails (bad
# storage driver, missing kernel module, …) the loop bails out with a
# pointer to the log so we can see why on Fly.
for i in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then
    log "dockerd ready (after ${i}s)"
    break
  fi
  if ! kill -0 "$DOCKERD_PID" 2>/dev/null; then
    log "dockerd died during startup; tail of /var/log/dockerd.log:"
    tail -50 /var/log/dockerd.log >&2 || true
    exit 1
  fi
  sleep 1
done
docker info >/dev/null 2>&1 || {
  log "dockerd failed to come up in 60s; tail of /var/log/dockerd.log:"
  tail -50 /var/log/dockerd.log >&2 || true
  exit 1
}

# ── 2.5. OneCLI gateway ───────────────────────────────────────────────────
# The OneCLI gateway provides transparent secret injection for back-mind
# containers' outbound HTTPS traffic — every request from a spawned agent
# container is matched against host-patterns and the right Authorization
# header is added before it leaves the machine.
#
# State layering:
#   - Compose file at /root/.onecli/docker-compose.yml lives on the image
#     rootfs (bootstrapped on first install via `curl onecli.sh/install`).
#   - Container/volume state lives in /data/docker, so dockerd resumes
#     existing onecli containers across normal redeploys.
#
# Three branches, all idempotent:
#   A. Container running                  → no-op
#   B. Compose file present, container stopped → docker compose up
#   C. Compose file missing (volume reset / machine recreation) → bootstrap
#
# Failure is logged-and-continue, not fatal: nanoclaw can still start
# without the gateway, agents just lose secret injection until it's
# fixed manually.
ONECLI_COMPOSE_FILE="/root/.onecli/docker-compose.yml"
if docker ps --format '{{.Names}}' | grep -q '^onecli$'; then
  log "OneCLI gateway already running"
elif [ -f "$ONECLI_COMPOSE_FILE" ]; then
  log "OneCLI compose file present, gateway not running — starting"
  docker compose -f "$ONECLI_COMPOSE_FILE" up -d >/var/log/onecli-up.log 2>&1 || {
    log "WARNING: docker compose up failed for OneCLI gateway"
    tail -30 /var/log/onecli-up.log >&2 || true
  }
else
  log "OneCLI not installed — running bootstrap (downloads compose + starts gateway)"
  curl -fsSL https://onecli.sh/install | sh >/var/log/onecli-bootstrap.log 2>&1 || {
    log "WARNING: OneCLI bootstrap failed; back-mind containers will lack secret injection"
    tail -30 /var/log/onecli-bootstrap.log >&2 || true
  }
fi

# PAT (security + correctness): the OneCLI gateway's management API is
# UNAUTHENTICATED in local authMode. The CORRECT binding is 0.0.0.0 (IPv4-all),
# which is exactly what prod (pat-nanoclaw) runs. 0.0.0.0 serves BOTH:
#   - host loopback (127.0.0.1) — the nanoclaw host process reaches the gateway
#     via ONECLI_URL=http://127.0.0.1:10254 for ensureAgent/applyContainerConfig.
#   - the Docker bridge (172.17.0.1) — back-mind containers reach the host via
#     the bridge, NOT loopback.
# And 0.0.0.0 is IPv4-only, so it does NOT bind Fly's IPv6 6PN — other org apps
# still can't see the vault.
#
# The two WRONG bindings, both seen in the wild:
#   - `172.17.0.1`-only: serves containers but NOT the host → ONECLI_URL
#     (127.0.0.1) gets ConnectionRefused → ensureAgent throws OneCLIError →
#     wakeContainer fails → EVERY inbound message sticks pending, retrying every
#     60s, brain never responds. (This was the staging outage on 2026-06-19.)
#   - `127.0.0.1`-only: serves the host but breaks container→gateway.
# The DANGEROUS binding is `::`/[::] (all IPv6 = the 6PN) — exposes every vault
# secret to the org network.
#
# So: anything that isn't 0.0.0.0 gets normalized to 0.0.0.0. Manage the gateway
# via `fly ssh console -C "curl 172.17.0.1:10254/..."` — NEVER rebind to reach it.
ONECLI_PORTS="$(docker ps --format '{{.Names}}|{{.Ports}}' | awk -F'|' '$1=="onecli"{print $2}')"
case "$ONECLI_PORTS" in
  *'0.0.0.0:10254'*)
    log "OneCLI gateway bound to 0.0.0.0 (host loopback + bridge reachable, 6PN-safe) — OK"
    ;;
  *)
    log "OneCLI gateway not on 0.0.0.0 ($ONECLI_PORTS) — rebinding to 0.0.0.0 (serves host loopback + bridge, not the IPv6 6PN)"
    (cd /root/.onecli && ONECLI_BIND_HOST=0.0.0.0 docker compose up -d) >/var/log/onecli-rebind.log 2>&1 \
      || log "WARNING: forced 0.0.0.0 re-bind failed — investigate /var/log/onecli-rebind.log"
    ;;
esac

# Authenticate the local CLI to the gateway. Required for subsequent
# `onecli secrets` / `onecli apps` operations via fly ssh console.
# Idempotent — safe to re-run on every boot.
# PAT (Phase 4): the Fly secret is HOST_ONECLI_API_KEY under the prefix
# scheme; accept the legacy unprefixed name as fallback during transition.
ONECLI_KEY_EFFECTIVE="${HOST_ONECLI_API_KEY:-${ONECLI_API_KEY:-}}"
if [ -n "$ONECLI_KEY_EFFECTIVE" ]; then
  onecli auth login --api-key "$ONECLI_KEY_EFFECTIVE" >/dev/null 2>&1 || \
    log "WARNING: onecli auth login failed (check HOST_ONECLI_API_KEY Fly secret)"
else
  log "WARNING: HOST_ONECLI_API_KEY not set; onecli CLI management commands will fail"
fi

# ── 3. nanoclaw-agent image ───────────────────────────────────────────────
# build.sh tags by install-slug (sha1 of PROJECT_ROOT, first 8 chars),
# so anchor PROJECT_ROOT before sourcing — otherwise the slug shifts
# with cwd and we end up looking for the wrong tag.
export PROJECT_ROOT=/app/nanoclaw
# shellcheck disable=SC1091
. /app/nanoclaw/setup/lib/install-slug.sh
AGENT_IMAGE_BASE="$(container_image_base)"
AGENT_IMAGE_TAG="${AGENT_IMAGE_BASE}:latest"
log "agent image tag: $AGENT_IMAGE_TAG"

# PAT: rebuild when the build inputs CHANGE, not only when the image is
# absent. AGENT_IMAGE_TAG is path-derived (constant for /app/nanoclaw), so a
# bare `docker image inspect` check skips the build forever after first boot
# — silently shipping stale agent-runner code on every deploy (the cache
# footgun). Fingerprint the container build context and rebuild on any
# change. BuildKit's layer cache keeps an unchanged-layer rebuild fast, and
# build.sh overwrites the :latest tag, so no `docker rmi` dance is needed.
# Marker lives on the /data volume so it survives reboots alongside the
# image cache. set -eu means a failed build aborts before the marker is
# written → next boot retries.
AGENT_SRC_HASH="$(
  find /app/nanoclaw/container/Dockerfile /app/nanoclaw/container/build.sh \
       /app/nanoclaw/container/agent-runner /app/nanoclaw/container/skills \
       -type f -not -path '*/node_modules/*' 2>/dev/null \
    | sort | xargs -r sha1sum 2>/dev/null | sha1sum | cut -c1-16
)"
AGENT_HASH_MARKER=/data/.agent-image-srchash
PREV_AGENT_SRC_HASH="$(cat "$AGENT_HASH_MARKER" 2>/dev/null || echo none)"

if docker image inspect "$AGENT_IMAGE_TAG" >/dev/null 2>&1 && [ "$AGENT_SRC_HASH" = "$PREV_AGENT_SRC_HASH" ]; then
  log "agent image up to date (srchash $AGENT_SRC_HASH) — skipping build"
else
  if docker image inspect "$AGENT_IMAGE_TAG" >/dev/null 2>&1; then
    log "agent image stale (srchash $PREV_AGENT_SRC_HASH → $AGENT_SRC_HASH) — rebuilding"
  else
    log "agent image missing — building (first boot, ~2min)"
  fi
  cd /app/nanoclaw
  # The agent Dockerfile uses --mount=type=cache for apt/pnpm caches,
  # which is a BuildKit feature. Debian's docker.io ships dockerd
  # without BuildKit enabled by default — flip it on for this build.
  DOCKER_BUILDKIT=1 bash container/build.sh
  echo "$AGENT_SRC_HASH" >"$AGENT_HASH_MARKER"
  log "agent image build complete (srchash $AGENT_SRC_HASH)"
fi

# ── 3.5. Bridge Fly secrets → /app/nanoclaw/.env ──────────────────────────
# nanoclaw's `readEnvFile` (src/env.ts) deliberately reads `.env` from
# disk rather than `process.env` to keep secrets out of child-process
# inheritance. On Fly, secrets land in `process.env` only — so we
# generate `.env` here from a known allowlist of expected secret keys
# at every boot. Keep this list in sync with the keys consumed by
# channel adapters / integrations (each `/add-*` skill that needs a
# token should add its env vars here). Idempotent — overwritten on
# every boot, only includes vars that are actually set.
log "generating /app/nanoclaw/.env from Fly secrets"
SECRET_KEYS=(
  SLACK_BOT_TOKEN
  SLACK_SIGNING_SECRET
  SLACK_APP_TOKEN
  DISCORD_BOT_TOKEN
  TELEGRAM_BOT_TOKEN
  WHATSAPP_TOKEN
  PAT_VIEWER_TOKEN
  PAT_ADMIN_TOKEN
  ASSISTANT_NAME
  # PAT: the allowlist had drifted out of sync with what host code reads via
  # readEnvFile() — the signal channel silently never started on prod because
  # SIGNAL_* was absent from the generated .env. These are every remaining key
  # grep "readEnvFile(\[" src reports. Only keys that are actually SET get
  # written, so listing unset ones is harmless. KEEP THIS IN SYNC with the code.
  SIGNAL_ACCOUNT
  SIGNAL_TCP_HOST
  SIGNAL_TCP_PORT
  SIGNAL_CLI_PATH
  SIGNAL_MANAGE_DAEMON
  SIGNAL_DATA_DIR
  ONECLI_URL
  ONECLI_API_KEY
  ASSISTANT_HAS_OWN_NUMBER
  ANTHROPIC_BASE_URL
  TZ
)
# PAT (Phase 4 prefix router, .env half): a Fly secret named HOST_<KEY> is
# the declared host-tier value — it wins over a legacy unprefixed <KEY>
# during the rename transition, and .env always gets the CANONICAL name
# (readEnvFile consumers never see prefixes). Two passes:
#   1. the legacy allowlist above, preferring HOST_<KEY> when set;
#   2. a generic sweep of every HOST_* env var — the prefix IS the
#      allowlist declaration, so new host secrets flow into .env without
#      editing SECRET_KEYS (the allowlist-drift failure mode that once
#      silently killed the signal channel).
# The process.env half of the router is src/env-prefix-router.ts.
ENV_TMP="$(mktemp)"
WRITTEN=" "
for k in "${SECRET_KEYS[@]}"; do
  hk="HOST_$k"
  v="${!hk:-${!k:-}}"
  if [ -n "$v" ]; then
    printf '%s=%s\n' "$k" "$v" >> "$ENV_TMP"
    WRITTEN="$WRITTEN$k "
  fi
done
for name in $(compgen -A variable HOST_ || true); do
  [ "$name" = "HOST_" ] && continue
  k="${name#HOST_}"
  case "$WRITTEN" in *" $k "*) continue ;; esac
  v="${!name:-}"
  if [ -n "$v" ]; then
    printf '%s=%s\n' "$k" "$v" >> "$ENV_TMP"
    WRITTEN="$WRITTEN$k "
  fi
done
mv "$ENV_TMP" /app/nanoclaw/.env
chmod 600 /app/nanoclaw/.env
log ".env populated with $(wc -l < /app/nanoclaw/.env) keys (values redacted)"

# ── 3.6. Upgrade marker (v2.1.0 boot tripwire) ────────────────────────────
# Since v2.1.0 the host refuses to boot unless data/upgrade-state.json records
# that this install reached its current version through a sanctioned path
# (enforceUpgradeTripwire in src/upgrade-state.ts checks marker.version ===
# package.json version). PAT's sanctioned path IS this Dockerfile image
# build+deploy (not /setup or /update-nanoclaw), so stamp the marker here for
# the version baked into the image. The marker lives on the volume via the
# data/ symlink, so it persists; we re-stamp every boot so a version bump in a
# new image is reflected immediately. Hand-written JSON (matching the
# UpgradeState shape) avoids needing pnpm/tsx at runtime.
log "stamping upgrade marker"
PKG_VERSION="$(node -p "require('/app/nanoclaw/package.json').version" 2>/dev/null || echo unknown)"
printf '{\n  "version": "%s",\n  "updatedAt": "%s",\n  "via": "fly-deploy"\n}\n' \
  "$PKG_VERSION" "$(date -u +%FT%TZ)" > /data/nanoclaw/data/upgrade-state.json
log "upgrade marker stamped: version=$PKG_VERSION via=fly-deploy"

# ── 4. Drop to uid 1000 for the nanoclaw process ──────────────────────────
# The agent image's USER node (uid 1000) can't write to root-owned bind
# mounts, and Claude Code refuses to run as root in any bypass-style
# permission mode. Run the host process as the same uid as the agent
# container's user so file ownership lines up cleanly.
log "preparing for uid 1000 (node user)"
# Make sure the data tree is owned by 1000:1000 — covers earlier-deploy
# state where root wrote some files. dockerd's data root stays root.
chown -R 1000:1000 /data/nanoclaw
# /app/nanoclaw and its subdirs are read-only at runtime but include the
# symlinks we made into /data/nanoclaw. Just chown the symlinks too.
chown -h 1000:1000 /app/nanoclaw/data /app/nanoclaw/groups /app/nanoclaw/store 2>/dev/null || true
chown 1000:1000 /app/nanoclaw/.env 2>/dev/null || true
# node user needs to talk to /var/run/docker.sock to spawn agent
# containers. Add it to the docker group (apt-installed; gid varies).
DOCKER_GID="$(stat -c '%g' /var/run/docker.sock)"
if ! getent group docker >/dev/null; then
  groupadd -g "$DOCKER_GID" docker || true
fi
usermod -aG docker node 2>/dev/null || true

# ── 5. Run nanoclaw as node ───────────────────────────────────────────────
cd /app/nanoclaw
log "starting nanoclaw host process as node uid=1000 (cwd=$(pwd), image=$AGENT_IMAGE_TAG)"
exec runuser -u node -- node /app/nanoclaw/dist/index.js
