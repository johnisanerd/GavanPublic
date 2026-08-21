# Outbound Callback & Resume

> **Status: agreed.** Pieces of this land in Wave 2.B of
> `multi-agent-feature-buildout.md` (`initiateContact()` primitive +
> container-side MCP tool). Cartesia outbound endpoint verified
> 2026-05-09. Pairs with `persistent-workspaces.md` and
> `self-hosting-pat.md` — read all three together.

## Context

Today, when nanoclaw restarts (planned redeploy, `tsx watch` reload, crash),
any active conversation is interrupted. On voice this is felt immediately —
voice-transport's SSE drops, the user hears dead air. On Slack it's invisible
(messages are async) but PAT silently abandons whatever it was thinking about.

We want **PAT to initiate contact when it comes back up**, picking up where
the conversation left off. This generalizes beyond deploy-recovery: the same
"outbound initiate" primitive unlocks pending-approval pings, deferred
reminders ("you asked me to check back in 30 min"), and async task completion
notifications ("your deploy finished").

Tied directly to the [self-hosting plan](./self-hosting-pat.md) — once PAT is
editing its own code, the dev loop benefits enormously from being able to
restart the host without dropping the call you're using to drive it.

## Three latency tiers

The right behavior depends on how long the gap is:

| Gap | Behavior | Mechanism |
|---|---|---|
| <5s (`tsx watch` reload) | Bridge — call doesn't drop | voice-transport SSE-reconnect with backoff, filler audio loop during gap |
| 5–30s (Fly redeploy) | End cleanly, dial back | voice-transport says "I'm restarting, calling you right back," ends call. Boot hook in nanoclaw triggers Cartesia outbound. |
| >30s or crash | Callback only path | Same as above but with longer "sorry I dropped, picking back up" framing |

Slack collapses these tiers — no audio gap to fill, just post a resume
message on boot.

## Cartesia outbound (verified capabilities)

Confirmed via Cartesia docs (2026-05-09): outbound dialing is a first-class
feature.

**Endpoint**: `POST https://api.cartesia.ai/twilio/call/outbound`

```bash
curl -X POST "https://api.cartesia.ai/twilio/call/outbound" \
  -H "Authorization: Bearer $CARTESIA_API_KEY" \
  -H "Cartesia-Version: 2025-04-16" \
  -H "Content-Type: application/json" \
  -d '{
    "target_numbers": ["+15550100000"],
    "agent_id": "<our-deployed-agent-id>",
    "metadata": {
      "custom_prompt": "Hey, I had to restart, picking up where we left off...",
      "resume_context": "<short summary of where we were>",
      "original_thread_id": "call-a0b72d78afcf"
    }
  }'
```

Key affordances:

- **`metadata` is up to 1MB JSON** — plenty of room for full resume context.
- **`custom_prompt`** is a documented convention; injects per-call into the
  agent's system prompt. We don't need to redeploy to vary the opener.
- Metadata reaches voice-transport's existing `get_agent(env, call_request)`
  via `call_request.metadata` — same hook the bridge already uses for inbound.
- `pre_call_handler` lets us reject or reconfigure (voice/language) before the
  agent starts.
- `Cartesia-Version: 2025-04-16` header required (matches existing memory's
  note on `cartesia_version` requirement).
- TCPA compliance is the caller's responsibility. For our use case (calling
  the same user back on the same number within seconds of dropping their
  call) implied consent is fresh — clean.
- CLI for quick testing: `cartesia call <phone> <agent_id>`.

