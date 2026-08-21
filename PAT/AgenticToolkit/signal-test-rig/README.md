# signal-test-rig

WebSocket-fronted wrapper around `signal-cli` for **one or more burner
phones**, used as the "other party" in PAT smoketests. Multi-subscriber
WS so several agents / dashboards / pytest harnesses can tail the same
Signal account(s) at once. Shared-secret bearer auth.

This is **not** part of the PAT runtime — it is test scaffolding that
runs on your laptop (or on a Fly app — see "Fly deploy" below) to drive
the burner side of a conversation while you exercise PAT.

**Multi-account.** `SIGNAL_TEST_RIG_ACCOUNTS=+A,+B,...` fronts every
listed burner through one rig. signal-cli boots in multi-account daemon
mode (no `-a` flag) and every RPC carries `{"account": "+E164"}`. Each
inbound event broadcast on the WS carries `data.account` so subscribers
can tell which burner received it. `POST /send` picks the from-burner
via the optional `account` field (E164 or positional `[N]` index;
defaults to `accounts[0]` for back-compat).

`SIGNAL_TEST_RIG_ACCOUNT=+A` (singular) is still accepted as a
single-account alias.

## Topology

```
┌────────────────────────────────────────────────┐
│  signal-cli daemon  (127.0.0.1:7583)           │
│  -a <burner-E164>   state ~/.local/share/...   │
└────────────────────────────────────────────────┘
                  ▲
                  │ newline-delim JSON-RPC over TCP
                  │
┌─────────────────┴──────────────────┐
│  signal-test-rig (FastAPI, :7585)  │
│   GET  /healthz                    │
│   GET  /status   (bearer)          │
│   POST /send     (bearer)          │
│   WS   /ws       (bearer, fanout)  │
└─────────────────┬──────────────────┘
                  │
   ┌─────────┬────┴─────┬─────────┬───────────┐
   ▼         ▼          ▼         ▼           ▼
 wscat   examples/   pat-monitor  logger    pytest
         ws_client    (curious)
```

## One-time setup: register each burner

The rig **does not** register or link a Signal account. Do that yourself
once **per burner**; the rig then attaches to every registered identity
on every start.

```bash
# 1. Install signal-cli (Homebrew on macOS — first install only).
brew install signal-cli

# 2. Register each burner. This sends a 6-digit SMS to that phone.
signal-cli -a +14155551234 register
# (use --voice if SMS doesn't arrive; some carriers throttle codes)

# 3. Verify with the code you received.
signal-cli -a +14155551234 verify 123456

# 4. (Optional) set a display name so PAT sees something human-readable.
signal-cli -a +14155551234 updateProfile --name "Smoketest Burner"

# 5. Repeat steps 2-4 for every burner you want to address through the rig.
```

State lives under `~/.local/share/signal-cli/` with one
hash-keyed directory per account; `data/accounts.json` maps E164s to
hash paths. **Back this directory up** if you don't want to re-register
after a laptop wipe.

## Run

```bash
cd signal-test-rig

# Install deps (creates .venv via uv).
uv sync

# Pick a token (use `openssl rand -hex 32` or similar).
export SIGNAL_TEST_RIG_TOKEN="<opaque-string>"

# Multi-account form (preferred). accounts[0] is the implicit /send default.
export SIGNAL_TEST_RIG_ACCOUNTS="+15550100005,+15550100006"

# (Single-account form, still accepted for back-compat:)
# export SIGNAL_TEST_RIG_ACCOUNT="+14155551234"

# Option A — let the rig spawn signal-cli itself in multi-account mode:
export SIGNAL_TEST_RIG_MANAGE_DAEMON=1
uv run python -m signal_test_rig.main

# Option B — run signal-cli in a separate terminal (also multi-account mode!),
# attach the rig:
#   $ signal-cli daemon --tcp 127.0.0.1:7583 \
#        --no-receive-stdout --receive-mode on-start
#   $ uv run python -m signal_test_rig.main
```

