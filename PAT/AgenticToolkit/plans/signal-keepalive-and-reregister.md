# Signal keep-alive + re-registration runbook

**Status (split):**
- **Keep-alive half — SHIPPED 2026-06-25.** A keep-alive loop is now live. Note it
  shipped as a **weekly self-send** — which *diverges* from §3.2's explicit
  "do NOT send a self-message as a keep-alive (use a read probe)" recommendation.
  So the monitoring/health-probe design in §3 is the intended target shape, not
  what's running; the current keep-alive is a self-send on a weekly cadence.
- **§4 re-registration runbook — still UNEXECUTED.** The live Signal registration /
  signal-cli state has NOT been touched. Do not register, unlink, or restart the
  signal machine for re-registration until the user says go.

**Date:** 2026-06-22
**Trigger:** "our signal thing failed again because we didn't check it often
enough" — Signal channel keeps lapsing when idle; user wants a keep-alive loop +
a ready-to-run re-registration procedure (re-registration NOT yet authorized).

---

## 0. TL;DR / quick recommendation

**The right fix is keep-alive + monitoring, NOT re-registration right now** —
*provided* PAT's account is still registered (verify first, §4 step 0). Reasoning:

- PAT runs **signal-cli 0.14.3** (Dockerfile `SIGNAL_CLI_VERSION=0.14.3`). SPQR
  capability was added in **0.14.1**, so PAT is **not** in the cohort that got
  mass force-unregistered on 6 March 2026 (that hit ≤0.14.0). So the most
  catastrophic idle failure mode (server-side deactivation for missing SPQR)
  does **not** currently apply to us.
- The pat-transports app (incl. the signal machine) has not been redeployed
  since **2026-05-14**. The signal machine `185536ef2dd268` is `started` but has
  **zero health checks** (`CHECKS` column empty in `flyctl status`). There is no
  liveness signal on signal-cli at all — that is *exactly* "we didn't check it
  often enough." We find out it's down only when a human notices a missed reply.
- signal-cli already runs `daemon --receive-mode on-start`, which keeps a
  receive stream open. So the session *should* stay warm while the daemon is up.
  The real-world failures are: (a) the daemon/machine silently died or lost its
  receive stream and nobody noticed; (b) prekey/identity drift over long idle;
  (c) eventual forced unregister when our signal-cli version ages past Signal's
  ~3-month server deprecation window.

So: **build the monitor first** (so we stop being surprised), **add an explicit
periodic receive/health probe** as the keep-alive, and **keep this
re-registration runbook on the shelf** for when (c) eventually bites or the §4
step-0 check shows we're already unregistered.

One forward-looking note: signal-cli 0.14.3 was released 2026-04-22; latest is
**0.14.5 (2026-06-11)**. Signal gives apps a ~3-month deprecation window and
signal-cli runs 1–2 months behind. Staying on 0.14.3 is fine *today* but is a
ticking clock — bump to latest on the next maintenance pass (separate from this
keep-alive work; a version bump is a deploy + rebuild, not a re-register).

---

## 1. Current wiring (what exists today)

```
pat-nanoclaw (Node host)                      pat-transports / process group `signal`
─────────────────────────                     ──────────────────────────────────────
src/channels/signal.ts                         signal-cli/entrypoint.sh
  SignalTcpClient ──── 6PN TCP/JSON-RPC ─────▶  signal-cli -a +15550100003 daemon
  connect()                                       --tcp 0.0.0.0:7583
  subscribeReceive()                              --no-receive-stdout
  onClose → set connected=false, log.warn         --receive-mode on-start
  (NO auto-reconnect)                           signal_staging.py  (FastAPI :7584, /healthz)
                                                State: Fly volume pat_signal_state
SIGNAL_TCP_HOST=                                  → /root/.local/share/signal-cli
  signal.process.pat-transports.internal       Account: +15550100003, PRIMARY device
SIGNAL_MANAGE_DAEMON=false                        ACI: see docs/signal.md
```

Key code facts (read before changing anything):

