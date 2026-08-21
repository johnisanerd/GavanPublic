# trace-e2e

Trace-based end-to-end test harness for PAT. Drives a real nanoclaw +
back-mind container against the anam-web HTTP surface, and asserts on
the **sequence and timing of structured log events** rather than on
function return values.

See `AGENTS.md` (root) for the project-wide rationale on trace-based
testing as the default for end-to-end work.

## Why HTTP-only (not browser-driven)?

This is the **integration-level** trace harness. It hits
`/anam-web/message` directly, bypassing the Anam SDK + browser. It
catches ~80% of bugs that hurt PAT in practice — every cognitive
pipeline failure, state-machine misbehavior, forward-fail hang,
narration regression — at a fraction of browser-driven cost.

Browser-driven E2E (Playwright) is a planned follow-up tier that adds
visual rendering, iframe lifecycle, and Anam SDK behavior coverage.
See `plans/trace-e2e-browser-tier.md` (TBD).

## Setup

```bash
cd trace-e2e
bun install
```

Local prerequisites (must already be running):

- `nanoclaw` host on `http://127.0.0.1:8766` (anam-web channel) and
  `:8767` (admin). Start with `cd nanoclaw && pnpm run dev`.
- A back-mind container that can spawn — requires the agent runtime
  image already built and OneCLI vault initialized (per
  `nanoclaw/CLAUDE.md`).
- `ANTHROPIC_API_KEY` in env (for the LLM judge — only needed if a
  test uses `judge()` from `@harness/judge`).

## Running

```bash
# All tests, verbose reporter (default).
bun run test

# Watch mode while iterating.
bun run test:watch

# A single test file.
bun run test src/tests/straight-run.test.ts
```

Tests run sequentially (one back-mind container at a time). Each test
mints a fresh `session_id` so there's no cross-test contamination.

## Architecture

```
src/
  harness/
    types.ts      # LogEvent shape (duck-typed against realtime/src/log-events.ts)
    ids.ts        # platform_id / session_id / thread_id minting
    driver.ts     # HTTP driver — sendUser / bargeIn / sessionEnded / preflight
    stream.ts     # Live SSE subscriber + in-memory EventLog buffer
    dsl.ts        # waitFor / expectSequence / between / assertNot + TraceTimeoutError
    judge.ts      # Optional LLM judge (Sonnet) for content assertions
    index.ts      # Barrel + startSession() convenience
  tests/
    straight-run.test.ts            # begin → all slides → done
    barge-in-with-question.test.ts  # mid-delivery interrupt → new Q
```

## Writing a test

```ts
import { test, expect } from 'vitest';
import { startSession } from '@harness/index';

test('descriptive scenario name', async () => {
  const s = await startSession({ scenario: 'smoke-test' });
  try {
    await s.driver.sendUser('Begin.', 'label-for-debug');

    // Bounded wait — throws TraceTimeoutError with structured context
    // on timeout (last 20 events + most recent related-kind events).
    const fwd = await s.log.waitFor(
      'request-layer.decided',
      (e) => (e.data.decision as string) === 'forward',
      { within: 8_000 },
    );

    // Retrospective count over a captured window.
    expect(s.log.between(fwd, lateEvent).count('utterance.stream-started'))
      .toBeGreaterThan(0);

    // Negative assertion — fail if a kind fires within a window.
    await s.log.assertNot('error.surfaced', null, { within: 5_000 });
  } finally {
    await s.end();
  }
}, 5 * 60 * 1000);
```

## DSL reference

| Method | Purpose | Throws |
|---|---|---|
| `waitFor(kind, pred?, opts)` | Bounded wait for the next matching event. `opts.within` required. `opts.since` optional anchor. | `TraceTimeoutError` with last-20 events + related-kind tail |
| `expectSequence([{kind, pred?}, ...], opts)` | Ordered wait — each step blocks until matched; interleaving allowed. | same |
| `between(start, end).count(kind, pred?)` | Retrospective count over a captured window. | never |
| `between(start, end).all(kind, pred?)` | Retrospective list. | never |
| `between(start, end).first(kind, pred?)` | Retrospective first. | never |
| `assertNot(kind, pred?, opts)` | Wait `opts.within` ms, fail if any match fires. | regular `Error` |
| `all(kind, pred?)` | All historical events of kind. | never |
| `first(kind, pred?)` | First historical event of kind. | never |

`TraceTimeoutError` includes:
- `waitingFor` — kind + predicate description
- `elapsedMs` — actual time waited
- `tail` — last 20 events seen
- `relatedMostRecent` — most recent event of each related kind (see `RELATED_KINDS` in `dsl.ts`)

## LLM judge

For semantic content assertions (e.g. "did the agent's response answer
the question?"), use `judge(rubric, transcript)`. Returns
`{pass: boolean, reason: string}`. Uses Sonnet by default; override via
`opts.model`. Indeterminate by design — strict rubrics should be on
event-sequence assertions, not on natural-language judgment.

```ts
import { judge } from '@harness/judge';

const transcript = s.log.all('utterance.stream-ended')
  .map((e) => e.data.full_text as string)
  .join(' ');

const verdict = await judge(
  'Did the response describe slide one in fewer than three sentences?',
  transcript,
);
expect(verdict.pass, verdict.reason).toBe(true);
```

## Adding a new scenario

1. Create a new packet folder under `nanoclaw/groups/presenter-<slug>/`
   following the existing `presenter-smoke-test/` layout.
2. Update the messaging-group DB to wire it to `anam-web:scenario-<slug>`
   (or rely on `loadScenarioContext`'s auto-resolve fallback).
3. Write the test in `src/tests/<slug>.test.ts`. Reference identity via
   `scenario: '<slug>'` in `startSession`.

## Adding a new event kind

The DSL doesn't need to know about new kinds — `waitFor` accepts any
string. But for richer failure messages, add the kind to
`RELATED_KINDS` in `dsl.ts` so timeouts show the most-recent sibling
events.

## What this doesn't test (the 20%)

- Visual slide rendering (Reveal.js fragment correctness)
- Anam SDK behavior (WebRTC, STT, persona swap)
- pat-web React rendering, banter-driver dedupe, iframe lifecycle
- Action-stream debug toggle UI
- Avatar audio quality (only the LLM judge proxies for this via
  transcripts)

For those, the browser-driven tier is the answer. See plans dir.