Note: `signal-cli daemon` WITHOUT `-a` is the multi-account form. Adding
`-a +E164` switches the daemon to single-account mode, where RPCs MUST
NOT include an `account` param — which conflicts with the rig's wire
shape. Always omit `-a` when running the daemon for the rig.

Sanity check:

```bash
curl http://127.0.0.1:7585/healthz
# {"status":"ok","service":"signal-test-rig","ws_clients":0}
```

## WS protocol

Connect with bearer auth. Browsers (which can't set arbitrary handshake
headers) may pass `?token=…` instead.

```bash
# Header-mode (preferred — token never in URL/access logs):
websocat \
  -H "Authorization: Bearer $SIGNAL_TEST_RIG_TOKEN" \
  ws://127.0.0.1:7585/ws

# Query-param mode (browser-compatible):
websocat "ws://127.0.0.1:7585/ws?token=$SIGNAL_TEST_RIG_TOKEN"
```

All frames are JSON objects with this top-level shape:

```jsonc
{
  "kind": "<event>",
  "ts":   "2026-05-21T20:24:29.213Z",
  "data": { /* kind-specific */ }
}
```

### `kind` catalog

| `kind`               | When emitted                                  | `data` shape (key fields)                                                                                              |
| -------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ready`              | On bridge-up and on per-client connect        | `{accounts: [...], default_account, account}` — `account` retained as alias for `default_account` (back-compat)        |
| `inbound`            | signal-cli pushed a `receive` envelope        | `{account, source, source_name?, source_uuid?, text, timestamp_ms?, group_id?, attachments[], raw_envelope}`           |
| `sent`               | After a successful `POST /send`               | `{account, recipient?, group_id?, text, signal_timestamp?}`                                                            |
| `signal.notification`| Non-`receive` push from signal-cli            | `{method, params}` (raw passthrough — rare; inspect if you see it)                                                     |

`data.account` is the rig's configured burner E164 that received the
envelope (or sent it, for `sent` frames) — i.e. which of your
`SIGNAL_TEST_RIG_ACCOUNTS` was actually addressed. Filter with
`?account=+E164` on the WS to isolate one burner's traffic.

`raw_envelope` is the literal signal-cli envelope (same shape as
`nanoclaw/src/channels/signal.ts:490` `SignalEnvelope`), so consumers
needing fields the rig doesn't promote (e.g. `quote`, `mentions`,
`syncMessage`) can dig in directly.

### Multiple subscribers

Every connected client receives every event. Send order is per-client
concurrent — a slow client doesn't block the others, and a dead client
gets dropped silently on its next failed send.

## REST endpoints

All authenticated endpoints require `Authorization: Bearer
$SIGNAL_TEST_RIG_TOKEN`.

| Method | Path        | Auth | Purpose                                                                  |
| ------ | ----------- | ---- | ------------------------------------------------------------------------ |
| GET    | `/healthz`  | no   | Cheap liveness probe (does not touch signal-cli)                         |
| GET    | `/status`   | yes  | Reports `bridge_connected`, `account`, `ws_clients`                      |
| POST   | `/send`     | yes  | Send text from the burner. Body: `{recipient \| group_id, text}`         |
| WS     | `/ws`       | yes  | Subscribe to broadcast event stream                                      |

### `POST /send`

```bash
# Default: sends from accounts[0].
curl -X POST http://127.0.0.1:7585/send \
  -H "Authorization: Bearer $SIGNAL_TEST_RIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"recipient": "+14155550100", "text": "hello"}'
```

To pick which burner sends, add an `account` field — either a configured
E164 literal OR a positional `[N]` index:

```bash
# By E164:
curl -X POST http://127.0.0.1:7585/send \
  -H "Authorization: Bearer $SIGNAL_TEST_RIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"account": "+15550100006", "recipient": "+14155550100", "text": "hi from B"}'

# By index (accounts[1] = the second burner in SIGNAL_TEST_RIG_ACCOUNTS):
curl -X POST http://127.0.0.1:7585/send \
  -H "Authorization: Bearer $SIGNAL_TEST_RIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"account": "[1]", "recipient": "+14155550100", "text": "hi from B"}'
