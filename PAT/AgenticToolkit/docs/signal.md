# Signal channel — reference & runbook

PAT's Signal channel: a `signal-cli` JSON-RPC daemon on the `signal` process
group of **pat-transports**, spoken to over Fly 6PN by the nanoclaw adapter
(`nanoclaw/src/channels/signal.ts`, `SIGNAL_MANAGE_DAEMON=false`). This doc is
the durable gotcha list. For the two open design tracks it cross-links, not
duplicates:

- **`plans/signal-debugging-infra.md`** — inbound/decrypt observability, off-prod
  repro harness, smoke + version-drift alerting (proposal; P1 not built).
- **`plans/signal-keepalive-and-reregister.md`** — keep-alive design + the full,
  ready-to-run **re-registration runbook** (§4, DO NOT run until told).

## Account

- Number **`+15550100003`**, profile "PAT", **primary device** (signal-cli *is*
  the client — no separate phone app), **no registration-lock PIN**.
  Re-registered fresh 2026-05-11.
- Identity state lives on the Fly volume `pat_signal_state` →
  `/root/.local/share/signal-cli` (signal-cli 0.14.x uses **hash-keyed** paths:
  `data/<hash>.d/`, with `data/accounts.json` mapping hash → E164). signal-cli
  follows XDG even on macOS (`~/.local/share/signal-cli/`), never
  `~/Library/Application Support/`.
- **Identifiers (ACI / PNI) — look them up, don't hardcode. They change on
  re-registration.**
  - **ACI** — the true account identity; **address PAT by this.** It's the
    account's `uuid` in `data/accounts.json` on the volume (equivalently
    `signal-cli -a <number> listAccounts`, or whatever a self-send resolves to).
  - **PNI** — the phone-number identity; it's the account file's
    `pniAccountData.serviceId` (prefixed `PNI:`). `getUserStatus` returns the
    **PNI**, not the ACI — mistaking one for the other is the silent-drop trap
    (below). Don't pin either value in docs.

## Addressing — the ACI/PNI silent-drop quirk

Signal is mid-migration from phone-number identity (**PNI**) to account
identity (**ACI**). Every account has both keypairs. When a **sender's cached
recipient PNI fingerprint ≠ the recipient's live ACI key**, an **E164-addressed
message body silently fails to decrypt** — no exception, no error; delivery
receipts still flow (envelope routing is decoupled from body decryption). The
recipient sees a metadata-only envelope (`source_uuid` set, `source`/E164 null,
no `dataMessage`).

- **Fix:** address the recipient by **ACI UUID** instead of E164 in the `send`
  JSON-RPC call, OR `getUserStatus`-refresh the contact before sending. Verified:
  UUID addressing decrypts cleanly where E164 silently dropped.