- **Adapter does not own the daemon.** `SIGNAL_MANAGE_DAEMON=false` on
  pat-nanoclaw; the daemon lives on the sibling Fly machine. So a nanoclaw
  redeploy does NOT restart signal-cli. (`signal.ts:1388`)
- **No auto-reconnect.** `onClose` just flips `connected=false` and logs a
  `log.warn('Signal channel lost TCP connection to signal-cli daemon')`. After
  that, every `deliver`/`setTyping` silently short-circuits on `!connected`.
  (`signal.ts:1402-1414`, `:1480`, `:1499`) → **A dropped TCP link is invisible
  to the user and only recovers on a nanoclaw host restart.**
- **`subscribeReceive` is per-client and required.** Without it the adapter goes
  silent even if the daemon is healthy. It's only called once, in `setup()`. If
  the socket drops and the host doesn't re-run setup, inbound stops.
  (`signal.ts:1448-1454`)
- **`updateConfiguration({readReceipts, typingIndicators})`** is set once on
  connect and persisted in volume state. (`signal.ts:1431`)
- **Send observability already exists:** `signal.send-acked` / `signal.send-failed`
  structured events fire per RPC roundtrip (`signal.ts:1044-1077`). These are
  the hooks a monitor can alert on.
- **No keep-alive / no health probe of signal-cli exists anywhere.** The
  staging sidecar's `/healthz` (`signal_staging.py:94`) only confirms the
  FastAPI process is up — it does not query signal-cli or check registration.
  `scripts/pat-monitor.sh` has no Signal coverage.

Live state confirmed read-only on 2026-06-22:
- `pat-transports` machines: 2× cartesia (checks passing), 1× signal
  (`185536ef2dd268`, started, **0 checks**), image `deployment-01KRJ0AW…`,
  last updated 2026-05-14.
- Account/identity: `+15550100003`; **address by ACI, not E164** (`getUserStatus`
  returns the *PNI*, which is the silent-drop trap). Look up the current ACI/PNI
  per `docs/signal.md` — not pinned here (they change on re-registration). Primary
  device (re-registered 2026-05-11), no registration-lock PIN set.

---

## 2. Why Signal keeps failing when idle — failure-mode enumeration

Ranked by fit to "failed because we didn't check it often enough":

### A. Daemon/machine died or lost receive stream, unnoticed  ← most likely fit
The signal machine has no Fly health check and no app-level liveness probe.
signal-cli (JVM, ~150–200MB) can OOM, the machine can be reaped/restarted by
Fly, or the long-lived receive websocket to Signal's relay can drop. signal-cli
*should* reattach to the same identity from the volume on machine restart — but
if (i) the daemon comes back but the nanoclaw adapter's TCP socket already
dropped (no auto-reconnect, §1), or (ii) the daemon process is wedged but the
machine is still "started," nothing tells us. **This is the canonical "didn't
check often enough" failure.** Recoverable without re-registration.

### B. Prekey staleness / "messages not received regularly"
signal-cli's man page: *"For some functionality the Signal protocol requires
that all messages have been received from the server. The `receive` command
should be regularly executed."* Idle accounts that stop receiving can hit prekey
issues (decryption failures from new senders, e.g. `InvalidKeyIdException: No
such kyber pre key record`). signal-cli auto-refreshes prekeys when low — but
only while it's actively receiving. Daemon `--receive-mode on-start` is supposed
to keep this alive, so this is a *secondary* risk that only surfaces if the
daemon was actually down (folds into A). Recoverable without re-registration
(a `receive` + prekey refresh fixes it).

