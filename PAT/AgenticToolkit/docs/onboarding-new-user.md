# Onboarding a new user to PAT (Telegram / Signal / Slack)

This guide is for an **operator** — someone running PAT who needs to let a new
human talk to it. You do **not** need to understand nanoclaw internals to
follow it. Two distinct jobs are covered, kept separate:

1. **One-time channel setup** — wiring a brand-new bot/account/app so that
   *any* message on that channel routes into PAT. You do this once per channel.
2. **Per-new-user enrollment** — what happens the first time a specific new
   human messages PAT on an **already-wired** channel: how PAT notices an
   unknown sender, how the approval/enrollment card works, and what you do to
   let them in. **This is the common case** and the heart of the guide.

PAT runs as one nanoclaw "agent group" (`palisade-internal`, display name
"Pat") that every channel routes into — there is no per-user agent. The admin
CLI you run is `ncl` (host: Unix socket; the same verbs work from inside a
container, auto-scoped). Run `ncl help` or `ncl <resource> help` anytime.

> Environments: PAT has **prod** (`pat-nanoclaw`) and **staging**
> (`pat-nanoclaw-staging`). Everything below applies to both — pick the right
> Fly app name. The dashboard's Database browser (`/admin/db`) is the easiest
> read-only way to inspect the tables this guide mentions.
>
> **Which channels are actually live differs by env** (a channel adapter only
> registers if its secret is present — `registerChannelAdapter().init()` returns
> `null` otherwise). Verified against the live Fly secret sets:
>
> | Channel | Gating secret | prod (`pat-nanoclaw`) | staging (`pat-nanoclaw-staging`) |
> |---|---|---|---|
> | Telegram | `TELEGRAM_BOT_TOKEN` | ❌ not set | ✅ live |
> | Signal | `SIGNAL_ACCOUNT` (+ `SIGNAL_TCP_HOST/PORT`) | ✅ live | ❌ not set |
> | Slack | `SLACK_BOT_TOKEN` (+ `SLACK_SIGNING_SECRET`) | ✅ live | ❌ not set |
> | phone-call / anam-web | always on (no gating secret) | ✅ | ✅ |
>
> So as of this writing **prod runs Signal + Slack** (no Telegram) and
> **staging runs Telegram only** (no Signal/Slack). The barrel
> (`src/channels/index.ts`) imports all of cli/phone-call/anam-web/signal/slack/
> telegram, so the *code* for every channel ships to both apps — only the
> secrets decide what connects. Re-check with `flyctl secrets list -a <app>`
> (names only) before assuming a channel is up in a given env.

---

## Part 0 — How recognition + approval works (the shared model)

Every inbound message, regardless of channel, runs through the router
(`nanoclaw/src/router.ts`). The decision tree is the same for all channels:

1. **Is the channel/chat wired to an agent?** A `messaging_groups` row
   (one chat on one platform, keyed by `channel_type` + `platform_id`) must be
   linked to the agent group via a `messaging_group_agents` "wiring" row.
   - **Not wired** + the bot was addressed (DM or @mention) → the router fires
     the **channel-registration** flow: it DMs an admin a card asking
     *"connect this channel to which agent?"* (`channel-approval.ts`). On
     approve it creates the wiring and replays the message.
   - **Not wired** + plain chatter (no mention) → silently ignored, no card.
   - If an admin previously hit **Reject**, the messaging group's `denied_at`
     is set and the router drops everything from it silently until you re-wire.

2. **Is the *sender* allowed?** Once a channel is wired, each message is checked
   against the messaging group's `unknown_sender_policy`
   (`nanoclaw/src/router.ts`, gates in `nanoclaw/src/modules/permissions/`):
   - `strict` — unknown senders are dropped silently (recorded in
     `dropped_messages`). Nothing reaches PAT, no card.
   - `request_approval` — an unknown sender triggers the **sender-approval**
     flow: an admin gets a *"New sender — Allow?"* card (`sender-approval.ts`).
     On **Allow**, the sender is added to `agent_group_members` and their
     original message is replayed so PAT answers it. This is the enrollment
     path.
   - `public` — anyone may talk to PAT, no card, no enrollment needed.

   "Known" = the sender has a row in `user_roles` (owner/admin) **or**
   `agent_group_members` for this agent group. Owners and admins are always
   allowed and are implicitly members.