```

Unconfigured E164 or out-of-range index → `400`.

To send to a group, swap `recipient` for `group_id` (the V2 group id,
**without** the `signal:` or `group:` prefix):

```bash
curl -X POST http://127.0.0.1:7585/send \
  -H "Authorization: Bearer $SIGNAL_TEST_RIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"group_id": "abc123groupid", "text": "hi all"}'
```

## Examples

### `examples/ws_client.py`

Pure-Python WS subscriber, prints every frame. Use as the starting point
for a richer tail / TUI.

```bash
export SIGNAL_TEST_RIG_TOKEN="..."
uv run --with websockets python examples/ws_client.py
```

### `examples/send_to_pat.sh`

Convenience curl wrapper.

```bash
export SIGNAL_TEST_RIG_TOKEN="..."
examples/send_to_pat.sh +15550100000 "hey pat, can you hear me?"
```

## Configuration

| Env var                              | Default       | Notes                                                                                                                       |
| ------------------------------------ | ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `SIGNAL_TEST_RIG_TOKEN`              | **required**  | Shared-secret bearer. Refuse-to-start if missing.                                                                           |
| `SIGNAL_TEST_RIG_ACCOUNTS`           | **required\*** | Comma-separated burner E164s (e.g. `+A,+B`). `accounts[0]` is the implicit `/send` default. Each must be registered locally. |
| `SIGNAL_TEST_RIG_ACCOUNT`            | (alias)       | Singular form — back-compat alias for single-account setups. Either `SIGNAL_TEST_RIG_ACCOUNTS` or this must be set.          |
| `SIGNAL_TEST_RIG_PORT`               | `7585`        | HTTP / WS listen port.                                                                                                      |
| `SIGNAL_TEST_RIG_BIND`               | `127.0.0.1`   | Bind addr. Loopback by default; widen at your own risk.                                                                     |
| `SIGNAL_TEST_RIG_TCP_HOST`           | `127.0.0.1`   | signal-cli daemon host.                                                                                                     |
| `SIGNAL_TEST_RIG_TCP_PORT`           | `7583`        | signal-cli daemon port.                                                                                                     |
| `SIGNAL_TEST_RIG_MANAGE_DAEMON`      | `0`           | If `1`, spawn `signal-cli daemon` (always multi-account, no `-a`) as a child process. Otherwise attach to one.              |
| `SIGNAL_TEST_RIG_SIGNAL_CLI_BIN`     | `signal-cli`  | Path to the signal-cli binary (when `MANAGE_DAEMON=1`).                                                                     |

\* One of `SIGNAL_TEST_RIG_ACCOUNTS` or `SIGNAL_TEST_RIG_ACCOUNT` must
be set. If both are set, the plural form wins.

## Trace lines

The rig emits one JSON line to stdout per send / per inbound / per WS
event, all with a top-level `kind` discriminator. Same discipline as
the PAT runtime, but the rig is **not** part of the PAT log schema
(`realtime/src/log-events.ts`) — it's a separate test process.

```bash
uv run python -m signal_test_rig.main 2>&1 | grep '"kind":"inbound"' | jq
```

## Tests

```bash
# From inside this directory:
cd signal-test-rig
uv run pytest

# Or from the repo root:
uv run --project signal-test-rig pytest signal-test-rig/
```

Tests are mock-backed: a tiny in-process TCP server (its own thread + loop,
so it doesn't deadlock against TestClient's worker thread) stands in for
the signal-cli daemon. The real `SignalCliBridge` and the real FastAPI
app are exercised end-to-end — only the network-facing endpoint is faked.
No actual signal-cli install required.

## Fly deploy

The rig runs locally by default, but the same image deploys to Fly as
`pat-signal-rig`. Useful when you want the burners reachable from CI or
from PAT itself (e.g. a smoketest scheduled from pat-frontend that
needs to drive the burner without your laptop being awake).

```bash
cd signal-test-rig

