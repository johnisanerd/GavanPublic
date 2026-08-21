#!/usr/bin/env bash
# signal-test-rig entrypoint.
#
# Bash (not sh) because we use `wait -n` to block on the first child
# that exits — dash, the default /bin/sh on python:3.13-slim's Debian
# base, doesn't have it. The Dockerfile installs bash via the base
# image's standard package set; nothing extra to add.
#
# Boots signal-cli as a multi-account JSON-RPC daemon (no `-a` flag —
# every locally-registered account becomes addressable through one
# socket), then launches the FastAPI rig that fans out inbound + serves
# /send + /ws. Both processes share a loopback connection inside the
# container, so the daemon stays bound to 127.0.0.1 — the rig is the
# only thing on the network.
#
# Required env (set as Fly secrets / fly.toml [env]):
#   SIGNAL_TEST_RIG_TOKEN    — bearer for /send + /ws + /status
#   SIGNAL_TEST_RIG_ACCOUNTS — comma-separated E164s (e.g. +A,+B).
#                              Each must already be registered locally
#                              with `signal-cli -a +1XXX register`, then
#                              the state migrated onto the Fly volume
#                              via scripts/migrate-signal-rig-state.sh.
#
# Bind notes (see reference_pat_signal_deploy.md for the deep dive):
#   - signal-cli's SocketHandler cannot bind to hostnames. `0.0.0.0:7583`
#     resolves to `[::]:7583` (IPv6 wildcard) — covers all interfaces.
#     Loopback-only here is `127.0.0.1:7583` (IPv4) — the rig connects
#     over loopback so this is sufficient.
#   - The rig itself MUST bind to `::` (or `0.0.0.0` — same effect on
#     Linux with v4-mapped v6) so Fly's edge proxy can reach it. The
#     default `127.0.0.1` from local-dev would be invisible to the
#     proxy. fly.toml sets SIGNAL_TEST_RIG_BIND=:: explicitly.
#
# Process model: signal-cli runs in the foreground via exec at the end.
# The rig runs in the background BEFORE signal-cli boots — uvicorn
# waits for the daemon to accept connections via the bridge's
# `_await_daemon_listening` poll loop.
#
# NOTE on order: signal-cli takes 10-30s to attach to Signal Service
# (websocket handshake + receive subscription). Starting the rig last
# means its bridge.start() blocks until subscribeReceive returns, which
# is what we want — the rig refuses to serve /healthz "ok" until inbound
# is actually flowing.

set -eu

: "${SIGNAL_TEST_RIG_TOKEN:?SIGNAL_TEST_RIG_TOKEN must be set}"

# Accept either SIGNAL_TEST_RIG_ACCOUNTS (plural, preferred) or the legacy
# singular alias, mirroring the rig's own env handling.
ACCOUNTS_CHECK="${SIGNAL_TEST_RIG_ACCOUNTS:-${SIGNAL_TEST_RIG_ACCOUNT:-}}"
if [ -z "$ACCOUNTS_CHECK" ]; then
  echo "[entrypoint] FATAL: SIGNAL_TEST_RIG_ACCOUNTS (or SIGNAL_TEST_RIG_ACCOUNT) must be set" >&2
  exit 1
fi

# Daemon bind: loopback inside the container. signal-cli + the rig
# colocate on this VM, so 127.0.0.1 is the right answer.
DAEMON_BIND="${SIGNAL_TEST_RIG_TCP_HOST:-127.0.0.1}:${SIGNAL_TEST_RIG_TCP_PORT:-7583}"

# Rig bind: `0.0.0.0` so Fly's edge proxy + tcp health-check can reach it.
# Notes:
#   - Fly's documented advice (https://fly.io/docs/networking/app-services/)
#     is to bind to `0.0.0.0`, NOT `::`. Their edge proxy reaches the
#     machine over IPv6 6PN but the TCP-check infrastructure expects
#     IPv4 reachability; python uvicorn binding to `::` doesn't create
#     a dual-stack socket on Linux by default even with
#     `net.ipv6.bindv6only=0` (the socket itself opts out).
#   - Local-dev callers keep the loopback default by setting
#     SIGNAL_TEST_RIG_BIND=127.0.0.1 in their shell.
export SIGNAL_TEST_RIG_BIND="${SIGNAL_TEST_RIG_BIND:-0.0.0.0}"
export SIGNAL_TEST_RIG_PORT="${SIGNAL_TEST_RIG_PORT:-7585}"

# Rig connects to the daemon over loopback. Default to 127.0.0.1 even
# when the daemon binds to a wildcard — connection-side address doesn't
# need to match bind-side wildcard, and 127.0.0.1 is the cheapest path.
export SIGNAL_TEST_RIG_TCP_HOST="${SIGNAL_TEST_RIG_TCP_HOST:-127.0.0.1}"
export SIGNAL_TEST_RIG_TCP_PORT="${SIGNAL_TEST_RIG_TCP_PORT:-7583}"

# Don't have the rig manage the daemon — we manage it here so we can
# control startup order, signal forwarding, and log routing.
export SIGNAL_TEST_RIG_MANAGE_DAEMON=0

echo "[entrypoint] accounts: ${ACCOUNTS_CHECK}"
echo "[entrypoint] daemon bind: ${DAEMON_BIND}"
echo "[entrypoint] rig bind: ${SIGNAL_TEST_RIG_BIND}:${SIGNAL_TEST_RIG_PORT}"

# Forward SIGTERM to both children so Fly's shutdown sequence is clean.
trap 'kill -TERM "$SIGNAL_PID" 2>/dev/null || true; kill -TERM "$RIG_PID" 2>/dev/null || true' TERM INT

# Multi-account signal-cli daemon. No `-a` flag — that's what triggers
# multi-account mode in signal-cli (every RPC then takes `account` in
# params). `--receive-mode on-start` opens the receive stream so push
# notifications start flowing before any client connects.
echo "[entrypoint] starting signal-cli multi-account daemon"
signal-cli \
  daemon \
  --tcp "$DAEMON_BIND" \
  --no-receive-stdout \
  --receive-mode on-start &
SIGNAL_PID=$!

# Tiny grace window so signal-cli has had a chance to open its socket
# before the rig tries to connect. The bridge poll loop handles further
# slip, but a 1s head start cuts boot-log noise from "connection
# refused" retries to zero in the common case.
sleep 1

echo "[entrypoint] starting signal-test-rig FastAPI app"
python -m signal_test_rig.main &
RIG_PID=$!

# Wait on either child. If signal-cli dies, the rig becomes useless;
# if the rig dies, signal-cli is just a JSON-RPC server with no clients.
# Either way the machine should restart.
wait -n "$SIGNAL_PID" "$RIG_PID"
EXIT_CODE=$?
echo "[entrypoint] a child exited (code=$EXIT_CODE), terminating siblings"
kill -TERM "$SIGNAL_PID" 2>/dev/null || true
kill -TERM "$RIG_PID" 2>/dev/null || true
wait || true
exit "$EXIT_CODE"