- **Higher risk when:** the recipient is in **username / phone-number-privacy
  mode** (unpublishes PNI — increasingly the default), the sender is
  signal-cli-only (doesn't auto-sync contacts like a real client), or the
  sender's cache never refreshed since the recipient's ACI rotated.
- **Does NOT bite** normal real-Signal-client users with fresh caches (they
  self-heal). Non-issue for the everyday PAT ↔ real-user path.
- **Failed fixes** (don't retry): `removeContact --forget`,
  `trust --trust-all-known-keys`, splitting into separate apps. Only UUID
  addressing / status-refresh works.
- **`getUserStatus` returns UUID** for a known account and is the discovery
  path; the test rigs expose it as `GET /address` (returns ACI).
- PAT prod **is exposed** — see `KNOWN_ISSUES.md`.

## Voice-memo format (iOS native bubble)

iOS Signal renders the native voice-memo bubble (waveform, hold-to-listen,
playback speed, transcription) **only when all three line up**:

1. **AAC in an m4a container** — `ffmpeg -c:a aac -b:a 64k -ar 44100 -ac 1`.
   Opus-in-ogg plays but always renders as a *generic* attachment.
2. **`voiceNote: true`** in the `send` JSON-RPC params (sets the protobuf
   `VOICE_MESSAGE` flag).
3. **A real local file path on signal-cli's machine** — `data:` URLs preserve
   the flag but fall through to generic. Stage the bytes first (see sidecar).

Caveats: signal-cli 0.14.x exposes **no `waveform` field**, so the bubble shows
flat placeholder bars (cosmetic). Read receipts need `readReceipts: true` **and**
an explicit `sendReceipt(...type='read')` per inbound envelope. Outbound TTS
voice is `CARTESIA_VOICE_ID` (a Cartesia-catalog id — not interchangeable with
`ANAM_VOICE_ID`).

### Staging sidecar (cross-machine file delivery)

signal-cli's `/tmp` is a different machine from pat-nanoclaw's container, so
nanoclaw can't hand it a local path directly. `transports/signal_staging.py` is
a tiny FastAPI app (`POST /stage?ext=.m4a` → writes bytes, returns
`{path: "/tmp/signal-stage-*.m4a"}`) launched from the signal entrypoint before
signal-cli. nanoclaw's `sendVoiceNote()` POSTs the AAC bytes, then passes the
returned path + `voiceNote:true` to `send`; it **falls back to a `data:` URL**
(generic attachment, no bubble) if staging is unreachable. Gotchas:

- **Bind `::`, not `0.0.0.0`** — Fly 6PN is IPv6-only; uvicorn does not
  dual-stack, so IPv4 wildcard is unreachable from sibling apps (silent fallback).
- **512 MB VM minimum** — signal-cli (JVM ~150-200 MB) + uvicorn OOMs a 256 MB cap.
- Keep it on the **signal** machine — don't merge into `transports/main.py` (that
  runs on the `cartesia` process). A /tmp sweeper drops files older than
  `SIGNAL_STAGING_TTL_SEC` (600 s). Auth: none (relies on 6PN scoping).

## Ops — the failure modes & the watchdog

signal-cli 0.14.3 had two independent silent failure modes that made the channel
go deaf while looking healthy (daemon up, JSON-RPC + `send` still working):

1. **`getSender`-null receive-thread WEDGE.** A null-content envelope NPEs
   `IncomingMessageHandler.getSender()`, killing the continuous receive thread.
   The poison envelope **persists** in `<acct>.d/msg-cache/` on the volume, so
   `retryFailedReceivedMessages` re-wedges on **every** restart → "fixes then
   re-dies." Recovery requires clearing/quarantining msg-cache.
2. **`getServerGuid`-null sealed-sender DROP** (upstream #2059). Around
   2026-06-10 Signal's server stopped including `serverGuid` in some
   sealed-sender envelopes; libsignal's non-null check throws and the envelope is
   dropped pre-delivery. Sealed sender is the **default** for contacts, so this
   silently killed ~all real DMs. **Fixed in signal-cli 0.14.5** (0.14.4/.5 do
   NOT fix bug 1).

**What's shipped (all live in prod as of 2026-06-25):**

- **`transports/signal-cli/watchdog.sh`** — POSIX-sh loop, health =
  (a) `receive-*` thread present, (b) daemon *owns* a relay-`:443` ESTAB
  (socket-inode-attributed — the netns `/proc/<pid>/net/tcp*` table is VM-wide in
  a Firecracker VM, so a naive read sees the whole VM), (c) no stale msg-cache
  file (older than `SIGNAL_WD_STALE_CACHE_S`=300 s). N consecutive fails →
  **quarantines** msg-cache (moves, never deletes, to
  `msg-cache-quarantine/<ts>/`) then kills signal-cli so Fly restarts clean.
  Tunable via `SIGNAL_WATCHDOG` / `SIGNAL_WD_*`.
- **nanoclaw auto-reconnect** — `signal.ts` `onClose` now schedules capped
  exp-backoff reconnect (re-dial + re-`updateProfile`/`Configuration` +
  **re-`subscribeReceive`** on a fresh client). Previously `onClose` only logged,
  so a dropped TCP link stayed silently dead until a nanoclaw restart.
- **`keepalive.sh`** — belt-and-suspenders against account lapse: a **weekly
  self-send** (Note-to-Self) over the daemon's socket proving the account is still
  registered + outbound works. (Note: the keep-alive plan §3.2 recommends a
  read-probe instead of a self-send; the self-send is what shipped.)

The daemon runs `--receive-mode on-start` and now runs **with `-v` / without
`--no-receive-stdout`** (2026-06-25 observability change). Structured inbound/
decrypt events are still the main gap — see `plans/signal-debugging-infra.md` P1.

**Recovery (manual, if the watchdog is bypassed):** override the machine command
to `sleep` so the daemon releases the account lock
(`flyctl machine update <id> --command "/bin/sh -c 'sleep 3600'"`), SSH in
(runtime sh is dash — no `/dev/tcp`/`ps`/`ss`; use `/proc` + `python3`), back up +
`rm` the msg-cache files, one-shot drain
(`signal-cli -a +15550100003 receive --timeout 15`), restore the entrypoint
command + restart, then **restart pat-nanoclaw** so it re-runs `subscribeReceive`.

> **Idle failure & re-registration:** PAT is on 0.14.5, past the 0.14.1 SPQR
> cutoff, so it's not in the mass force-unregister cohort. The acute recurring
> failure is a silently-dead daemon/link (now covered by the watchdog +
> auto-reconnect). The full re-registration runbook + failure-mode enumeration
> lives in **`plans/signal-keepalive-and-reregister.md`** — don't touch live
> registration state until the user says go.

## Deploy notes

Deploy `transports` from its own dir (its Dockerfile is the build context):
`cd transports && env -u FLY_API_TOKEN -u FLY_ACCESS_TOKEN flyctl deploy -c fly.staging.toml --remote-only -a <app>` (prod uses the app-scoped
`FLY_DEPLOY_TOKEN_TRANSPORTS`). Hard-won gotchas:

- **Use the JAR signal-cli + Temurin JRE, not the GraalVM native image** — the
  native binary segfaults (exit 139) on the slim base. signal-cli 0.14.5 needs
  **JRE 25** (class file 69); JRE 21 → `UnsupportedClassVersionError`. Keep the
  build-time `RUN signal-cli --version` smoke check.
- **Bind the daemon to an IP literal / wildcard, not a hostname** — signal-cli's
  socket handler won't bind `fly-local-6pn:7583`; use `0.0.0.0:7583`
  (`SIGNAL_TCP_BIND`, resolves to the `[::]` wildcard).
- **Adapter DNS must be process-scoped:**
  `signal.process.pat-transports.internal:7583` — plain `pat-transports.internal`
  is round-robin across cartesia+signal machines → 50 % connection-refused.
- **State migration is chicken-and-egg** — the daemon needs valid volume state to
  boot, but a stateless machine crash-loops out of SSH reach. Override the
  command to `sleep` first, upload state
  (`transports/scripts/migrate-signal-state.sh`, hash-keyed + `--process-group`),
  restore the command, restart.
- **Deploy tokens are app-scoped** — they can deploy/set-secrets but **cannot
  issue SSH certs** (org op); use default flyctl auth for `flyctl ssh`.
- **Version-bump = deploy, not re-register:** bump `SIGNAL_CLI_VERSION` in
  `transports/Dockerfile` (two ARG lines) and redeploy. Signal deprecates client
  versions on a ~3-month window and signal-cli trails 1-2 months — bump on
  maintenance passes so we never rot into a forced unregister.
- `pat-transports-staging` is **cartesia-only** (no signal process/identity/
  volume) — you cannot reproduce a real signal wedge on staging without
  registering a burner. Use the test rigs.

## Test rigs

Two single-account Fly apps wrap signal-cli for off-prod end-to-end testing
(split from a prior multi-account app because multi-account daemon mode
cross-contaminated the identity store):

| App | E164 | ACI UUID |
|---|---|---|
| `pat-signal-rig` | `+15550100005` | fetch via `GET /address` |
| `pat-signal-rig-b` | `+15550100006` | fetch via `GET /address` |

Same bearer for both. Endpoints: `GET /healthz` (no auth), `GET /status`,
`GET /address` (returns own `{number, uuid, profile_name}` — **fetch the
recipient's UUID here and send by UUID** to dodge the ACI/PNI drop),
`POST /send` (`recipient` accepts E164 or ACI UUID), `WS /ws` (filtered
broadcast). Live integration suite:
`signal-test-rig/tests/integration/test_b2b_live.py`
(`PAT_SIGNAL_RIG_TOKEN=<token> uv run pytest -m integration`). Each app has a 1 GB
volume + the same chicken-and-egg migration script. The rigs are the intended
off-prod receive/decrypt harness — see `plans/signal-debugging-infra.md` P2.

## Key files

- `nanoclaw/src/channels/signal.ts` — adapter (connect, `subscribeReceive`,
  auto-reconnect, `signal.send-acked`/`send-failed` events).
- `transports/signal-cli/{entrypoint.sh,watchdog.sh,keepalive.sh}` — daemon
  launch + liveness + account keep-alive.
- `transports/signal_staging.py` — voice-memo file-staging sidecar.
- `transports/Dockerfile` — `SIGNAL_CLI_VERSION` (currently 0.14.5) + JRE 25.
- `transports/scripts/migrate-signal-state.sh` — hash-keyed state migration.
- `transports/log_events.py` — where new `signal.*` structured kinds get declared.