3. **Who can approve?** Cards are delivered to an eligible approver
   (`pickApprover` in `nanoclaw/src/modules/approvals/primitive.ts`): scoped
   admins for the group → global admins → owners, preferring an approver
   reachable on the **same channel** as the request. The approver must have a
   reachable DM (a `user_dms` row, or a channel that supports cold-DM). If
   **no owner/admin exists yet, or none is reachable, the card is silently
   dropped** and the message stays blocked — so a fresh install with no owner
   can't enroll anyone. Establish an owner first (see each channel's setup).

**Two important PAT-specific shortcuts:**

- **`PAT_ADMINS_BYPASS_APPROVAL=1`** (Fly secret) — when set, owners/admins
  skip the sender-approval and channel-approval cards entirely
  (`command-gate.ts`). It does **not** let *unknown* users in; it only stops
  PAT from carding *you* (the admin) during demos. Check whether it's set
  before assuming the card flow is broken for an admin.
  - **Live status: NOT set on either env** (`flyctl secrets list`, checked
    against both `pat-nanoclaw` and `pat-nanoclaw-staging`). So admins *do*
    currently get carded like anyone else — if you expected the bypass and
    aren't seeing it, that's why; set it explicitly if you want it.
- **`PAT_OWNER_PHONES="+E164,..."`** (Fly secret) — any phone caller whose
  number is listed is auto-granted the global `owner` role on their first
  inbound. Bootstrap-only; the role then persists in `user_roles`. This is how
  the first owner is usually established. (Phone/voice only — see
  `reference_pat_owner_phones.md`.)
  - **Live status: set on prod** (`pat-nanoclaw`), **not set on staging**
    (`pat-nanoclaw-staging`). Prod's owner bootstrap is via this phone path;
    on staging, ownership must be established another way (e.g. Telegram
    pairing auto-owner, or a manual `ncl roles grant`).
  - Related approval secret seen on prod: **`PAT_ADMIN_TOKEN`** (the dashboard
    /HTTP admin token, present on both envs) — not part of the card flow, but
    it's the token the dashboard uses for write actions. No other
    approval-related secrets are set on either env.

**The operator's levers, in `ncl` terms:**

| Goal | Command |
|---|---|
| Let everyone on a chat in (no per-user cards) | `ncl messaging-groups update <mg-id> --unknown_sender_policy public` |
| Card me when a stranger writes | `... --unknown_sender_policy request_approval` |
| Drop strangers silently | `... --unknown_sender_policy strict` |
| Manually enroll a known user | `ncl members add --user <channel:handle> --group <ag-id>` |
| Make someone an admin/owner | `ncl roles grant --user <channel:handle> --role admin` (or `owner`) |
| Wire a chat to PAT by hand | `ncl wirings create --messaging_group_id <mg> --agent_group_id <ag> ...` |
| See pending approval cards | `ncl approvals list` |
| See messages that got dropped | `ncl dropped-messages list` |

> `ncl roles grant`, `ncl members add`, `ncl wirings create`,
> `ncl messaging-groups update` are themselves **approval-gated** when run from
> a context that isn't already an admin. From the host socket as the operator
> they execute directly. If a command returns "pending approval," approve it
> from your admin DM.

PAT's single agent group id:
- **prod**: `ag-<redacted>`
- **staging**: `ag-<redacted>`

Get it live with `ncl groups list` (folder `palisade-internal`). Substitute it
for `<ag-id>` throughout.

---

## Part 1 — Telegram

Telegram is the cleanest of the three: cloud Bot API, polling, no sidecar.
PAT supports bidirectional voice memos here (Scribe STT in, Cartesia voice
out) — verified on staging.

> **Live status: Telegram is wired on *staging* only** (`TELEGRAM_BOT_TOKEN`
> is set on `pat-nanoclaw-staging`, not on prod). The one wired Telegram chat
> on staging is `telegram:<telegram-id>` (a DM), `unknown_sender_policy =
> request_approval` — so a *new* sender there gets a "New sender — Allow?"
> card, not silent drop and not open access. To bring Telegram up on prod, set
> `TELEGRAM_BOT_TOKEN -a pat-nanoclaw` and follow Part 1.A.

### A. One-time channel setup (only if Telegram isn't wired yet)

**Prerequisites:** the `telegram` adapter is installed
(`nanoclaw/src/channels/telegram.ts` exists, imported in
`src/channels/index.ts`) and `@chat-adapter/telegram` is a dependency. If not,
the channel is installed via the `/add-telegram` skill in nanoclaw.

