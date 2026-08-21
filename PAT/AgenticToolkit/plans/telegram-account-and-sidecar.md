# Telegram: account requirements + whether to build a "send server" sidecar

**Status:** Research + recommendation. Read-only investigation — nothing built, deployed,
or registered. (2026-06-22)

**Driving goal:** multi-user testing. Gavan wants to act as a *second distinct user* against
PAT (eventually a burner phone), before inviting a colleague. The narrow question is "how do
we run a second Telegram identity programmatically for testing/sending", with the broader
question of whether a Signal-style sidecar is worth building.

---

## TL;DR / Recommendation

- **For multi-user testing right now: do NOT build anything.** The cheapest, fastest second
  identity is a **second human Telegram account on a second phone/eSIM** (or a spare
  Telegram account you already control on another device). You message PAT's bot from it by
  hand. Zero code. This is the literal definition of "second user" and exactly what you'd do
  before inviting a colleague.
- **A second *bot* is NOT a second user** for testing purposes — see §3. Bots and users are
  different account classes; a second bot won't exercise the "two humans in a group / two DMs"
  paths you care about.
- **A Telegram user-account sidecar (Telethon/GramJS/etc.) is NOT worth building now.** Unlike
  Signal, the Telegram **Bot API is a cloud HTTP API** — outbound sends are already direct
  HTTPS calls with no local daemon (the code even documents "No sidecar needed" — see §2). The
  only thing a user-account session buys you is (a) a *programmatic* second identity and
  (b) cold-DM-to-strangers capability. Defer both until there's a concrete product need.