# 1. Create the app + the per-region volume that holds signal-cli state.
flyctl apps create pat-signal-rig --org <your-org>
flyctl volumes create pat_signal_rig_state -a pat-signal-rig -r sjc -s 1

# 2. Set secrets (token + account list).
flyctl secrets set -a pat-signal-rig \
  SIGNAL_TEST_RIG_TOKEN=<openssl rand -hex 32 output> \
  SIGNAL_TEST_RIG_ACCOUNTS=+15550100005,+15550100006

# 3. Migrate signal-cli state from your local Mac to the volume.
#    This stops the machine, overrides its command to `sleep` so SSH
#    stays available even if the volume is empty, SFTPs a tarball of
#    data/accounts.json + data/<hash>/ + data/<hash>.d/ for every named
#    burner, extracts on the volume, restores the original command,
#    and restarts the machine. Idempotent.
scripts/migrate-signal-rig-state.sh +15550100005 +15550100006

# 4. Deploy.
flyctl deploy --remote-only
```

After deploy:

```bash
URL=https://pat-signal-rig.fly.dev
TOKEN=<the SIGNAL_TEST_RIG_TOKEN you set>

# Liveness probe — no auth required.
curl -sS "$URL/healthz"

# Authenticated status — shows accounts + bridge_connected.
curl -sS -H "Authorization: Bearer $TOKEN" "$URL/status" | jq

# Subscribe to inbound events for one burner:
websocat -H "Authorization: Bearer $TOKEN" \
  "wss://pat-signal-rig.fly.dev/ws?account=+15550100005&kind=inbound.text"
```

Bind notes (see `reference_pat_signal_deploy.md` for the deep story):
- signal-cli's `SocketHandler` can't bind to hostnames — `entrypoint.sh`
  binds it to `127.0.0.1:7583` (loopback-only inside the container; the
  rig is on the same VM).
- The rig itself binds to `::` so Fly's edge proxy can reach it.

State migration uses the multi-account-friendly hash-keyed path layout
that signal-cli 0.14.x introduced. See `scripts/migrate-signal-rig-state.sh`
for the full sequence.

## Two-burner topology (split rig)

The current production setup runs each burner in its **own** Fly app, on
its **own** Fly volume, with its **own** single-account signal-cli
daemon. The two daemons treat each other as ordinary remote Signal
contacts — same wire path the apps use to reach any other Signal user.

```
   ┌──────────────────────────────┐    ┌──────────────────────────────┐
   │ pat-signal-rig (app A)       │    │ pat-signal-rig-b (app B)     │
   │   account: +15550100005      │    │   account: +15550100006      │
   │   volume:  pat_signal_rig_…  │    │   volume:  pat_signal_rig_b_…│
   │   accts.json: [+A] only      │    │   accts.json: [+B] only      │
   └──────────────────────────────┘    └──────────────────────────────┘
                ▲                                       ▲
                │  bearer auth + REST/WS                │
                ▼                                       ▼
            consumers (smoketests, dashboards, ad-hoc curl)
```

The two apps share the same `SIGNAL_TEST_RIG_TOKEN` so a consumer can
hold a single secret and address either burner by hostname:

| Burner | App                | URL                                |
| ------ | ------------------ | ---------------------------------- |
| +A     | `pat-signal-rig`   | `https://pat-signal-rig.fly.dev`   |
| +B     | `pat-signal-rig-b` | `https://pat-signal-rig-b.fly.dev` |

### Why split

Earlier the rig fronted both burners through a single multi-account
daemon (`SIGNAL_TEST_RIG_ACCOUNTS=+A,+B`). Burner-to-burner messages
arrived as `inbound.unknown` (envelope present, body never decrypted)
even after `removeContact` / clean re-registration. Suspected cause:
multi-account daemon's shared identity store cross-contaminating
sibling-recipient identity records during the send pipeline. Splitting
the daemons isolates the identity stores so each one only ever holds
its own account's prekeys + contact identities.

