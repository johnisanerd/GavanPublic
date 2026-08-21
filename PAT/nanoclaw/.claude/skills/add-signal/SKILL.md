---
name: add-signal
description: Add Signal channel integration via signal-cli TCP daemon. Native adapter — no Chat SDK bridge.
---

# Add Signal Channel

Adds Signal messaging support via a native adapter that speaks JSON-RPC to a [signal-cli](https://github.com/AsamK/signal-cli) TCP daemon. No Chat SDK bridge — only Node.js builtins (`node:net`, `node:child_process`, `node:fs`).

Unlike Telegram or Discord, Signal has no bot API. NanoClaw registers as a full Signal account on a dedicated phone number (recommended) or links as a secondary device on your existing number.

## Prerequisites

### Java

signal-cli requires Java 17+:

```bash
java -version
```

If missing:
- **macOS:** `brew install --cask temurin@17`
- **Debian/Ubuntu:** `sudo apt-get install -y default-jre`
- **RHEL/Fedora:** `sudo dnf install -y java-17-openjdk`

Java 17–25 all work.

### signal-cli

- **macOS:** `brew install signal-cli`
- **Linux:** download the native binary from [GitHub releases](https://github.com/AsamK/signal-cli/releases):

```bash
SIGNAL_CLI_VERSION=$(curl -fsSL https://api.github.com/repos/AsamK/signal-cli/releases/latest | python3 -c "import sys,json; print(json.load(sys.stdin)['tag_name'][1:])")
curl -fsSL "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}-Linux-native.tar.gz" \
  | tar -xz -C ~/.local
ln -sf ~/.local/signal-cli ~/.local/bin/signal-cli
signal-cli --version
```

> The Linux native tarball extracts a single binary directly to `~/.local/signal-cli` (not into a subdirectory). The symlink above puts it on PATH.

## Registration

Two paths. The new-number path is recommended and battle-tested.

### Path A: Register a new number (recommended)

Use a dedicated SIM or VoIP number. NanoClaw owns it entirely.

> **VoIP numbers:** Signal requires SMS verification before voice. Some VoIP providers are blocked even for voice calls. If registration fails with an auth error, try a different provider or a physical SIM.

**Step 1: Solve the CAPTCHA**

Signal requires a CAPTCHA on first registration:

1. Open `https://signalcaptchas.org/registration/generate.html` in a browser
2. Solve the captcha
3. Right-click the **"Open Signal"** button → **Copy Link**
4. The link starts with `signalcaptcha://` — the token is everything after that prefix

**Step 2: Request SMS verification**

```bash
signal-cli -a +1YOURNUMBER register --captcha "PASTE_TOKEN_HERE"
```

**Step 3: Voice call fallback (if your number can't receive SMS)**

Wait ~60 seconds after the SMS request, then:

```bash
signal-cli -a +1YOURNUMBER register --voice --captcha "SAME_TOKEN"
```

Signal calls your number and reads a 6-digit code. The same captcha token is reusable — no need to solve a new one.

> You must request SMS first. Requesting voice immediately fails with `Invalid verification method: Before requesting voice verification…`

**Step 4: Verify**

```bash
signal-cli -a +1YOURNUMBER verify CODE
```

No output = success.

**Step 5: Set profile name (optional)**

> ⚠ Stop NanoClaw before running signal-cli commands — the daemon holds an exclusive lock on its data directory while running.

Run from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh

# macOS
launchctl unload ~/Library/LaunchAgents/$(launchd_label).plist
signal-cli -a +1YOURNUMBER updateProfile --name "YourBotName"
# optionally: --avatar /path/to/avatar.jpg
launchctl load ~/Library/LaunchAgents/$(launchd_label).plist

# Linux
systemctl --user stop $(systemd_unit)
signal-cli -a +1YOURNUMBER updateProfile --name "YourBotName"
systemctl --user start $(systemd_unit)
```

### Path B: Link as secondary device

Joins an existing Signal account as a secondary device. Simpler, but NanoClaw shares your personal number.

```bash
signal-cli -a +1YOURNUMBER link --name "NanoClaw"
```

This prints a `tsdevice:` URI. Scan it as a QR code on your phone: **Settings → Linked Devices → Link New Device**. QR codes expire in ~30 seconds — re-run if it expires.

## Install

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/signal.ts` exists
- `src/channels/signal.test.ts` exists
- `src/channels/signal-registration.test.ts` exists
- `src/channels/index.ts` contains `import './signal.js';`

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter and tests

```bash
git show origin/channels:src/channels/signal.ts                   > src/channels/signal.ts
git show origin/channels:src/channels/signal.test.ts             > src/channels/signal.test.ts
git show origin/channels:src/channels/signal-registration.test.ts > src/channels/signal-registration.test.ts
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
import './signal.js';
```

### 4. Build and validate

```bash
pnpm run build
pnpm exec vitest run src/channels/signal-registration.test.ts
```

Both must be clean before proceeding. `signal-registration.test.ts` is the one integration test: it imports the real channel barrel and asserts the registry contains `signal`. It goes red if the `import './signal.js';` line is deleted or drifts, or if the barrel fails to evaluate (so the channel genuinely would not register). The adapter consumes only Node.js builtins, so there is no npm dependency to guard for this channel. The adapter's typed core-API consumption is guarded by `pnpm run build`.

## Credentials

Add to `.env`:

```bash
SIGNAL_ACCOUNT=+1YOURNUMBER
```

### Optional settings

```bash
# TCP daemon host and port (default: 127.0.0.1:7583)
SIGNAL_TCP_HOST=127.0.0.1
SIGNAL_TCP_PORT=7583

# Path to the signal-cli binary (default: resolved on PATH)
SIGNAL_CLI_PATH=/usr/local/bin/signal-cli

# Whether NanoClaw manages the daemon lifecycle (default: true).
# Set to false if you run signal-cli daemon externally.
SIGNAL_MANAGE_DAEMON=true

# signal-cli data directory (default: ~/.local/share/signal-cli)
SIGNAL_DATA_DIR=~/.local/share/signal-cli
```

**Security note:** keep the TCP host on `127.0.0.1`. The daemon has no auth — binding it to a public interface would expose your full Signal account to the network.

Sync to container: `mkdir -p data/env && cp .env data/env/env`

### Restart

Run from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)

# Linux
systemctl --user restart $(systemd_unit)
```

## Wiring

### DMs

After the service starts, send any message to the Signal number from your personal Signal app. The router auto-creates a `messaging_groups` row. Then:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT id, platform_id FROM messaging_groups WHERE channel_type='signal' ORDER BY created_at DESC LIMIT 5"
```

Pass the `id` to `/init-first-agent` or `/manage-channels` to wire it to an agent group.

### Groups

Add the Signal number to a group from your phone, send any message, then wire the resulting row the same way. For isolated per-group sessions:

```bash
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
pnpm exec tsx scripts/q.ts data/v2.db "
INSERT OR IGNORE INTO messaging_group_agents
  (id, messaging_group_id, agent_group_id, session_mode, priority, created_at)
VALUES
  ('mga-'||hex(randomblob(8)), 'mg-GROUPID', 'ag-AGENTID', 'isolated', 0, '$NOW');
"
```

### Grant user access

New Signal users (including the owner's Signal identity) are silently dropped with `not_member` until granted access. After the user's first message appears in `messaging_groups`:

```bash
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
pnpm exec tsx scripts/q.ts data/v2.db "
INSERT OR REPLACE INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
  VALUES ('signal:UUID', 'owner', NULL, 'system', '$NOW');
INSERT OR IGNORE INTO agent_group_members (user_id, agent_group_id, added_by, added_at)
  VALUES ('signal:UUID', 'ag-AGENTID', 'system', '$NOW');
"
```

Find the UUID from `messaging_groups.platform_id` or the `users` table.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/init-first-agent` to create an agent and wire it to your Signal DM, or `/manage-channels` to wire this channel to an existing agent group.

## Channel Info

- **type**: `signal`
- **terminology**: Signal has "chats" (1:1 DMs) and "groups"
- **supports-threads**: no
- **platform-id-format**:
  - DM: `signal:{UUID}` — sender's Signal UUID (ACI), **not** their phone number
  - Group: `signal:{base64GroupId}` — base64-encoded GroupV2 ID
- **how-to-find-id**: Send a message to the bot, then query `messaging_groups` as shown above
- **typical-use**: Personal assistant via Signal DMs or small group chats
- **default-isolation**: One agent per Signal account. Multiple chats with the same operator can share an agent group; groups with other people should typically use `isolated` session mode

### Features

- Markdown formatting — `**bold**`, `*italic*` / `_italic_`, `` `code` ``, ` ```code fence``` `, `~~strike~~`, `||spoiler||` (converted to Signal's offset-based text styles)
- Quoted replies — `replyTo*` fields populated from Signal quotes
- Typing indicators — DMs only (Signal doesn't support group typing)
- Echo suppression — outbound messages matched on `(platformId, text)` within a 10 s TTL to avoid syncMessage loops
- Note to Self — messages you send to your own account from another device route to the agent as inbound with `isFromMe: true`
- Voice attachments — detected but not transcribed by default; the agent receives `[Voice Message]` placeholder text. Run `/add-voice-transcription` for local transcription via parakeet-mlx

Not supported yet: outbound file attachments (logged and dropped), edit/delete messages, reactions.

## Troubleshooting

### Daemon not reachable

```bash
grep "Signal" logs/nanoclaw.log | tail
```

If you see `Signal daemon failed to start. Is signal-cli installed and your account linked?`:
- Confirm `signal-cli` is on PATH (or set `SIGNAL_CLI_PATH`)
- Confirm the account is linked: `signal-cli -a +1YOURNUMBER listIdentities` should succeed without prompting

If you see `Signal daemon not reachable at 127.0.0.1:7583` and `SIGNAL_MANAGE_DAEMON=false`, start the daemon yourself: `signal-cli -a +1YOURNUMBER daemon --tcp 127.0.0.1:7583`.

### Bot not responding

1. Channel initialized: `grep "Signal channel connected" logs/nanoclaw.log | tail -1`
2. Channel wired: `pnpm exec tsx scripts/q.ts data/v2.db "SELECT mg.platform_id, mg.name FROM messaging_groups mg JOIN messaging_group_agents mga ON mg.id = mga.messaging_group_id WHERE mg.channel_type='signal'"`
3. Service running: `launchctl print gui/$(id -u)/"$(. setup/lib/install-slug.sh && launchd_label)"` (macOS) / `systemctl --user status "$(. setup/lib/install-slug.sh && systemd_unit)"` (Linux)
4. **Check for duplicate service instances** — if `logs/nanoclaw.error.log` shows `No adapter for channel type channelType="signal"` despite the adapter starting, two NanoClaw processes are racing. See the `/debug` skill section "No adapter for channel type / Messages silently lost" for the full fix.

### Messages delivered but never arrive (null platformMsgId)

Signal responses show `platformMsgId=undefined` in the main log. This means the delivery poll ran but found no adapter — likely a duplicate service instance issue (see above). Affected messages cannot be retried; the user must resend.

### Lost connection mid-session

If you see `Signal channel lost TCP connection to signal-cli daemon` in the logs, the daemon dropped the connection. Restart the service to re-establish.

### Messages dropped with `not_member`

The Signal user hasn't been granted membership. See "Grant user access" above. This affects every new Signal user, including the owner's Signal identity — which is a separate user record from their identity on other channels even if it's the same person.

### Captcha required

Signal requires a captcha for new registrations. Go to `https://signalcaptchas.org/registration/generate.html`, solve it, right-click "Open Signal", copy the link, extract the token after `signalcaptcha://`.

### `Invalid verification method: Before requesting voice verification…`

You must request SMS first, wait ~60 seconds, then request voice. Both steps can use the same captcha token.

### Config file in use / daemon lock

signal-cli holds an exclusive lock on its data directory while the daemon is running. Stop NanoClaw before running any `signal-cli` commands directly, then restart afterward.

### Group replies going to DM instead of group

Modern Signal groups use GroupV2. The adapter must extract the group ID from `envelope?.dataMessage?.groupV2?.id` — not `groupInfo?.groupId`, which is GroupV1/legacy. If group messages are routing as DMs, check `src/channels/signal.ts` and confirm the groupId extraction falls through to `groupV2.id`.

### Java not found

Install Java 17+ — see the Prerequisites section above.

### QR code expired (Path B)

QR codes expire in ~30 seconds. Re-run the link command to generate a new one.

---

## PAT-specific install (Wave 2.A)

> The rest of this skill targets a single-host install (nanoclaw and
> signal-cli on the same machine). **PAT** runs them split across two
> Fly apps. This section is the override for that topology.

### Topology

```
pat-nanoclaw (Fly app)              pat-transports (Fly app)
  nanoclaw host                       signal process group
  ├─ signal.ts adapter   ─────────►   ├─ signal-cli daemon
  │  SIGNAL_MANAGE_DAEMON=false       │  bound fly-local-6pn:7583
  │  SIGNAL_TCP_HOST=                 │  data on pat_signal_state volume
  │    pat-transports.internal        │  → /root/.local/share/signal-cli
  │  SIGNAL_TCP_PORT=7583             │
  └─ register-on-import via            └─ entrypoint:
     src/channels/signal.ts              voice-transport/signal-cli/entrypoint.sh
```

Identity `+15550100003` is a **primary** signal-cli device (re-registered
2026-05-11 on a fresh local install — see memory
`reference_signal_dereg.md`). No QR-link / linked-secondary flow needed.

### One-time setup

```bash
# 1. Create the volume (sjc region matches pat-nanoclaw)
flyctl volumes create pat_signal_state -a pat-transports -r sjc -s 1

# 2. Deploy the new process group + polyglot Dockerfile
cd ~/Projects/AgenticToolkit/agentic_toolkit
FLY_API_TOKEN="$(grep ^FLY_API_TOKEN= .env.agent | cut -d= -f2-)" \
  flyctl deploy --remote-only -c voice-transport/fly.toml

# 3. Seed the volume from the local Mac (one-shot — see script)
scripts/migrate-signal-state.sh +15550100003

# 4. Set the adapter env on pat-nanoclaw. Use signal.process.<app>.internal
#    (NOT bare <app>.internal — that round-robins to the cartesia process
#    group without port 7583 open).
flyctl secrets set -a pat-nanoclaw \
  SIGNAL_ACCOUNT=+15550100003 \
  SIGNAL_TCP_HOST=signal.process.pat-transports.internal \
  SIGNAL_TCP_PORT=7583 \
  SIGNAL_MANAGE_DAEMON=false
```

### Wiring

After step 4, nanoclaw's signal adapter self-registers on next deploy /
restart. From the `pat-nanoclaw` log:

```
Signal channel connected account=+15550100003 host=signal.process.pat-transports.internal port=7583
```

Send any DM to `+15550100003` from another Signal account → router
auto-creates the `messaging_groups` row. Wire it through `/init-first-agent`
or `/manage-channels` as per the single-host instructions above. Owner
phone `+15550100000` should resolve to `role=owner` via `PAT_OWNER_PHONES`
auto-elevation.

### Deviations from upstream signal.ts

Marked with `// PAT:` in `nanoclaw/src/channels/signal.ts`:

1. **Cross-process attachment fetch via `getAttachment` JSON-RPC**. The
   stock adapter dereferences signal-cli's `attachments/` dir directly,
   which doesn't work in PAT's split deployment (daemon on
   `pat-transports`, adapter on `pat-nanoclaw`). The adapter now
   fetches bytes via `tcp.rpc('getAttachment', { id, recipient | groupId,
   account })` on the same socket it's already using for `send` —
   signal-cli returns base64, the adapter decodes to a tempfile and
   feeds the existing transcription / Read-tool pipeline. Uses a 60s
   timeout (vs the 15s default) since base64-encoding a large image
   over the JSON-RPC pipe can take longer than the snappier send/typing
   calls. Any failure (RPC error, no `data` field, timeout) falls back
   to the `[Voice Message]` / `[Image]` placeholder. The legacy
   filesystem-direct path is preserved behind
   `SIGNAL_ATTACHMENTS_LOCAL=true` for dev laptops.
2. **openDM is deliberately omitted** — Signal is a direct-addressable
   channel; recipient phone or UUID IS the DM chat id. `user-dm.ts`
   detects the absence of openDM and falls through to using the handle
   directly as `messaging_groups.platform_id`.
3. **Default TCP host comment** updated to flag that PAT overrides
   `SIGNAL_TCP_HOST` to `signal.process.pat-transports.internal`.
4. **JAR + Temurin JRE 25, not native binary.** Initial deploy tried
   the GraalVM-compiled `-Linux-native` tarball (~80MB single binary,
   no JRE) but it segfaulted on `python:3.13-slim` (GraalVM native-image
   is sensitive to glibc / kernel features and our base isn't a tested
   target). Settled on the JAR-based tarball
   (`signal-cli-${VERSION}.tar.gz`) extracted under
   `/opt/signal-cli-${VERSION}/` with **Temurin JRE 25** installed via
   Adoptium's apt repo. JRE 25 is required, not optional —
   signal-cli 0.14.3's JARs compile for class file 69 (= Java 25); JRE
   21 fails with `UnsupportedClassVersionError`. ~200MB image delta.
   Dockerfile has a `RUN signal-cli --version` smoketest in the runtime
   stage so this class of failure surfaces at build time, not boot.

### Operations

**Inspect signal-cli daemon directly:**

```bash
flyctl ssh console -a pat-transports --process signal -C "signal-cli -a +15550100003 listIdentities" | head
```

**Tail the daemon's stderr (RPC errors, group sync, etc.):**

```bash
flyctl logs -a pat-transports --process signal
```

**Restart only the signal machine (without restarting cartesia):**

```bash
SIGNAL_MID=$(flyctl machines list -a pat-transports --json \
  | jq -r '.[] | select(.config.metadata.fly_process_group=="signal") | .id' | head -1)
flyctl machine restart "$SIGNAL_MID" -a pat-transports
```

**End-to-end smoketest (post-deploy):**

```bash
# (a) daemon is up
flyctl logs -a pat-transports --process signal | grep -E "Listening|daemon started"

# (b) adapter connected
flyctl logs -a pat-nanoclaw | grep "Signal channel connected"

# (c) inbound from owner's Signal lands
# Send a DM from +15550100000, then:
TOKEN="$(grep ^PAT_ADMIN_TOKEN= .env.agent | cut -d= -f2-)"
flyctl proxy -a pat-nanoclaw 8765:8765 &
curl -sH "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:8765/admin/logs.jsonl" \
  | jq -c 'select(.kind=="routing.message-routed" and .data.channelType=="signal")'

# (d) round-trip — owner sees back-mind reply in their Signal app

# (e) restart-survival
flyctl machine restart "$SIGNAL_MID" -a pat-transports
# Send another DM, confirm no re-registration prompt + adapter reconnects
```

### Volume-restore in case the state gets corrupted

```bash
# 1. Stop the signal machine
SIGNAL_MID=...; flyctl machine stop "$SIGNAL_MID" -a pat-transports

# 2. Re-run migrate-signal-state.sh from a known-good local Mac install
scripts/migrate-signal-state.sh +15550100003

# 3. Volume now contains the seed state; restart the machine
flyctl machine start "$SIGNAL_MID" -a pat-transports
```

If the local Mac state is *also* lost: re-register fresh (see
"Registration → Path A" above), which gives you a new primary device on
the same number. Old conversations don't survive — Signal's E2EE
guarantees that.