1. **Create the bot.** In Telegram, message `@BotFather` → `/newbot` → pick a
   name and a username ending in `bot`. Copy the token
   (`123456:ABC-DEF...`).
   - For group chats, also turn **off** Group Privacy
     (`@BotFather` → `/mybots` → your bot → Bot Settings → Group Privacy →
     Turn off) or the bot only sees @mentions.

2. **Set the token** as a Fly secret on the nanoclaw app:
   ```bash
   flyctl secrets set -a pat-nanoclaw TELEGRAM_BOT_TOKEN='123456:ABC-DEF...'
   ```
   (staging: `-a pat-nanoclaw-staging`.) The machine restarts and the adapter
   self-registers — look for an "adapter connected" line in the logs.

3. **Register the operator's own chat + establish ownership.** Telegram uses a
   interceptor records the chat and, **if no owner exists yet, promotes the
   paired user to owner** — this is how you bootstrap. Either:
   - Run `/init-first-agent` and choose the Telegram pair-code path, **or**
   - From nanoclaw, issue a code directly:
     ```bash
     pnpm exec tsx setup/index.ts --step pair-telegram -- --intent main
     ```
     Take the 4-digit `CODE` from the `PAIR_TELEGRAM_ISSUED` block, send just
     those 4 digits (in a group with privacy on, `@<botname> CODE`) from the
     chat you want to register. Success emits `PLATFORM_ID` + `ADMIN_USER_ID`.

After this, Telegram is wired and you have an owner. Skip to Part 1.B for new
users.

### B. Per-new-user enrollment (the common case)

A new person messages PAT's Telegram bot (DM or @mention in a wired group).

**What the new user does:** just send a message to the bot.

**What happens automatically:**
- If the chat isn't a wired `messaging_groups` row yet, the **channel-
  registration** card goes to an admin's DM ("connect this channel to which
  agent?"). Approve → **Connect to Pat**.
