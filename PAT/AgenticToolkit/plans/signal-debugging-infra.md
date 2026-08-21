# Signal debugging infrastructure

Status: proposal (2026-06-24/25). Author: signal-debug agent, after a multi-hour
prod Signal outage debug session.

## Why this exists — tonight's pain, concretely

PAT's Signal channel produced no replies on prod while Telegram worked. It took
hours to isolate because **the failure was invisible in our normal tooling**.
The session surfaced *two distinct* signal-cli 0.14.3 bugs, both silent:

1. **`getSender`-null receive-thread WEDGE.** A null-content envelope NPE'd
   `IncomingMessageHandler.getSender()`, killing the continuous receive thread
   inside `ReceiveHelper.receiveMessagesContinuously`. The daemon stayed up and
   answered JSON-RPC (version/send worked) but pulled ZERO inbound. The poison
   envelope persisted in `<account>.d/msg-cache/` on the Fly volume and
   re-wedged on every restart via `retryFailedReceivedMessages`. → Fixed with
   the receive-liveness **watchdog** (`transports/signal-cli/watchdog.sh`,
   shipped).
2. **`getServerGuid`-null sealed-sender DROP** (upstream issue #2059). Around
   2026-06-10 Signal's server stopped including `serverGuid` in some
   sealed-sender envelopes; libsignal's non-null check throws → the envelope
   fails to decrypt and is dropped before delivery. Sealed sender is Signal's
   DEFAULT for contacts, so essentially every real DM from the user was silently
   dropped. → Fixed in signal-cli **0.14.5** (one-line `SIGNAL_CLI_VERSION` bump
   in `transports/Dockerfile`, staged, not yet deployed).

### The core problem in one sentence
We could not distinguish **"messages aren't arriving"** from **"messages arrive
but silently fail to decrypt"** from **"receive thread is dead"** without SSHing
into the daemon machine and reading `/proc` + raw `flyctl logs` by hand — and the
decrypt failures never appeared in `/api/logs.jsonl` at all.

### Specific gaps hit tonight
- **Decrypt failures are invisible.** The daemon runs with `--no-receive-stdout`
  (`transports/signal-cli/entrypoint.sh`), so per-envelope decrypt errors never
  reach stdout in continuous mode — and even if they did, `flyctl logs` is a
  rolling buffer, not a structured stream. The only structured signal events we
  emit are `signal.send-acked` / `signal.send-failed` (outbound only — see
  `nanoclaw/src/channels/signal.ts:1073,1090`). There is **no inbound-side
  structured event at all** until a message successfully decrypts and reaches
  `handleEnvelope` → `log.info('Signal message received')` (a plain `misc`
  string, not a queryable `kind`). A dropped message produces nothing.
- **`flyctl logs` was the only window into the daemon**, and it's a buffer of
  hours of history with no wall-clock guarantee (the pat-logs skill exists
  precisely to stop us trusting it). The getServerGuid NPEs only showed up when
  *I* ran a manual one-shot `receive` (which DOES print); the daemon itself
  logged nothing.
- **No off-prod repro.** `pat-transports-staging` is cartesia-only — no Signal
  process, no identity (verified: no `pat_signal_state` volume, no `SIGNAL_*`
  secrets). So I could not reproduce or test receive/decrypt anywhere but prod,
  and every test bounced the live daemon (and dropped nanoclaw's subscription,
  since there was no auto-reconnect until tonight).
- **Version drift was undetected.** We were two patch releases behind a fix for
  a *server-change-induced* bug (#2059, fixed 2026-06-11) and only found it by
  manually searching the changelog mid-incident.
- **Daemon liveness was unobservable.** "Is the receive thread alive / is the
  relay-:443 connection up / how deep is msg-cache" required hand-rolled
  `/proc/<pid>/task/*/comm` + socket-inode parsing on the box. (That parsing is
  now codified in `watchdog.sh` — but only the watchdog can see it.)

---

## Proposals (prioritized)

### P1 — Structured signal inbound + decrypt observability (HIGHEST)
**The single highest-leverage fix.** Make "arriving / decrypting / dropped /
routed" answerable from `/api/logs.jsonl` in seconds, instead of an SSH
expedition. Two parts:

**P1a — Daemon-side decrypt/receive events.** The daemon currently hides
inbound. Switch the diagnostic surface from "swallowed" to "structured":
- Run a lightweight **receive observer** as a second JSON-RPC subscriber (the
  daemon supports multiple `subscribeReceive` clients — nanoclaw is one; a
  read-only observer can be another without stealing envelopes). It emits one
  JSONL event per envelope to the existing log pipeline:
  - `signal.envelope-received` `{ source_type: sealed|identified, has_data_message, ts }`
  - `signal.decrypt-failed` `{ error: "getServerGuid"|"getSender"|..., source_type, server_ts }`
    — this is the event whose absence cost us hours.
  - Counters: envelopes received / decrypted / failed, per 1-min bucket.
- **Caveat to verify:** a decrypt failure in continuous mode may not be
  delivered to *any* subscriber (the throw happens before push). If so, the
  observer can't see it either — and the real fix is to capture stderr/log from
  the daemon. So ALSO: drop `--no-receive-stdout` (or add a parallel
  `--receive-mode` diagnostic tap) and pipe the daemon's stderr through a
  JSON-ifier that emits `signal.decrypt-failed` on the
  `NullPointerException ... getServerGuid/getSender` lines + `msg-cache` activity.
  This is the most robust path and doesn't depend on signal-cli's push
  behavior. Land in `transports/signal-cli/entrypoint.sh` + a small parser
  (sibling to `watchdog.sh`), declare the new kinds in `transports/log_events.py`.

**P1b — Daemon health as structured events + dashboard tile.** The watchdog
already computes the three load-bearing health signals (receive-thread present,
owns relay-:443, msg-cache depth — see `watchdog.sh` `has_receive_thread` /
`has_relay_connection` / stale-cache check). Have it **emit** them every cycle as
`signal.daemon-health` `{ receive_thread, relay_443, msg_cache_depth, quarantine_count }`
instead of only acting on them. Surface a "Signal" tile in pat-frontend
(`reference_pat_observability_dashboard`) showing: receive-thread up/down,
relay-:443 up/down, msg-cache depth, last inbound ts, decrypt-fail counter,
signal-cli version. **Acceptance:** "messages arriving but silently dropped at
decrypt" is obvious from the dashboard in <1 min (decrypt-fail counter climbing
while inbound stays 0).

Files: `transports/signal-cli/{entrypoint.sh,watchdog.sh}`,
`transports/log_events.py`, `nanoclaw/src/channels/signal.ts` (mirror the
`signal.send-*` pattern for inbound), pat-frontend dashboard.

### P2 — Off-prod Signal harness (repro decrypt bugs without touching prod)
We already own most of this — **`signal-test-rig/`** is a multi-account
signal-cli WS wrapper with registered burners, deployed as two Fly apps
(`pat-signal-rig` +A=+15550100005, `pat-signal-rig-b` +B=+15550100006 — see
`reference_signal_test_rig_deploy`). Tonight's gap was that it wasn't wired as a
*receive/decrypt* test target. Build:
- **A staging Signal identity.** Either give `pat-transports-staging` a signal
  process + its own registered burner + `pat_signal_state` volume, OR (lighter)
  point a staging nanoclaw at a rig burner as its "bot account." Then
  receive/decrypt is testable entirely off-prod.
- **Envelope replay.** Capture failing envelopes (the quarantine dir
  `<DATA_DIR>/msg-cache-quarantine/` the watchdog now preserves is exactly this
  corpus) and replay them through a chosen signal-cli version to reproduce a
  decrypt bug deterministically — no live sender needed. A
  `scripts/signal-replay.sh <version> <envelope-file>` that boots signal-cli
  $version against a throwaway state dir, drops the envelope into msg-cache, runs
  one `receive`, and reports decrypt outcome. This would have reproduced #2059 in
  one command and proven 0.14.5 fixes it before deploying.
- **Wedge simulation** for the watchdog (already validated ad-hoc tonight): a
  harness that plants a poison/stale envelope and asserts detect→quarantine→
  restart→recover. Codify it as a test.

Files: `signal-test-rig/` (extend), `transports/`, new `scripts/signal-replay.sh`.

### P3 — Round-trip smoke test + version-drift alerting
- **Smoke test:** a scheduled job (cron skill / Fly scheduled machine) that, on
  an interval, sends a known string bot→rig-burner and rig-burner→bot and
  asserts both directions complete within N seconds (inbound decrypts + routes,
  outbound acks). Emits `signal.smoke-ok` / `signal.smoke-failed`. This catches
  BOTH classes of tonight's bug automatically: a wedge → inbound leg fails; a
  decrypt bug → inbound leg fails; an outbound/session issue → outbound leg
  fails. Pairs with P1's dashboard tile. The rig's existing
  `GET /address` + `POST /send` + WS fanout are the harness primitives.
- **Version-drift alerting:** a tiny scheduled check that compares our pinned
  `SIGNAL_CLI_VERSION` (`transports/Dockerfile`) against the latest signal-cli
  GitHub release and, on a delta, fetches the changelog and flags it — especially
  lines matching `receiv|decrypt|sealed|unidentified|sender|NullPointer`. We were
  2 releases behind a fix for a *server-change-induced* bug we had no way to
  anticipate; sealed-sender breakage is exactly the kind of upstream churn that
  warrants proactive watching. Cheap: `gh api repos/AsamK/signal-cli/releases/latest`
  + diff vs pinned + post to the team channel.

Files: new `scripts/signal-smoke.sh` + scheduled runner; new
`scripts/signal-version-check.sh` + cron.

---

## Motivating case studies (keep these as the regression bar)
- **Bug A — `getSender`-null wedge** (poison persists in msg-cache, restarts
  re-wedge). Fix: watchdog (shipped). Infra that would've caught it fast: P1b
  (receive-thread-down + msg-cache-depth climbing on the dashboard) and P3 smoke
  (inbound leg fails).
- **Bug B — `getServerGuid`-null sealed-sender drop** (#2059, fixed 0.14.5).
  Fix: version bump (staged). Infra that would've caught it fast: P1a
  (`signal.decrypt-failed{error:getServerGuid}` counter climbing while inbound
  stays 0 — the exact "arriving but dropped at decrypt" signal we lacked), P2
  replay (repro + prove the fix off-prod), P3 version-drift (flag the fix the day
  it shipped).

## Sequencing
P1a+P1b first (turns a multi-hour SSH hunt into a glance; small, lands in files
we already touched tonight). P2 next (unblocks safe off-prod iteration; ~half of
it already exists in `signal-test-rig`). P3 last (automation on top of P1+P2).
None require prod changes to *build*; deploying P1's daemon-side tap rides the
next transports deploy alongside the 0.14.5 bump.
