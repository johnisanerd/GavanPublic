# @agentic-toolkit/smoketest

Tier 3 of the three-tier test infrastructure. Drives the running NanoClaw realtime channel with scripted-but-flexible conversations and asserts on transcripts.

## When to use which tier

| Tier | Where | Speed | What it catches |
|------|-------|-------|-----------------|
| **1 — unit** (`realtime/src/*.test.ts`) | in-process, mocked | ~200ms | logic bugs, regressions in state/JSON-repair/router |
| **2 — fast LLM** (`realtime/src/*.live.test.ts`) | in-process, real Haiku | ~10s | prompt drift in front-mind classifier and narration |
| **3 — full smoke** (this package, text default) | full nanoclaw + container | 5s–3min | the things that only break end-to-end (concurrent turns, classification + back-mind interaction, container quirks) |
| **3T — `--audio`** (this package) | + Cartesia TTS+STT round-trip | +1-2s/turn | voice-domain regressions (homophones, dropped words, capitalization shifts) |
| **3A — `--call`** (this package) | + real Cartesia Calls WS | full call pipeline | end-to-end voice flow: STT → voice-transport → NanoClaw → TTS, mixed-audio recording |

Run them in that order during the dev loop. Tier 1 on every save; Tier 2 before pushing prompt changes; Tier 3 when something feels wrong end-to-end or before a phone test.

## Prerequisites

NanoClaw must be running with the realtime channel up:

```bash
# In one terminal:
cd ../nanoclaw && ../scripts/nanoclaw-dev.sh

# Verify in another:
../scripts/nanoclaw-test-fixture.sh --verify
```

Required env vars (export, or source `nanoclaw/.env`):
- `ANTHROPIC_API_KEY` — for the simulated user + judge
- `CARTESIA_API_KEY` — only for `--audio` mode

## Run

```bash
pnpm install                                # one-time
pnpm run scenario baseline                  # one scenario
pnpm run scenarios                          # all scenarios
pnpm run scenario barge-in --stream         # tail SSE events to stdout

pnpm run repl                               # interactive harness
```

Inside the REPL:

| command | what it does |
|---------|--------------|
| (any text) | post as a user turn |
| `/list` | list available scenarios |
| `/scenario barge-in` | run a scenario inline |
| `/sim "an annoyed user"` | one-shot LLM-driven turn from a persona |
| `/quit` | exit |

## Audio mode

Add `--audio` to route every user turn through Cartesia TTS → STT before it hits NanoClaw:

```bash
pnpm run scenario baseline --audio
```

Per-turn artifacts land at `data/v2-sessions/_smoketest/<scenario>-<ts>/audio/turn-NNN.wav` (and a sidecar `.json` with the original text vs. STT output). Useful for catching voice-domain regressions that text-only mode would miss (homophones, dropped words, capitalization shifts). Audio mode silently disables (and falls back to text) if `CARTESIA_API_KEY` is not set.

## Calls (Tier 3A) mode

Add `--call` to route every user turn through a real Cartesia Calls WebSocket — the same transport a phone caller hits, minus PSTN:

```bash
pnpm run scenario baseline --call
```

User turns are TTS'd to PCM and streamed in as `media_input` frames; agent audio comes back in `media_output` frames and is mixed into a per-scenario `call.wav` artifact. The SSE tap to NanoClaw stays open in parallel for structural assertions, so `wait-utterance` / `wait-chat` / `judge` steps work unchanged.

This is the closest thing to a real phone test inside the smoketest harness — Cartesia's full voice pipeline (STT → voice-transport on Fly → NanoClaw → real TTS) sits in the loop, just driven from `CartesiaCallClient` instead of the PSTN.

Required env:
- `CARTESIA_API_KEY` — auth
- `CARTESIA_AGENT_ID` (or `CARTESIA_AGENT_ID_STAGING`) — the agent the WS routes to
- `CARTESIA_TTS_USER_VOICE_ID` (optional) — voice for the simulated user (default: "barbershop man")

Artifacts under `data/v2-sessions/_smoketest/<scenario>-<ts>/`:
- `call.wav` — mixed stereo recording of the whole call (overlap = audible overlap)
- `transcript.md` — `(transport: cartesia-ws)` tag on user turns

`--call` is more expensive than `--audio` (~$0.05/scenario at staging rates) — keep it scoped to scenarios you actually want to verify against real Cartesia. The `--audio` mode is cheaper and covers most voice-domain regressions; only flip to `--call` when you specifically need Cartesia's call-pipeline behavior in the loop.

## Reading transcripts

Each run writes:

```
data/v2-sessions/_smoketest/<scenario>-<ts>/
├── transcript.md      ← human-readable, open this first
├── transcript.json    ← every event + computed metrics
├── result.json        ← per-step outcomes + judge verdicts
└── audio/             ← only in --audio mode
    ├── turn-000.wav
    ├── turn-000.json  ← {inputText, transcribedText, latencyMs}
    └── …
```