- If the chat is wired but the sender is unknown and policy is
  `request_approval`, the **sender-approval** card goes to an admin ("New
  sender — Allow?"). On **Allow**, the sender becomes a member and their
  message is replayed so PAT answers.

**What you (the operator) do:** click **Allow** / **Connect to Pat** on the
card that arrives in your Telegram DM. That's it — nothing on the CLI is
required for the happy path.

**If you want zero cards** (e.g. a shared group where everyone should reach
PAT), set the chat to public once:
```bash
ncl messaging-groups list                 # find the Telegram chat's mg-id
ncl messaging-groups update <mg-id> --unknown_sender_policy public
```

**Manual enrollment** (no card; you know the user already): the Telegram user
id is the numeric user id; the namespaced handle is `telegram:<userId>`.
```bash
ncl members add --user telegram:<telegram-id> --group <ag-id>
```

### Verify it worked

- Dashboard `/admin/db`: the user appears in `agent_group_members` (or
  `user_roles`), and the chat in `messaging_groups` + `messaging_group_agents`.
- Or: `ncl members list --group <ag-id>` shows the new handle.
- The new user should get a reply. If not, check `ncl dropped-messages list`
  for a `not_member` / `no_agent_wired` reason.

### Telegram gotchas

- **Group Privacy on** = bot only sees @mentions in groups. Turn it off (above)
  for `engage_mode=pattern`/always-on behavior.
- Telegram is **not threaded** (`supportsThreads: false`) — sessions collapse
  to the chat.

---

## Part 2 — Signal

Signal has **no bot API**. PAT registers a real Signal account on a dedicated
number via `signal-cli`, and in PAT's deployment the daemon runs on a
**separate Fly app** (`pat-transports`, process group `signal`) that nanoclaw
talks to over the private network. This split is the source of most Signal
gotchas. PAT's number is **`+15550100003`** (profile "PAT").

> **Live status: Signal is wired on *prod* only** (`SIGNAL_ACCOUNT`,
> `SIGNAL_TCP_HOST`, `SIGNAL_TCP_PORT`, `SIGNAL_MANAGE_DAEMON` are all set on
> `pat-nanoclaw`; none set on staging). The actual Signal messaging-group
> policies on prod are **mixed, not uniformly `public`**:
>
> | Signal mg (`platform_id`) | `unknown_sender_policy` |
> |---|---|
> | `+15550100000` (the seed mg, `mg-1778633395-signal`) | `strict` |
> | `+15550100001` | `request_approval` |
> | `+15550100002` | `request_approval` |
>
> Because new Signal chats copy the **seed** mg's policy
> (`ensureSignalMessagingGroup`), and the seed here is `strict`, **a brand-new
> Signal sender on prod is dropped silently** (`not_member`) until you enroll
> them or flip the chat to `public`/`request_approval`. (The code's *fallback*
> default when no seed value exists is `public` — see `signal.ts:392` — but the
> live seed has an explicit `strict`, which wins.)

### A. One-time channel setup (only if Signal isn't wired yet)

This is the heaviest setup. If `+15550100003` is already registered and the
daemon is running, skip to Part 2.B.

**Account registration** (`/add-signal` skill, Path A — new number):
1. Solve the captcha at `https://signalcaptchas.org/registration/generate.html`,
   copy the `signalcaptcha://...` token.
2. `signal-cli -a +15550100003 register --captcha "<token>"` → SMS code.
   (Voice fallback: wait ~60s, `register --voice --captcha "<same-token>"`.)
3. `signal-cli -a +15550100003 verify <6-digit-code>`.
4. `signal-cli -a +15550100003 updateProfile --name "PAT"`.
   - Stop nanoclaw first — signal-cli holds an exclusive lock on its data dir.

**PAT split-topology deployment** (this is what prod actually runs — see the
"PAT-specific install" section of `/add-signal` and
`reference_signal_staging_sidecar.md`):
- signal-cli daemon runs on `pat-transports`, bound to `0.0.0.0:7583` (the
  staging/voice-memo sidecar binds `[::]:7584`).
- nanoclaw connects across the private network with these secrets on
  `pat-nanoclaw`:
  ```bash
  flyctl secrets set -a pat-nanoclaw \
    SIGNAL_ACCOUNT=+15550100003 \
    SIGNAL_TCP_HOST=signal.process.pat-transports.internal \
    SIGNAL_TCP_PORT=7583 \
    SIGNAL_MANAGE_DAEMON=false
  ```
  Use **`signal.process.pat-transports.internal`** (process-scoped DNS) — bare
  `pat-transports.internal` round-robins to the wrong process group.
- Inbound voice transcription needs **`ELEVENLABS_API_KEY`** set on the
  nanoclaw app (the host isn't credential-proxied). Without it, voice memos
  degrade to a `[Voice Message]` placeholder.

**Confirm connection** — look for this in `pat-nanoclaw` logs:
```
Signal channel connected account=+15550100003 host=signal.process.pat-transports.internal port=7583
```

**Establish ownership.** Unlike Telegram, Signal has no pairing/auto-owner
flow. Either set `PAT_OWNER_PHONES` (phone-caller path), or grant the owner's
Signal identity a role by hand (see manual enrollment below). The operator's
Signal identity is a **separate user record** from their phone/Slack identity
even though it's the same human.

### B. Per-new-user enrollment (the common case)

When a new person DMs PAT's Signal number (or PAT is added to a group and
someone posts), the adapter **lazily auto-provisions** a `messaging_groups`
row + wiring by copying from an existing Signal seed mg
(`ensureSignalMessagingGroup` in `nanoclaw/src/channels/signal.ts`). So once
one Signal chat is wired, new Signal chats get wired automatically — you do
**not** get a channel-registration card for each new Signal sender.

What you still control is the **sender** gate via `unknown_sender_policy`,
which the seed copies onto the new mg:
- If the seed mg is `public` → new senders are answered immediately, no card,
  no manual step. (Note: PAT's **live prod Signal seed is `strict`**, not
  `public` — see the live-status table above — so on prod today new Signal
  senders are dropped until enrolled. Don't assume `public`; check the seed.)
- If `request_approval` → you get a "New sender — Allow?" card.
- If `strict` → new senders are dropped silently with `not_member` (this is the
  upstream default and the most common "why isn't my Signal message getting
  through" cause).

**Manual enrollment** (the reliable path; `/add-signal` documents it). The
Signal handle is `signal:<UUID>` — the sender's **ACI UUID**, *not* their phone
number. Find it from `messaging_groups.platform_id` (DMs use the UUID as the
platform id) or the `users` table after their first message:
```bash
ncl users list                            # find signal:<UUID> for the new sender
ncl members add --user signal:<UUID> --group <ag-id>
# or, to make them owner/admin:
ncl roles grant --user signal:<UUID> --role owner
```

**What the new user does:** message PAT's Signal number once. (They'll get a
read receipt; if dropped, nothing.)

**What you do:** click **Allow** on the card if policy is `request_approval`;
otherwise run the `ncl members add` above, or pre-set the chat to `public`.

### Verify it worked

```bash
ncl messaging-groups list                 # the signal chat exists + is wired
ncl members list --group <ag-id>          # the signal:<UUID> is a member
```
Plus a round-trip reply in the user's Signal app. If silent, check
`ncl dropped-messages list` and the daemon logs:
`flyctl logs -a pat-transports --process signal`.

### Signal gotchas (these bite)

- **ACI/PNI cached-key silent drop** (`reference_signal_cli_aci_pni_quirk.md`).
  If the sender's cached key for PAT is a stale **PNI** fingerprint that
  doesn't match PAT's live **ACI** key, the message body silently fails to
  decrypt — delivery receipts still flow, but no body ever surfaces and no
  error is logged. This mainly hits **signal-cli-to-signal-cli** senders (e.g.
  the test rigs) and recipients in username/phone-privacy mode. Real Signal
  apps talking to PAT are unaffected. **Fix:** address by ACI UUID, not E164;
  the test rig's `GET /address?phone=+E164` resolves the UUID.
- **Address by UUID, enroll by UUID.** The handle is always `signal:<UUID>`.
  Don't use the phone number as the handle.
- **`strict` is the default** for upstream auto-created mgs — new Signal users
  get dropped with `not_member` until you enroll them or set `public`.
- **Voice memos need AAC/m4a + the staging sidecar** for the native bubble
  (`reference_signal_voice_memo_format.md`) — handled in code, but if the
  sidecar (`pat-transports:7584`) is down, voice falls back to a plain
  attachment. Sidecar must bind `[::]` (IPv6) and the VM needs ≥512MB.
- **Stop nanoclaw before running any `signal-cli` command directly** — the
  daemon holds an exclusive data-dir lock.

---

## Part 3 — Slack

Slack uses the Chat SDK bridge over a webhook (no Socket Mode in the bundle),
and is the only one of the three with real thread support. PAT's Slack app is
"PAT" in the <slack-workspace> workspace (bot user `slack:<slack-user>`); details in
`reference_slack_staging_bot.md`.

> **Live status: Slack is wired on *prod* only** (`SLACK_BOT_TOKEN` +
> `SLACK_SIGNING_SECRET` set on `pat-nanoclaw`; neither set on staging). The
> live Slack messaging-group policies on prod:
>
> | Slack mg (`platform_id`) | kind | `unknown_sender_policy` |
> |---|---|---|
> | `slack:<slack-channel>` | channel | `public` |
> | `slack:<slack-dm>` | DM | `request_approval` |
> | `slack:<slack-dm>` | DM | `request_approval` |
>
> So on prod the shared Slack **channel** is open to anyone (no per-user
> cards), while DMs from a new person trigger a "New sender — Allow?" card.

### A. One-time channel setup (only if Slack isn't wired yet)

**Prerequisites:** the `slack` adapter is installed
(`nanoclaw/src/channels/slack.ts`, imported in `src/channels/index.ts`) and
`@chat-adapter/slack` is a dependency (installed via `/add-slack`). PAT ships a
one-line pnpm patch to the adapter that fixes thread synthesis — keep
`COPY nanoclaw/patches` in the Dockerfile before `pnpm install`.

1. **Create the Slack app** (or reuse PAT's). You need a Bot Token (`xoxb-...`)
   and the Signing Secret. `SLACK_APP_TOKEN` (xapp) is **ignored** by v2 —
   webhook-only.

   **Exact bot token scopes** (from the `add-slack` skill — *OAuth &
   Permissions → Bot Token Scopes*):
   `chat:write`, `im:write`, `channels:history`, `groups:history`,
   `im:history`, `channels:read`, `groups:read`, `users:read`,
   `reactions:write`, `files:read`, `files:write`.

   **Event subscriptions** (*Event Subscriptions → Subscribe to bot events*):
   `message.channels`, `message.groups`, `message.im`, `app_mention`.

   **Also required:** enable the **Messages Tab** under *App Home* (and check
   "Allow users to send … messages from the messages tab") so DMs work, and
   toggle **Interactivity** on (same request URL as events) so approval-card
   buttons post back. After adding interactivity Slack will prompt you to
   **reinstall** the app to apply the new settings.

2. **Set the secrets** on nanoclaw:
   ```bash
   flyctl secrets set -a pat-nanoclaw \
     SLACK_BOT_TOKEN='xoxb-...' \
     SLACK_SIGNING_SECRET='...'
   ```

3. **Point Slack at the webhook.** In the Slack app config, set **Event
   Subscriptions** and **Interactivity & Shortcuts** request URLs to:
   ```
   https://pat-nanoclaw.fly.dev/webhook/slack
   ```
   (staging: the staging app's URL.) HMAC-verified by the signing secret. The
   shared bridge serves all chat-sdk channels on one HTTP server at
   `/webhook/<name>`.

4. **Add the bot to a channel / DM it, and establish ownership.** Invite the
   bot to a channel or open a DM, then post. Slack supports **cold DM**, so an
   admin doesn't have to have DMed first for cards to reach them — but you
   still need at least one owner/admin row to approve anything. Grant your
   Slack identity:
   ```bash
   ncl roles grant --user slack:<slack-user> --role admin   # your Slack user id
   ```
   (Find your Slack user id: profile → More → Copy member ID, `U...`.)

### B. Per-new-user enrollment (the common case)

A new person posts where PAT can see them — a DM, or an @mention in a channel
PAT is in.

**What happens automatically:**
- New channel/DM not yet wired + bot addressed → **channel-registration** card
  to an admin ("connect this channel to which agent?"). Approve →
  **Connect to Pat**.
- Wired channel, unknown sender, `request_approval` → **sender-approval** card
  ("New sender — Allow?"). On **Allow**, the sender is enrolled and their
  message replayed.

**What the new user does:** @mention PAT in a shared channel, or DM the bot.

**What you do:** click the approval button in your Slack DM. The card is
delivered to a deliverable Slack admin (a phone-only admin can't receive Slack
cards — `pickApprover` skips to the next reachable one).

**For a shared channel everyone should reach** (PAT's `#pat-test` pattern):
set the channel mg to `public` with always-on engagement so any post triggers
PAT:
```bash
ncl messaging-groups list                  # find the slack channel mg-id (slack:C...)
ncl messaging-groups update <mg-id> --unknown_sender_policy public
ncl wirings list                           # find the wiring id for that mg
ncl wirings update <wiring-id> --engage_mode pattern --engage_pattern '.'
```

**Manual enrollment:** the handle is `slack:<Uxxxx>` (user id, not display
name):
```bash
ncl members add --user slack:<slack-user> --group <ag-id>
```

### Verify it worked

- `ncl members list --group <ag-id>` shows the `slack:U...` handle, or
  `ncl roles list` if you granted a role.
- Dashboard `/admin/db`: `messaging_groups` has the `slack:C...`/`slack:D...`
  row wired in `messaging_group_agents`.
- The user gets a reply in-thread/in-DM.

### Slack gotchas

- **Top-level channel posts can't show a typing indicator** (Slack requires a
  thread for `assistant.threads.setStatus`). In-thread + DM typing works.
- **`SLACK_APP_TOKEN` is ignored** — v2 Slack is webhook-only, not Socket Mode.
- **Admin can't self-approve** admin-gated actions (security baseline); the
  card routes to a *different* deliverable admin. With only one Slack admin,
  some admin-gated actions can't be self-approved from Slack — use the host
  CLI or another admin surface.
- Slack **is** threaded (`supportsThreads: true`, via the thread-synthesis
  patch) — unlike Telegram and Signal.

---

## Quick reference — namespaced handle formats

| Channel | Handle (`user_id`) | Where to find it |
|---|---|---|
| Telegram | `telegram:<numericUserId>` | pairing output `ADMIN_USER_ID`, or `users` table |
| Signal | `signal:<ACI-UUID>` (**not** phone) | `messaging_groups.platform_id` (DM) / `users` table |
| Slack | `slack:<Uxxxx>` | profile → Copy member ID, or `users` table |
| Phone | `pstn:+<E164>` | auto-elevated via `PAT_OWNER_PHONES` |

## When a card never arrives

Likely causes, in order: (1) no owner/admin exists yet — establish one;
(2) the only approver isn't reachable on a DM (phone-only admin can't get
Slack/Telegram/Signal cards); (3) `PAT_ADMINS_BYPASS_APPROVAL=1` is suppressing
the card *for an admin sender* (expected); (4) policy is `strict` so the sender
was dropped before any card. Check `ncl approvals list`,
`ncl dropped-messages list`, and `ncl roles list`.
