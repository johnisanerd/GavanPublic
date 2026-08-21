#!/bin/sh
# signal-cli receive-liveness watchdog.
#
# WHY THIS EXISTS
# ---------------
# signal-cli 0.14.3's continuous receive loop has no per-envelope try/catch.
# A single malformed/undecryptable inbound envelope whose decrypted content is
# null throws `NullPointerException` in
# `IncomingMessageHandler.getSender()` (and, on the retry path,
# `handleRetryEnvelope`), which kills the receive thread inside
# `ReceiveHelper.receiveMessagesContinuously`. The daemon stays up and keeps
# answering JSON-RPC (version/send work), but it NEVER pulls another inbound
# envelope — Pat silently goes deaf on Signal while looking healthy.
#
# Worse, signal-cli persists the offending envelope under
# `<account>.d/msg-cache/` on the Fly volume and re-processes it via
# `retryFailedReceivedMessages` on EVERY receive — so a plain machine restart
# re-wedges immediately. (Diagnosed live 2026-06-25: 4 poison envelopes stamped
# 01:39:00 wedged the receive thread; restart "fixed then re-died" until the
# msg-cache files were cleared.)
#
# This watchdog detects the dead receive loop and forces a clean restart of
# signal-cli (the entrypoint's `wait` returns → Fly restarts the machine). To
# stop the restart loop from re-wedging on the persisted poison, it also clears
# stale msg-cache entries before forcing the restart.
#
# HEALTH SIGNAL
# -------------
# A LIVE receive loop holds (a) a `receive-*` JVM thread AND (b) a persistent
# established TCP connection from signal-cli to a Signal relay on port 443
# (a non-6PN remote). When the loop is dead, BOTH disappear (verified
# empirically). We require both to be absent to call it wedged, and we require
# WD_FAIL_THRESHOLD consecutive failures so a transient relay reconnect (the
# 443 socket briefly drops + re-dials) doesn't trigger a false restart.
#
# Pure POSIX sh + /proc only — the runtime image has no `ps`/`ss`/`jstack`.
#
# Env (all optional):
#   SIGNAL_ACCOUNT          E164 (used to locate the account's msg-cache dir)
#   SIGNAL_WATCHDOG         set to "false" to disable (default: enabled)
#   SIGNAL_WD_INTERVAL      seconds between checks (default 60)
#   SIGNAL_WD_GRACE         seconds to wait after boot before first check
#                           (default 90 — let the daemon open its relay socket)
#   SIGNAL_WD_FAIL_THRESHOLD consecutive failed checks before acting (default 3)
#   SIGNAL_WD_STALE_CACHE_S  a msg-cache file older than this many seconds is
#                            treated as a stuck/not-advancing receive loop
#                            (default 300; set 0 to disable the secondary signal)
#   SIGNAL_DATA_DIR         signal-cli data root
#                           (default /root/.local/share/signal-cli)

set -u

WD_ENABLED="${SIGNAL_WATCHDOG:-true}"
WD_INTERVAL="${SIGNAL_WD_INTERVAL:-60}"
WD_GRACE="${SIGNAL_WD_GRACE:-90}"
WD_FAIL_THRESHOLD="${SIGNAL_WD_FAIL_THRESHOLD:-3}"
WD_STALE_CACHE_S="${SIGNAL_WD_STALE_CACHE_S:-300}"
DATA_DIR="${SIGNAL_DATA_DIR:-/root/.local/share/signal-cli}"
ACCOUNT="${SIGNAL_ACCOUNT:-}"

log() { echo "[signal-watchdog] $*"; }

# Find the signal-cli daemon JVM pid (org.asamk.signal.Main ... daemon).
find_daemon_pid() {
  for p in /proc/[0-9]*; do
    [ -r "$p/cmdline" ] || continue
    c=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null)
    case "$c" in
      *org.asamk.signal.Main*daemon*) echo "${p#/proc/}"; return 0 ;;
    esac
  done
  return 1
}