`transcript.md` opens in any markdown viewer. The header has metrics (ack/chat latency, error-fallback count); the body is a chronological log with `+Nms` offsets so you can see exactly where things slowed down.

## Writing scenarios

Add a file under `src/scenarios/` and register it in `registry.ts`. Steps:

| step kind | purpose |
|-----------|---------|
| `turn` | post a literal text turn |
| `sim-turn` | ask the simulated user for the next turn (requires `scenario.user` set) |
| `wait-utterance` | wait for the next `kind='realtime-utterance'` (front-mind) |
| `wait-chat` | wait for the next `kind='chat'` (back-mind) |
| `sleep` | unconditional pause |
| `judge` | LLM rubric check on the transcript so far |
| `expect-no-event` | inverse — fails if a matching event arrives in the window |

Scenarios with `user.persona`/`goal` get an LLM-driven user; those without are fully scripted. They can mix.

### Custom-run scenarios

Scenarios that need to drive a side-channel (admin SSE, Cartesia WS, a
prod log proxy) can implement their own runner via `customRun` on the
scenario object. When set, the step engine is bypassed entirely — the
scenario function owns the lifecycle. The `steps` array is decorative
in that case (only used for `pnpm scenario --help`).

Set `requiresLocalClient: false` on the scenario to also skip the
runner's local `/outbound` SSE connect. Use this for scenarios that
target a remote host and have no local nanoclaw to listen to.

## Live-prod scenarios (opt-in via env)

### `signal-prod-inbound`

Drives PAT's production Signal channel end-to-end via the deployed
signal-test-rig as the "other party," then asserts against
`pat-frontend.fly.dev`'s `/api/logs.jsonl` that the inbound landed in
PAT's router AND the back-mind produced a delivered outbound reply on
the same session. Opted out of the local-SSE tap — no local nanoclaw
required.

```bash
export PAT_VIEWER_TOKEN=...      # from .env.agent
export PAT_SIGNAL_RIG_TOKEN=...  # see reference_pat_external_repos.md
pnpm run scenario signal-prod-inbound
```

Optional overrides:

| Env var | Default | What it does |
|---------|---------|--------------|
| `PAT_FRONTEND_URL` | `https://pat-frontend.fly.dev` | pat-frontend log proxy host |
| `PAT_SIGNAL_RIG_A_URL` | `https://pat-signal-rig.fly.dev` | rig A endpoint |
| `PAT_SIGNAL_E164` | `+15550100003` | PAT's Signal number (recipient) |
| `SMOKETEST_SIGNAL_TIMEOUT_MS` | `120000` | overall wait for the routing chain |
| `SMOKETEST_SIGNAL_POLL_MS` | `2500` | poll interval for `/api/logs.jsonl` |
| `SMOKETEST_SIGNAL_REPLY_TAIL_MS` | `30000` | best-effort wait for the rig's WS to see PAT's reply |

The scenario short-circuits to PASS-with-skip-note when either token
is missing, so the full suite stays green on dev machines without prod
credentials.

Cost is ~$0.001–$0.01 per run (one Haiku banter call on the host,
back-mind container call amortized).

#### Why not `inbound.received` / `banter.called` / `request-layer.decided`?

Those kinds are emitted only by `realtime/src/channel-orchestrator.ts`
for realtime channels (anam-web, phone-call). Signal is a chat channel
— its inbound path goes through `nanoclaw/src/router.ts` which emits
`routing.message-routed` instead; the container produces the reply
without a front-mind/back-mind split. The scenario asserts the
equivalent chat-channel chain (`routing.message-routed` for inbound,
`routing.message-delivered` for the outbound reply), which is the
spirit of the brief — "the right thing happened in the right order
under real conditions." See AGENTS.md "Trace-based end-to-end tests."

## What this does NOT do

- **Telephony**: no Cartesia phone runtime, no PSTN. Use `--audio` for voice-domain coverage; do a real call when you change anything that touches Cartesia Line.
- **Parallel scenario runs**: today scenarios run serially. The realtime channel pins `platform_id='local'`, so all parallel runs would funnel into the same NanoClaw session and pollute each other's SSE stream. Real parallelism needs per-worker `platform_id` provisioning + matching agent groups.
- **Cost caps**: each scenario fires Haiku (sim user, classifier), Sonnet (judge), and Opus (back-mind). Currently no spend cap — keep an eye on your dashboard if you run the full suite repeatedly.

## Known things this surfaces

The harness is doing its job — these came from running the initial 6 scenarios:

- **`barge-in`**: turn A's chat lands as the response to turn B (back-mind queues the second turn as a follow-up rather than aborting A). Tracked in sprint as concurrent-turn handling.
- **`topic-switch`**: turn B never gets a back-mind chat within 90s after A's chat resolves. Possibly cold-restart cost between back-mind invocations on the same session.
- **`install-failure-recovery`**: tracks the `install_packages` admin gap; flips to "agent should successfully install" once admin is granted.