Sources:
- [Cartesia Line — Outbound Dialing](https://docs.cartesia.ai/line/integrations/telephony/outbound-dialing)
- [Cartesia Line SDK — Agents (CallRequest, pre_call_handler, metadata)](https://docs.cartesia.ai/line/sdk/agents)

## Architecture — `initiateContact` primitive

A single channel-agnostic interface, dispatched on `platform_id` prefix
(matches the existing realtime-owners pattern in
`nanoclaw/src/modules/permissions/realtime-owners.ts`).

```ts
// nanoclaw/src/modules/outbound-initiate.ts
export interface InitiateContactRequest {
  platformId: string;          // 'pstn:+E164' | 'slack:U0...' | 'slack:D0...'
  reason: 'resume-after-restart' | 'pending-approval' | 'reminder' | 'task-complete';
  resumeContext?: string;      // pre-rendered resume opener
  originalThreadId?: string;   // for resume — re-attach to existing session
  metadata?: Record<string, unknown>;
}

export async function initiateContact(req: InitiateContactRequest): Promise<void> {
  const channel = inferChannel(req.platformId);  // 'realtime' | 'slack'
  switch (channel) {
    case 'realtime': return initiateRealtime(req);
    case 'slack':    return initiateSlack(req);
  }
}
```

The two adapters live alongside the inbound channel adapters at
`nanoclaw/src/channels/`:

- `realtime.ts` gains `initiateOutbound({platformId, ...})` that POSTs to
  Cartesia.
- `slack.ts` gains `initiateOutbound({platformId, ...})` that uses the
  bot-token Web API to post into the DM/thread keyed by `platform_id`.

All callers — boot recovery, approval-pending pings, reminders — go through
`initiateContact()`. No ad-hoc `sendOutboundMessage` paths anywhere else.

## Per-channel resume

### Slack — easy

Boot hook iterates eligible sessions. For each Slack-platform-id session:

1. Read last few outbound.db rows (chat + last narration) for the session.
2. One-shot Haiku call: "summarize where we were in <15 words."
3. Post to thread/DM via `chat-sdk-bridge` Slack adapter:
   `"Hey, restarted, we were talking about X — still want me to ship it?"`

No call-state to thread, no audio gap to fill, no Cartesia outbound. ~50 LOC.

### Voice — harder

Boot hook for realtime-platform-id sessions:

1. Read last few outbound rows + recent banter buffer for context summary.
2. Generate `custom_prompt` ("Hey, I'm back, we were talking about X — want
   me to keep going?") via the same Haiku summarizer.
3. POST Cartesia outbound endpoint with `target_numbers: [user_phone]`,
   metadata carrying `resume_context` and `original_thread_id`.
4. Cartesia dials via Twilio. User picks up. Cartesia bridges to
   voice-transport with our metadata.
5. voice-transport's `get_agent` reads metadata. If `resume_context`
   present, prepend as the agent's introduction (replacing the normal
   greeting).
6. **Critical**: voice-transport posts `/inbound` with
   `thread_id = metadata.original_thread_id` (not a fresh one), so nanoclaw
   re-uses the existing session DB and the back-mind container is already
   there waiting on its poll loop.

The `original_thread_id` plumbing is the load-bearing detail. Without it the
back-mind starts a fresh container and loses conversational context entirely.

## Heartbeat for eligibility

Avoids spurious callbacks when a call ended cleanly right before a crash.

- **Heartbeat write** every 5s while a call/Slack thread is engaged,
  appended to a new column on `state-sqlite.ts`'s session table:
  `heartbeat_ts` (ms epoch).
- **`call.ended` / `session.closed`** explicitly clears `heartbeat_ts` to
  null.
- **On boot**: scan sessions where `heartbeat_ts > now - 60_000` (i.e.,
  heartbeat in the last minute). Those are callback-eligible.
- **TTL window** is generous (60s) but bounded — avoids re-engaging users
  after long outages where they've moved on.

Slack-side: same heartbeat applies for active threads (thread is "engaged"
while the user is actively messaging). Less critical because a stray Slack
post is socially low-stakes.

## Implementation phases

### Phase 1 — Slack resume (~2 days)

1. New module `nanoclaw/src/modules/outbound-initiate.ts` with the
   `initiateContact()` interface and Slack adapter wired.
2. Heartbeat column on session state. Write on inbound/outbound activity;
   clear on session-end.
3. Boot hook in `host-sweep.ts` (already runs on boot — natural seam) that
   enumerates eligible sessions and calls `initiateContact()` for each
   Slack one.
4. Resume-context summarizer — small Haiku helper at
   `realtime/src/resume-summarizer.ts`, reads last N outbound rows.
5. Smoke: Slack DM with PAT mid-conversation → restart nanoclaw → expect a
   "we got cut off, here's where we were" post within seconds of boot.

No Cartesia changes. Validates the primitive end-to-end on the easier
channel.

### Phase 2 — Voice callback (~3 days)

1. `realtime.ts` adapter gains `initiateOutbound()` posting to Cartesia.
2. voice-transport's `get_agent` reads `call_request.metadata.resume_context`
   and uses it as the introduction when present.
3. voice-transport threads `metadata.original_thread_id` into its `/inbound`
   POSTs so the existing nanoclaw session is re-attached.
4. New log-event kinds: `outbound.initiated`, `outbound.failed`,
   `outbound.connected`, with Python mirror per the AGENTS.md drift rule.
5. Smoke: phone call with PAT mid-conversation → restart nanoclaw →
   PAT calls back within ~5–10s with the resume opener → conversation
   continues using the same back-mind container.

### Phase 3 — Bridge mode for short gaps (~2 days)

For `<5s` reloads, ending and re-dialing is overkill. voice-transport
already retries SSE with backoff; just need to:

1. Filler-audio loop in voice-transport during SSE-disconnect window
   ("one moment…" with 2–3s gaps). Avoid dead air.
2. Once reconnected within the threshold, no `call.ended` is emitted —
   conversation continues seamlessly.
3. If reconnect doesn't happen within ~5s, escalate to the "I'll call you
   right back" graceful-end path so Phase 2's callback can fire.

### Phase 4 — Generalize the primitive (~1 week, opportunistic)

Once `initiateContact` is proven for boot recovery, retrofit:

- **Pending-approval pings**: when an approval card sits unanswered for
  >5min, ping the requesting admin via DM — "Hey, you have a pending
  approval card on the Slack thread." (Today the approval system has no
  ping mechanism; if you miss the card, it's dead.)
- **Deferred reminders**: scheduled prompts via the existing
  `CronCreate`-like mechanism in nanoclaw (or a new lightweight scheduler)
  call back into `initiateContact()`.
- **Task-complete notifications**: long deploys, big test runs, outbound
  research jobs — notify on completion via the user's preferred channel.

## Open questions

1. **Cartesia agent_id correlation**: we have one Cartesia agent pointing
   at voice-transport. An outbound call lands at voice-transport same as
   inbound; the `from_` field tells us who answered. Need a smoke test that
   confirms voice-transport can distinguish "this is an outbound resume,
   re-attach to thread X" from "this is a fresh inbound" purely via
   metadata. Probably yes (metadata is per-call) but unverified.

2. **Twilio "from" number** for outbound: we need a Twilio number Cartesia
   is allowed to dial *from*. The number users dial *into* might or might
   not be the same. Worth checking the Cartesia dashboard / agent config
   before assuming.

3. **TCPA scoping**: implied consent is clean for "user just dropped, call
   back within 60s." Beyond that (deferred reminders, approval pings) we
   probably want explicit opt-in stored on the user record. New column
   `outbound_voice_opted_in` on `user_roles` or similar.

4. **Voice resume opener length**: Cartesia takes a `custom_prompt`, but
   the agent introduction is what the *user actually hears first*. Need
   to confirm whether `metadata.custom_prompt` becomes the system prompt
   (silent) or the first utterance (audible). The docs example uses it for
   system prompt augmentation; we may need a separate `metadata.intro`
   field or to override `agent.introduction` in `pre_call_handler`.

5. **Idempotency**: if nanoclaw restarts twice in quick succession, we
   shouldn't double-dial. Ledger of in-flight outbound attempts with
   dedupe key `(platform_id, original_thread_id)` for the recent window.

6. **What if the user is now on a *different* call**? Calling them back
   when they're already on the phone with someone else is rude. Detection
   is non-trivial — Twilio knows but we don't see that signal. Defer to
   "don't worry about it, voicemail catches it" for v1.

## Critical files / pointers

- `nanoclaw/src/host-sweep.ts` — boot hook seam
- `nanoclaw/src/state-sqlite.ts` — heartbeat column
- `nanoclaw/src/channels/realtime.ts` — outbound adapter
- `nanoclaw/src/channels/slack.ts` — slack outbound (Web API client already
  wired by `@chat-adapter/slack`)
- `transports/main.py` — `get_agent` callback to wire metadata-based
  intro override
- `realtime/src/log-events.ts` — new `outbound.*` kinds (with Python mirror)
- Memory `reference_voice_transport_quirks.md` — SSE reconnect retry pattern
  is already in place
- Memory `reference_pat_external_repos.md` — Cartesia CLI location for
  testing
- BUGS.md `Long-running Bash can't be cancelled` — adjacent prerequisite
  (callback alone doesn't help if user can't cancel runaway tools)

## Verification

Phase 1: Slack DM mid-conversation → `pkill nanoclaw` → boot →
within 10s a thread post appears with last-context summary.

Phase 2: phone call mid-conversation → `pkill nanoclaw` → boot →
within ~10s the user's phone rings back; PAT opens with "we were talking
about X" → user can pick up the same thread; back-mind container still has
state.

Phase 3: phone call → `tsx watch` triggers reload → user hears 2s of filler
audio, no call drop, conversation continues.

Phase 4: approval card sits unanswered → 5 min later a DM ping fires; same
on a CronCreate-style scheduled prompt.