# True if the JVM has at least one receive-* thread (the receive loop worker).
has_receive_thread() {
  pid="$1"
  for comm in /proc/"$pid"/task/*/comm; do
    [ -r "$comm" ] || continue
    case "$(cat "$comm" 2>/dev/null)" in
      receive*) return 0 ;;
    esac
  done
  return 1
}

# True if the JVM ITSELF holds an ESTABLISHED TCP connection to a Signal relay:
# remote port 443 (hex 01BB), state 01 (ESTABLISHED), to a non-6PN remote.
#
# IMPORTANT: `/proc/<pid>/net/tcp*` is the NETWORK-NAMESPACE-WIDE table, not the
# process's own sockets — every pid in a Fly Firecracker VM (one shared netns)
# sees the identical table. Reading it per-pid would let an unrelated process's
# 443 connection mask a wedged daemon. So we attribute connections to signal-cli
# by intersecting the netns table's socket inodes with the inodes the daemon
# actually holds open in /proc/<pid>/fd. Fly 6PN uses the fdaa::/16 ULA whose
# hex form starts "1D00AAFD"; those remotes are nanoclaw's RPC client / SSH, not
# Signal, so we skip them.
has_relay_connection() {
  pid="$1"

  # Collect the socket inodes this pid owns (fd → socket:[INODE]).
  owned=" "
  for fd in /proc/"$pid"/fd/*; do
    tgt=$(readlink "$fd" 2>/dev/null) || continue
    case "$tgt" in
      socket:\[*\]) owned="${owned}${tgt#socket:[}"; owned="${owned%]} " ;;
    esac
  done

  for f in /proc/"$pid"/net/tcp6 /proc/"$pid"/net/tcp; do
    [ -r "$f" ] || continue
    # columns: sl local_address rem_address st tx:rx tr:when retrnsmt uid timeout inode
    while read -r _ _ rem st _ _ _ _ _ inode _; do
      [ "$st" = "01" ] || continue
      rport="${rem##*:}"
      [ "$rport" = "01BB" ] || continue
      raddr="${rem%:*}"
      case "$raddr" in
        1D00AAFD*) continue ;;  # Fly 6PN remote — skip
      esac
      # Only count it if THIS pid owns the socket inode.
      case "$owned" in
        *" $inode "*) return 0 ;;
      esac
    done < "$f"
  done
  return 1
}

# Resolve this account's on-disk hash from accounts.json (signal-cli 0.14.x uses
# hash-keyed data dirs: data/<hash>.d/). Echoes the hash, or nothing on failure.
account_hash() {
  acctsjson="$DATA_DIR/data/accounts.json"
  [ -r "$acctsjson" ] || return 1
  python3 - "$acctsjson" "$ACCOUNT" <<'PY' 2>/dev/null
import json, sys
try:
    for a in json.load(open(sys.argv[1]))["accounts"]:
        if a.get("number") == sys.argv[2]:
            print(a.get("path", "")); break
except Exception:
    pass
PY
}

# Echo the account's msg-cache dir path (whether or not it exists), or nothing
# if the account/hash can't be resolved.
msg_cache_dir() {
  [ -n "$ACCOUNT" ] || return 1
  h=$(account_hash) || return 1
  [ -n "$h" ] || return 1
  echo "$DATA_DIR/data/${h}.d/msg-cache"
}

# Secondary health signal: true if msg-cache holds a file older than
# WD_STALE_CACHE_S seconds. In healthy operation these files are transient
# (processed in seconds); a stale one means the receive loop is stuck retrying
# poison without advancing — a wedge the thread/socket checks can miss.
# Disabled when WD_STALE_CACHE_S=0.
stale_msg_cache() {
  [ "$WD_STALE_CACHE_S" -gt 0 ] 2>/dev/null || return 1
  mc=$(msg_cache_dir) || return 1
  [ -d "$mc" ] || return 1
  # `find -mmin` takes minutes; round up so a sub-minute threshold still works.
  mins=$(( (WD_STALE_CACHE_S + 59) / 60 ))
  found=$(find "$mc" -maxdepth 1 -type f -mmin +"$mins" 2>/dev/null | head -n1)
  [ -n "$found" ]
}

# QUARANTINE the persisted poison envelopes so the post-restart daemon doesn't
# re-wedge on retryFailedReceivedMessages. We MOVE them aside (never delete) into
# a timestamped dir on the same volume — these are unacked envelopes that failed
# to decrypt, but they MAY be recoverable forensically (e.g. a session/sender-key
# repair could let them decrypt), so we must not silently destroy them. Only runs
# right before we force a restart. Best-effort.
quarantine_msg_cache() {
  mc=$(msg_cache_dir) || { log "could not resolve msg-cache dir; skipping quarantine"; return; }
  [ -d "$mc" ] || { log "no msg-cache dir at $mc; nothing to quarantine"; return; }
  n=$(find "$mc" -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d ' ')
  if [ "$n" -eq 0 ]; then
    log "msg-cache empty; nothing to quarantine"
    return
  fi
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  qdir="$DATA_DIR/msg-cache-quarantine/${ts}"
  mkdir -p "$qdir" 2>/dev/null
  # Move each file aside. `mv` keeps them on the same volume (the quarantine
  # root lives under DATA_DIR, which is the mounted Fly volume) so they survive
  # restarts and can be inspected/replayed later.
  moved=0
  for f in "$mc"/*; do
    [ -f "$f" ] || continue
    if mv "$f" "$qdir"/ 2>/dev/null; then moved=$((moved + 1)); fi
  done
  log "quarantined $moved/$n poison envelope(s) to $qdir (preserved, not deleted)"
}

run() {
  if [ "$WD_ENABLED" = "false" ]; then
    log "disabled via SIGNAL_WATCHDOG=false"
    return 0
  fi
  log "enabled (interval=${WD_INTERVAL}s grace=${WD_GRACE}s threshold=${WD_FAIL_THRESHOLD} stale_cache=${WD_STALE_CACHE_S}s)"
  sleep "$WD_GRACE"

  fails=0
  while :; do
    sleep "$WD_INTERVAL"

    pid=$(find_daemon_pid) || {
      # Daemon process itself is gone — the entrypoint's `wait` will handle
      # the restart; nothing for the watchdog to do.
      log "daemon process not found; deferring to entrypoint"
      fails=0
      continue
    }

    # Primary signal: the receive loop is dead when the receive thread is gone
    # OR the daemon no longer owns a relay-443 connection.
    # Secondary signal (the lead's suggestion): the receive thread can be
    # PRESENT but stuck endlessly retrying a poison envelope without dying. In
    # healthy operation msg-cache files are transient (processed within
    # seconds); a file older than SIGNAL_WD_STALE_CACHE_S means the loop is not
    # advancing. This catches the "alive but not progressing" variant the
    # thread/socket checks miss.
    if has_receive_thread "$pid" && has_relay_connection "$pid" && ! stale_msg_cache; then
      if [ "$fails" -ne 0 ]; then log "receive loop healthy again (was failing)"; fi
      fails=0
      continue
    fi

    fails=$((fails + 1))
    log "receive loop UNHEALTHY (pid=$pid recv_thread=$(has_receive_thread "$pid" && echo y || echo n) relay443=$(has_relay_connection "$pid" && echo y || echo n) stale_cache=$(stale_msg_cache && echo y || echo n)) consecutive=$fails/$WD_FAIL_THRESHOLD"

    if [ "$fails" -ge "$WD_FAIL_THRESHOLD" ]; then
      log "receive loop confirmed dead — quarantining poison + forcing signal-cli restart"
      quarantine_msg_cache
      kill -TERM "$pid" 2>/dev/null
      # Give it a moment; SIGKILL if it lingers so the machine recycles.
      i=0
      while [ "$i" -lt 10 ] && [ -d "/proc/$pid" ]; do sleep 1; i=$((i + 1)); done
      [ -d "/proc/$pid" ] && kill -KILL "$pid" 2>/dev/null
      log "signal-cli killed; entrypoint wait will exit and Fly will restart the machine"
      return 0
    fi
  done
}

run