- **Phone number: required for a Telegram *user* account.** No way around an OTP-capable
  number. Options ranked for our case: spare real SIM/eSIM (free-ish, lowest ban risk) >
  Fragment anonymous +888 number (~$16 floor at launch, now realistically $200+ and KYC'd) >
  VoIP/burner SMS sites (cheap but high ban risk in 2026, often fail to receive OTP).
- **Bots do NOT need their own phone** — but BotFather (which mints them) runs inside a normal
  Telegram user account, which does. So "a bot with zero phone anywhere in the chain" is
  impossible; the phone lives on the human account that owns BotFather.

---

## 1. Does Telegram require a phone number?

### 1a. Bot accounts (via @BotFather)
- A bot is **not** created with its own phone number. You create it by chatting with
  [@BotFather](https://t.me/botfather), which issues an HTTP API **token**. The bot
  authenticates to the Bot API purely with that token — no phone, no OTP, no MTProto login.
  This matches our code: `telegram.ts` only ever uses
  `https://api.telegram.org/bot${token}/...` (getMe, sendMessage, sendVoice). No phone
  anywhere.
- **But** BotFather is itself a bot you talk to *from a logged-in Telegram user account*, and
  that user account needed a phone to exist. So: a bot needs no phone of its own, but it is
  always owned/created by a phone-backed human account. There is no fully phone-free path to a
  bot. (Telegram Bots FAQ: <https://core.telegram.org/bots/faq>)
- Practical upshot for us: our existing `@pat_staging_bot` already proves this — it has a
  token, no phone, and sends via HTTPS.

### 1b. User accounts — phone required
- **Yes, a phone number is required** to create a Telegram user account in 2026. Signup sends
  an OTP to a number; you must receive it. There is no email-only or passkey-only account
  creation. (Passkeys/2FA exist only as a *second* factor on an already-phone-backed account.)
- Alternatives to a personal SIM, in descending order of "officially blessed":
  1. **Fragment anonymous numbers (the only Telegram-endorsed no-SIM path).** Blockchain
     `+888…` numbers bought with TON on <https://fragment.com>. Launch price was 9 TON (~$16),
     but the cheapest *currently listed* randoms are ~$200+, and **KYC (gov ID + liveness
     selfie via Sumsub) has been mandatory since Nov 2024**. These numbers work *only* with
     Telegram — they can't receive SMS/calls or register elsewhere. Permanent, low ban risk,
     but no longer cheap and no longer truly anonymous (KYC). Sources:
     <https://coinpaper.com/732/telegram-allows-blockchain-based-no-sim-signup>,
     <https://www.dextools.io/tutorials/fragment-tutorial-telegram-usernames-anonymous-numbers-guide-2026>.
  2. **eSIM / dedicated VoIP (Twilio, Google Voice, Hushed).** A clean dedicated VoIP number
     can work for long-term accounts. Holafly-style eSIMs give a real receivable number.
     (<https://esim.holafly.com/how-to/how-to-use-telegram-without-a-phone-number/>)
  3. **Free disposable/burner SMS sites.** Cheapest, but in 2026 Telegram's anti-spam is
     aggressive: public burner numbers frequently **fail to receive the OTP** or get the
     account flash-banned shortly after. Fine for a throwaway, bad for a stable test identity.
     (<https://sms-man.com/blog/how-to-create-an-anonymous-telegram-account/>,
     <https://web3.bitget.com/en/academy/how-to-create-a-virtual-number-for-telegram-and-avoid-account-ban-risks>)

### 1c. Recommendation for our multi-user test
- **Best value: a spare real number you already own** — second personal phone, a family SIM,
  or an eSIM line. Free or near-free, lowest ban risk, receives OTP reliably. This is the
  "burner phone" the user already mentioned wanting.
- **If you want it to be permanent + somewhat detached: a Fragment +888 number.** Budget
  ~$200 and expect to pass KYC. Worth it only if this becomes a long-lived dedicated PAT-test
  identity, not for a one-off.
- **Avoid free VoIP/burner sites for anything you'll keep** — high failure + ban risk in 2026.
- **Do not reach for a second *bot* as "a second user"** — wrong account class (see §3).

---

## 2. Is a Telegram "send server" / user-account sidecar worth building?

### 2a. The BOT case: no sidecar needed. Already true in our code.
The Signal sidecar exists because **signal-cli is a local daemon** that must hold a user-account
session and read files off a specific machine's `/tmp` (see
`reference_signal_staging_sidecar` and `reference_signal_voice_memo_format` in memory). The
sidecar (`transports/signal_staging.py`, FastAPI on the signal machine) only exists to bridge
bytes into signal-cli's filesystem for native voice-memo rendering.

**Telegram has none of that problem for bots.** The Bot API is a stateless cloud HTTP endpoint
(`api.telegram.org`). Our adapter already sends everything — text *and* voice — with direct
HTTPS calls:

- `nanoclaw/src/channels/telegram.ts:233` — `sendVoice` via a multipart `FormData` POST
  (Opus/OGG buffer uploaded inline; no local-path requirement, no machine affinity).
- The code comment at `telegram.ts:206-208` says it explicitly: *"No sidecar needed (unlike
  Signal): the Bot API takes a direct multipart upload, so there's no 'real local path on a
  specific machine' problem."*
- Voice format note: Telegram's native round-bubble voice message wants **Opus-in-OGG** (see
  `synth.ts:8,34`), the opposite of Signal's AAC/m4a requirement. `synthesizeVoiceMemo(text,
  voiceId, { format: 'ogg' })` already handles this.

So for PAT-as-a-bot there is **nothing to build**. Sends are direct; the sidecar concept does
not apply.

### 2b. The USER-account case: what a sidecar *would* be, and the library choice
A Telegram **user-account** sidecar would be the true Signal analog: a long-running service
holding an MTProto **user session** (not a bot token) that can send/receive as a real identity.
You'd only build this if you need a *programmatic* second identity (automated test traffic) or
cold-DM capability (§3).

Library comparison (all speak MTProto and support user-account auth):

| Library | Lang | Session handling | Media/voice | Maintenance (2026) | Notes |
|---|---|---|---|---|---|
| **Telethon** | Python | `StringSession` (portable string), file sessions | Full (`send_file`, voice) | Actively maintained, most popular | Easiest to set up; matches our Python sidecar precedent (signal_staging.py is FastAPI/Python). <https://docs.telethon.dev> |
| **GramJS** | JS/TS | `StringSession`, store2/node-localstorage | `messages.SendMedia` | Active; powers Telegram Web Z (official client) | Same language as nanoclaw (TS). <https://gram.js.org>, <https://github.com/gram-js/gramjs> |
| **Pyrogram** | Python | String/file sessions | Full | Less momentum than Telethon | Slower throughput in 2026 benchmarks. |
| **TDLib** | C++ (+bindings) | Native DB | Full, most complete | Robust, official-grade | C++ deps bloat the image; heaviest to operate. |
| **mtcute** | TS | String sessions | Full | Newer, clean rewrite | Modern TS option; smaller community. |

Recommendation **if/when** we build it:
- **Python + Telethon** to mirror the existing `signal_staging.py` Python sidecar pattern and
  reuse the same operational shape (FastAPI on a Fly machine). Easiest auth/session story.
- **OR GramJS** if we'd rather keep it in-process/in-language with nanoclaw (TypeScript). Its
  `StringSession` persists cleanly and it's battle-tested (official web client). Either is fine;
  Telethon wins on docs+community, GramJS wins on language alignment.

Sources for library comparison:
<https://docs.telethon.dev/en/stable/concepts/botapi-vs-mtproto.html>,
<https://piptrends.com/compare/telethon-vs-pyrogram>,
<https://johal.in/telethon-mtproto-python-telegram-client-libraries-for-api-automation-2026/>,
<https://mtcute.dev/guide/intro/faq>.

### 2c. Sketch of a `telegram-user` sidecar (only if we decide to build)
Mirrors `transports/signal_staging.py`:

1. **One-time interactive auth (the painful part).** First boot needs the phone number +
   the SMS/app login code (and 2FA password if set). This is *interactive* and can't be fully
   automated — you run an auth script once, capture the resulting `StringSession`, and store it
   as a Fly secret (e.g. `TELEGRAM_USER_SESSION`). All later boots load the session string,
   no code prompt.
2. **Session persistence:** the `StringSession` string in a Fly secret (analogous to how
   signal-cli state lives on a volume). Stateless container otherwise.
3. **Send/receive API:** tiny FastAPI (Telethon) or HTTP server (GramJS) exposing
   `POST /send` (recipient, text/media) and a receive path — either long-poll/webhook out to
   nanoclaw or push inbound events the way the Signal JSON-RPC daemon does. Inbound is the
   value-add over the bot (a user account *can* receive DMs from anyone).
4. **Where it runs:** its own small Fly app (e.g. `pat-telegram-user`) in the org, reachable
   over 6PN like the signal machine. **Bind `[::]` not `0.0.0.0`** (Fly 6PN is IPv6-only — the
   exact gotcha that bit the Signal sidecar). Budget ~512MB.
5. **Auth model:** none beyond 6PN org scoping, same trust model as the signal sidecar.

This is real work (interactive auth, session refresh handling, ToS/ban exposure for
automation). **Don't build it for testing** — a human on a second phone is strictly cheaper.

---

## 3. Bot vs user account for PAT's actual product

The one capability a bot **cannot** do, which a user account can:

- **Bots can't initiate a DM to a user who hasn't messaged the bot first.** Attempting it
  returns `Forbidden: bot can't initiate conversation with a user`. The user must `/start` (or
  otherwise message) the bot before the bot may DM them. This is a hard, spam-prevention rule
  enforced by Telegram. Sources:
  <https://core.telegram.org/bots/faq>,
  <https://community.make.com/t/telegram-bot-error-bot-cant-initiate-conversation-with-a-user/47720>,
  <https://github.com/henrygd/beszel/discussions/872>.