### C. Forced server-side unregister for outdated signal-cli  ← future risk
On **6 March 2026** Signal's server began unregistering accounts lacking **SPQR**
capability. signal-cli set `spqr=true` in **v0.14.1**; PAT is on 0.14.3, so
**not currently affected**. But Signal does breaking backend changes after a
~3-month deprecation window, and signal-cli trails by 1–2 months. So a future
mandatory-capability cutover *will* eventually unregister us if we let the
version rot. **This is the one failure mode that genuinely requires
re-registration** (§4) — and it is version-driven, not idle-driven, so a
keep-alive loop does NOT prevent it. Mitigation = keep signal-cli current.
(Source: signal-cli issue #1993; maintainer AsamK confirms 0.14.1+ is safe.)

### D. ACI/PNI cached-key silent drop
Per `reference_signal_cli_aci_pni_quirk.md`: a stale cached PNI fingerprint vs
the recipient's live ACI key causes silent body-decryption failure. Affects
sends to/from stale contacts (esp. other signal-cli burners, or real users in
phone-privacy mode who haven't messaged us in a long time). Looks like "Signal
broke" but is per-contact, not account-wide. Fix = address by ACI UUID or
`getUserStatus`-refresh the contact before send. Not idle-account-wide;
unaffected for normal real-Signal-client users.

### E. Long-idle account deletion / reg-lock reset (slow, not our acute issue)
- Signal deletes accounts inactive **> 1 year** (server logs last-login year).
  PAT was re-registered 2026-05-11 and is well inside that. Not our problem now,
  but a totally-dark account for a year would be deleted.
- Registration-lock PIN resets after **7 days** of inactivity — only relevant if
  a PIN were ever set (PAT has none). No reclaim risk in the keep-alive window.

### F. Captcha / rate-limit lockout on reconnect
Not an *idle* failure — only bites during a *re-register* after long idle
(captcha required, possible rate-limit on repeated attempts). Relevant to §4,
not to steady-state keep-alive.

**Diagnosis:** the acute, recurring "failed again because we didn't check often
enough" symptom is **A** (silent daemon/link death with no monitoring),
secondarily **B**. Both are recoverable without re-registration. **C** is the
real future re-registration trigger and is the reason the §4 runbook exists.

---

## 3. Keep-alive + monitoring design (recommended, NOT yet built)

Two layers. Build the **monitor first** — it's the thing that was missing.

### 3.1 Liveness/health monitor (build first — closes the "didn't check" gap)

**Goal:** know Signal is down BEFORE a demo, not after, with a signal we can
alert on. Add a Signal section to `scripts/pat-monitor.sh` (or a small
standalone `scripts/signal-health.sh`) that runs on a schedule (the user's
`/schedule` or `/loop` skill, or a Fly scheduled machine — see cadence below).

Three independent checks, cheapest → strongest:

1. **Machine up?** (cheap, read-only, no auth on account state)
   ```bash
   env -u FLY_API_TOKEN -u FLY_ACCESS_TOKEN \
     flyctl status -a pat-transports --json \
     | jq -e '.Machines[] | select(.config.metadata.fly_process_group=="signal")
              | select(.state=="started")' >/dev/null
   ```
   Fails ⇒ machine stopped/crash-looping. Alert.

2. **TCP JSON-RPC reachable + daemon answers?** (proves signal-cli is alive,
   not just the VM). Run from *inside* the org's 6PN — e.g. add a tiny
   read-only `GET /signal/health` to the cartesia process on pat-transports
   (same app, can reach `localhost`/6PN), or `flyctl ssh console` into the
   signal machine and call the daemon. The strong probe is a JSON-RPC
   round-trip that reads account state WITHOUT sending:
   ```jsonc
   // newline-delimited JSON-RPC to 127.0.0.1:7583, e.g. via nc or a 20-line script
   {"jsonrpc":"2.0","method":"listAccounts","id":"hc"}
   // or, scoped to our number, prove registration:
   {"jsonrpc":"2.0","method":"getUserStatus","params":{"account":"+15550100003","recipients":["+15550100003"]},"id":"hc"}
   ```
   `listAccounts` returning our number ⇒ daemon healthy + registered.
   A timeout / empty result ⇒ daemon wedged or unregistered. Alert.
   (READ-ONLY: `listAccounts` and `getUserStatus` neither send nor mutate.)

3. **Registration still valid?** (catches failure mode C/E). `getUserStatus`
   on our own number returns `{registered: true, uuid: ...}` while registered;
   a registered=false / unregistered error is the unambiguous "must
   re-register" signal → page a human and open the §4 runbook. Do this less
   often than checks 1–2 (it's the slow failure mode).

**Alerting hook:** the monitor already has structured logs to lean on. Treat any
absence of recent `signal.send-acked` paired with a `signal.send-failed`, or a
failed health probe, as the alert condition. Emit a `kind:'misc'` (or a new
declared `kind`) event so pat-frontend / `jq` can slice it; optionally push to
the same place pat-monitor.sh already notifies.

### 3.2 Keep-alive (lighter — the daemon already mostly does this)

signal-cli `daemon --receive-mode on-start` already holds the receive stream
open, which is the protocol's "receive regularly" requirement (§2B). So a heavy
external keep-alive is **not** strictly needed *while the daemon is healthy*. The
value-add keep-alive is a **belt-and-suspenders periodic touch** that also
doubles as health-check #2:

- **Mechanism:** every **N minutes**, do a no-op read RPC against the daemon
  (`listAccounts`, or a bounded `receive` with a short timeout). This both
  proves liveness and nudges signal-cli to drain/refresh if its stream silently
  stalled. Do **not** send a self-message as a keep-alive (it pollutes Note to
  Self / triggers the echo cache; the read probe is sufficient).
  > **Shipped divergence (2026-06-25):** the keep-alive that actually shipped is a
  > **weekly self-send**, not the read probe recommended here. It works but carries
  > the self-message downsides above; revisit toward this read-probe design.
- **Where it runs:** cheapest place that's already on 6PN and already a daemon:
  add it to the **cartesia process on pat-transports** (a Python `asyncio` task
  that opens a socket to `127.0.0.1:7583` — actually the signal machine, so use
  `signal.process.pat-transports.internal:7583` — every N min), OR a Fly
  **scheduled machine** in the same app. Avoid putting it in the nanoclaw host
  loop: the host already has `host-sweep` at 60s but it's a different process
  and would cross 6PN for no benefit over co-locating with cartesia.
- **Cadence recommendation:**
  - Health checks 1+2 / keep-alive read probe: **every 2–5 minutes.** Cheap,
    catches a dead daemon within one demo-prep window.
  - Registration check (3): **every 1–6 hours.** It's the slow failure mode;
    no need to hammer `getUserStatus`.
  - Rationale: the failure was "didn't check often enough." A 2–5 min liveness
    probe means worst-case detection is ~5 min, not "whenever a human notices."

- **Reconnect gap to fix alongside (code, in `signal.ts`):** today `onClose`
  has no auto-reconnect (`signal.ts:1402`). Even with a perfect daemon, if the
  *adapter↔daemon TCP socket* drops, inbound dies until a nanoclaw restart. A
  small reconnect loop in the adapter (re-`connect` + re-`subscribeReceive`,
  with backoff) would close the most common silent-inbound failure. This is a
  separate code change from the monitor; flagged here because the monitor would
  otherwise keep alerting on a problem the adapter could self-heal. (Marked as a
  follow-up, not part of "don't touch live state" — it's source, not registration.)

### 3.3 Minimal-change variant (if we want the smallest first step)

If the user just wants the fastest win with zero infra: add the `flyctl status`
+ `getUserStatus`-via-ssh checks to `scripts/pat-monitor.sh` and run it under
`/schedule` every 5 min. No new process, no deploy, read-only against live
state, and it would have caught every past "we didn't notice it was down."

---

## 4. Re-registration runbook (READY — DO NOT RUN until user says go)

Use this when: §4 step 0 shows the account is unregistered, OR a future
mandatory-capability cutover (failure mode C) unregisters us. Re-registration of
a primary device with intact local volume state is **non-destructive to chat
identity** (same number, same chat history on linked devices) but **resets
profile/config** (name, readReceipts, typingIndicators) — those must be re-set
(steps 7–8). It is **not** reversible in the sense of "undo," but it's safe and
idempotent.

> ⚠️ Destructive/irreversible flags:
> - `register` (without `--reregister`) on a number you don't control the SIM
>   for can fail; we DO control the SIM (Android holding +15550100003).
> - There is **no registration-lock PIN** on this account, so no
>   `RegistrationLockError` and no 7-day wait. If a PIN ever gets set, you need
>   `--pin <PIN>` or wait 7 days for reglock to lapse.
> - Re-registering **resets profile + configuration** server-side → MUST re-run
>   updateProfile + updateConfiguration (steps 7–8) or read receipts / typing
>   indicators / display name silently revert.
> - Do NOT delete the Fly volume `pat_signal_state` — keeping local state means
>   chat history + linked devices survive and the daemon reattaches cleanly.

### Step 0 — Verify whether we even need to re-register (READ-ONLY)
SSH into the signal machine and ask signal-cli its own status. This does NOT
send or mutate:
```bash
cd /Users/user/Projects/AgenticToolkit/agentic_toolkit
# SSH cert is an org op — use default flyctl auth, NOT a deploy token:
flyctl ssh console -a pat-transports --process-group signal
# inside the machine:
signal-cli -a +15550100003 listAccounts          # is our number present locally?
# Prove server-side registration without sending:
#   getUserStatus on our own number returns registered=true while valid.
# (via the running daemon's JSON-RPC, or a one-shot CLI invocation when the
#  daemon is stopped — one-shot needs the daemon NOT holding the lock.)
```
- Registered + reachable ⇒ **STOP. Do not re-register.** It was failure mode A/B
  → restart the daemon/machine and fix monitoring instead.
- Unregistered / `register=false` ⇒ proceed.

### Step 1 — Snapshot the volume state first (safety)
Before any register attempt, back up the identity dir so a botched register is
recoverable:
```bash
# inside the signal machine:
tar czf /tmp/signal-state-backup-$(date +%Y%m%d-%H%M%S).tgz \
  -C /root/.local/share/signal-cli data
# copy it off the machine:
flyctl ssh sftp get /tmp/signal-state-backup-*.tgz ./signal-state-backup.tgz \
  -a pat-transports --process-group signal
```

### Step 2 — Stop the daemon so register can take the account lock
signal-cli's `register`/`verify` can't run while the daemon holds the account.
Override the machine command to idle (per `reference_pat_signal_deploy.md` Bug
"chicken-and-egg"), so the machine stays SSH-able with no daemon:
```bash
# get the signal machine id:
flyctl machines list -a pat-transports     # → 185536ef2dd268 (signal)
flyctl machine update 185536ef2dd268 \
  --command "/bin/sh -c 'sleep 86400'" -a pat-transports   # asks for authorization
# (this modifies the container CMD — requires user authorization)
```

### Step 3 — Captcha
On a browser, open:
```
https://signalcaptchas.org/registration/generate.html
```
Solve it, copy the resulting `signalcaptcha://...` URL (right-click the
"Open Signal" link → copy, or read it from devtools).

### Step 4 — Re-register (uses the SIM in the Android holding the number)
```bash
flyctl ssh console -a pat-transports --process-group signal
# inside:
signal-cli -a +15550100003 register --reregister --captcha "signalcaptcha://..."
# Signal sends a 6-digit SMS to the Android holding +15550100003.
```
If SMS doesn't arrive, retry with voice:
`signal-cli -a +15550100003 register --reregister --voice --captcha "signalcaptcha://..."`
(Beware rate-limit on repeated attempts — wait between tries.)

### Step 5 — Verify with the SMS code
```bash
signal-cli -a +15550100003 verify <6-digit-code>
```
(A `[409] Failed to refresh current username` WARN here is benign — we don't use
a username. If we did, re-set it with `updateAccount --username ...`.)

### Step 6 — Prime receive + prekeys
```bash
signal-cli -a +15550100003 receive        # drains backlog, refreshes prekeys
```

### Step 7 — Restore profile (re-register resets this)
```bash
signal-cli -a +15550100003 updateProfile --given-name "PAT"
```

### Step 8 — Restore configuration (re-register resets this)
The adapter sets these on connect (`signal.ts:1431`), so a daemon restart
re-applies them — but set them explicitly to be safe:
```bash
signal-cli -a +15550100003 updateConfiguration --read-receipts true --typing-indicators true
```

### Step 9 — ACI/PNI cache hygiene follow-up
After re-registration the ACI may differ from the cached value. Re-confirm and
update anywhere it's hard-coded:
```bash
# our own canonical address:
signal-cli -a +15550100003 listIdentities         # or getUserStatus on self
```
- If the ACI changed (compare the current `accounts.json` `uuid` against the prior
  value), update references in `docs/signal.md`, the smoketest scenario, and
  anywhere PAT's ACI is pinned. Any external sender with PAT cached at the OLD
  ACI/PNI may
  hit the silent-drop quirk (§2D) until their cache refreshes — real Signal
  clients self-heal; signal-cli burners need addressing-by-UUID.

### Step 10 — Restore the daemon command + restart
```bash
flyctl machine update 185536ef2dd268 \
  --command "/app/signal-cli/entrypoint.sh" -a pat-transports
flyctl machine restart 185536ef2dd268 -a pat-transports
flyctl logs -a pat-transports | grep -i "starting daemon"
```

### Step 11 — Re-verify end-to-end (send AND receive)
```bash
# host side: confirm the adapter reconnected
flyctl logs -a pat-nanoclaw | grep "Signal channel connected"
```
- From a real Signal client (e.g. +15550100000), DM PAT → confirm
  `routing.message-routed kind=chat` for the signal channel in pat-nanoclaw
  logs, and that PAT replies (a `signal.send-acked` event fires).
- Use `uv run scripts/pat-trace.py --signal +<that number>` to render the
  round-trip timeline.

### Alternative: register a FRESH number instead of re-registering
Only if +15550100003 is unrecoverable (SIM lost, number reclaimed). Same flow
but `register` (no `--reregister`) on the new E164, then update everywhere the
old number is referenced: `SIGNAL_ACCOUNT` Fly secret on both pat-transports and
pat-nanoclaw, `PAT_OWNER_PHONES` if applicable, the rig/test references, and the
allowFrom lists. This loses the old chat history/identity — it's a new account.
Treat as last resort.

---

## 5. Sources

- signal-cli idle / receive requirement (man page): "the `receive` command
  should be regularly executed" — https://github.com/AsamK/signal-cli/blob/master/man/signal-cli.1.adoc
- 6 March 2026 SPQR mass-unregister; AsamK: spqr capability since v0.14.1;
  re-register steps — https://github.com/AsamK/signal-cli/issues/1993
- Prekey staleness / `No such kyber pre key record` on idle accounts —
  https://github.com/AsamK/signal-cli/issues/1699 ,
  https://github.com/AsamK/signal-cli/discussions/2036
- signal-cli CHANGELOG (0.14.0 2026-03-01 … 0.14.5 2026-06-11) —
  https://github.com/AsamK/signal-cli/blob/master/CHANGELOG.md
- Signal account inactivity deletion (> 1 year) —
  https://github.com/signalapp/Signal-Android/issues/6623 ;
  https://support.signal.org/hc/en-us/articles/9021007554074 (keep account active)
- Re-register without SMS if only deactivated; reglock PIN resets after 7 days —
  signal-cli man page + anarc.at unregister writeup
  https://anarc.at/blog/2023-06-28-using-signal-cli-to-unregister/

## 6. Internal references
- `nanoclaw/src/channels/signal.ts` — adapter (no auto-reconnect: `:1402`;
  subscribeReceive: `:1448`; send-acked/failed events: `:1044`)
- `transports/signal-cli/entrypoint.sh` — daemon launch (`--receive-mode on-start`)
- `transports/signal_staging.py:94` — `/healthz` (FastAPI-only, NOT signal-cli)
- `transports/fly.toml` — `signal` process group, `pat_signal_state` volume,
  signal machine has NO health check block
- `transports/scripts/migrate-signal-state.sh` — hash-keyed state migration
- `transports/Dockerfile` — `SIGNAL_CLI_VERSION=0.14.3`, Temurin JRE
- Memories: `reference_signal_dereg`, `reference_pat_signal_deploy`,
  `reference_signal_cli_aci_pni_quirk`, `reference_signal_staging_sidecar`,
  `reference_signal_test_rig_deploy`