Whether the split *actually* fixes the B2B decrypt is a separate
question — there's a known caveat about pre-split corruption persisting
in the on-disk identity store; see `KNOWN_ISSUES.md` /
`reference_pat_signal_deploy.md` for the current status.

### Fly config files

- `fly.toml`     — `pat-signal-rig`   (burner A)
- `fly.b.toml`   — `pat-signal-rig-b` (burner B)

Same Dockerfile, same entrypoint. Each `flyctl deploy` is scoped with
`-c <toml>`.

### Bootstrapping app B (one-time)

```bash
cd signal-test-rig

# 1. Create app + volume + secrets.
flyctl apps create pat-signal-rig-b -o <redacted-fly-org>
flyctl volumes create pat_signal_rig_b_state -a pat-signal-rig-b -r sjc -s 1
flyctl secrets set -a pat-signal-rig-b \
  SIGNAL_TEST_RIG_TOKEN="<same value as pat-signal-rig>" \
  SIGNAL_TEST_RIG_ACCOUNTS=+15550100006

# 2. Initial deploy — will fail health check because the volume is empty.
#    That's expected; we just need the machine to exist so the migration
#    script can SSH into it via the sleep-override hatch.
flyctl deploy -c fly.b.toml --remote-only || true

# 3. Migrate +B's state from the local Mac onto the new volume.
scripts/migrate-signal-rig-b-state.sh +15550100006

# 4. Verify.
URL=https://pat-signal-rig-b.fly.dev
TOKEN="<the token>"
curl -sS "$URL/healthz"
curl -sS -H "Authorization: Bearer $TOKEN" "$URL/status" | jq
# Expect: {"accounts":["+15550100006"], "bridge_connected": true, ...}
```

### Shrinking app A from multi-account → single-account

Already done; here for reference if you ever need to re-shrink:

```bash
# 1. Drop +B from the env-var account list.
flyctl secrets set -a pat-signal-rig SIGNAL_TEST_RIG_ACCOUNTS=+15550100005

# 2. Trim data/accounts.json on the volume so the daemon doesn't auto-load +B.
#    The original is preserved at data/accounts.json.bak-pre-split.
flyctl ssh console -a pat-signal-rig -C "/bin/sh -c '
  cd /root/.local/share/signal-cli/data
  cp accounts.json accounts.json.bak-pre-split
  cat > accounts.json <<JSON
{
  \"accounts\" : [ { \"path\" : \"<A_HASH>\", \"environment\" : \"LIVE\",
                     \"number\" : \"+15550100005\", \"uuid\" : \"<A_UUID>\" } ],
  \"version\" : 2
}
JSON
'"

# 3. Restart so the daemon reloads with the new account list.
flyctl machine restart <machine-id> -a pat-signal-rig
```

`data/<hash>/` + `data/<hash>.d/` for the dropped burner are
intentionally left in place on the existing volume as a recovery hatch —
the daemon no longer references them but the bytes are still there if
you need to roll back.

### Verification (B2B)

```bash
TOKEN="<the token>"

# Tail A's inbound stream:
SIGNAL_TEST_RIG_URL=wss://pat-signal-rig.fly.dev/ws \
SIGNAL_TEST_RIG_TOKEN=$TOKEN \
uv run --with websockets python examples/ws_client.py &

# In another shell: send B → A.
curl -X POST https://pat-signal-rig-b.fly.dev/send \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"recipient": "+15550100005", "text": "hi from B"}'

# Expect on A's tail: a frame with kind=inbound.text and data.text="hi from B".
# Symptom of identity-store corruption (pre-split or stale): inbound.unknown
# instead, with empty text + no source_name + raw_envelope missing dataMessage.
```

## What's intentionally NOT here

- **Registration / linking flow.** Run `signal-cli register` yourself
  for every burner. The rig only attaches.
- **Attachment send.** Outbound from the rig is text-only — sufficient
  for "other party" smoketest needs. Inbound attachments are surfaced as
  metadata in `data.attachments[]`; fetching the actual bytes is the
  consumer's job (use `signal-cli ... getAttachment <id>` against the
  same daemon).