**Does this matter for PAT?** It directly collides with PAT's **outbound / cold-contact
ambitions** (see `reference_one_flow_well_plans` — "cold-contact send … NEVER verified end-to-end").
On Signal, cold contact is possible because PAT drives a real user account via signal-cli. On
Telegram, **the bot can never cold-DM a stranger** — the recipient must initiate. So:

- For warm/opt-in flows (a user starts the bot, joins a group, etc.) the **bot is the right
  choice** and needs no sidecar.
- For **cold outbound to arbitrary people on Telegram**, PAT would have to run as a **user
  account** via the MTProto sidecar in §2b/§2c. Note this carries real ban risk: automated
  user accounts doing unsolicited outreach are exactly what Telegram's anti-spam targets, and
  it's closer to a ToS gray area than the bot path.

Recommendation: **keep PAT-on-Telegram as a bot** for the foreseeable future. Only consider a
user-account identity for Telegram if/when cold-contact-on-Telegram becomes a validated product
requirement — and even then, weigh the ban risk against just steering Telegram cold-contact
through the opt-in `/start` link funnel instead.

---

## Bottom line

| Question | Answer |
|---|---|
| Phone required to make a user account? | **Yes**, OTP-capable number, no exceptions. |
| Phone required for a bot? | **No** for the bot itself; the BotFather-owning human account needs one. |
| Cheapest second identity for multi-user testing? | **A second human account on a spare phone/eSIM.** Build nothing. |
| Anonymous number viable/affordable? | Fragment +888 works (Telegram-endorsed) but ~$200+ and KYC'd now — overkill for testing. |
| Sidecar needed for bot sends? | **No** — Bot API is cloud HTTP; voice already sent via direct multipart (`telegram.ts:233`). |
| User-account sidecar worth building now? | **No.** Defer. Telethon (Python, mirrors signal_staging.py) or GramJS (TS) if we ever do. |
| Should PAT ever be a Telegram user account? | Only to cold-DM strangers (bots can't). Not needed yet; carries ban risk. |
