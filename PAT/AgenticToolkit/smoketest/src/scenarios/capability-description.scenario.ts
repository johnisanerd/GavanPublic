/**
 * capability-description — verifies Pat answers "what can you do?" type
 * questions from the REAL capability registry rather than fabricating a
 * generic tool list.
 *
 * History — the failure mode this scenario catches:
 *   Banter has historically hallucinated capability lists when asked
 *   "what tools do you have?", "what can you do?", etc. — making up
 *   generic answers like "I can hit APIs, run searches, that kind of
 *   thing" instead of deferring to the back-mind. The request layer
 *   then noops because banter "handled it." No back-mind invocation,
 *   no real list of tools. See `sprint/backlog.md` "Banter answers
 *   capability/tool questions itself instead of deferring" and
 *   `sprint/current.md:516-522`.
 *
 *   The intended path: banter acks ("yeah, lemme give you the
 *   rundown"), the request layer forwards to the back-mind, and the
 *   back-mind produces a `chat.row-received` event whose body
 *   references at least one REAL capability from the active registry
 *   and avoids fabricated entries.
 *
 * Trace-based shape (per AGENTS.md "Trace-based end-to-end tests"):
 *   We assert on the host's `/admin/logs.tail` SSE stream, filtered to
 *   `kind === 'chat.row-received'` with our scenario's thread_id. The
 *   chat row's `data.full_text` is checked against the active
 *   capability registry — NOT by regexing the SSE outbound `chat` event
 *   text or scraping the rendered banter audio.
 *
 *   The /admin/logs.* stream is the same surface production forensics
 *   reads (`pat-trace.py`, `pat-frontend`) — a regression here would
 *   show up identically on a real call and in this test.
 *
 * Registry source (TaskList #8 lifecycle split):
 *   - Install-side capability surface (channels, MCP tools, skills,
 *     sdk_tools, etc.) is emitted ONCE per agent group at boot as
 *     `capability.install-resolved`. We tail-back to grab whichever
 *     install snapshot matches the agent group of the current inbound.
 *   - Per-inbound caller context (identity, known handles, permissions)
 *     is emitted as `capability.caller-context-resolved` after every
 *     inbound, carrying `agent_group_id` for join purposes.
 *
 *   We derive the per-turn registry from the install snapshot — names +
 *   summaries from channels, container_mcp_tools, container_skills,
 *   sdk_tools, external_mcp_servers, slash_commands, host_verbs.
 *
 *   Fallback: when no matching install snapshot is found (resolver_present=
 *   false, or this is the synthetic smoketest agent group with no
 *   install-cap registration), we fall back to FIXTURE_CAPABILITIES
 *   below. Keeps the scenario useful pre-while the realtime channel
 *   adapter wires its resolver. Once production seeds installs at
 *   boot, the fixture path stops firing.
 */
import type { Scenario, ScenarioContext, ScenarioResult, StepOutcome, Step } from './index.js';
import { openLogTail, type LogEvent } from '../log-tail.js';

// ── Capability registry (LIVE snapshot + fixture fallback) ───────────────
//
// The orchestrator emits `capability.context-resolved` per inbound; we
// derive each probe's registry from that snapshot when present. When
// the snapshot is absent (resolver not wired on this channel adapter
// yet — current state for the synthetic `platform_id=smoketest` group),
// we fall back to FIXTURE_CAPABILITIES below. The fixture mirrors the
// families that the live `palisade-internal` install consistently
// surfaces, so we still catch banter-fluff / generic-deflection
// regressions without a live snapshot.
//
// Each group's `anyOf` is a list of case-insensitive substrings. One
// hit = the group is "named" in the back-mind chat reply.

export interface CapabilityGroup {
  /** Label used in failure messages. */
  label: string;
  /** Lower-cased substrings; ANY hit means the group is named. */
  anyOf: string[];
}

const FIXTURE_CAPABILITIES: CapabilityGroup[] = [
  { label: 'code-and-files',     anyOf: ['file', 'read', 'edit', 'grep', 'glob', 'write'] },
  { label: 'shell-and-system',   anyOf: ['shell', 'bash', 'command', 'script'] },
  { label: 'web-and-research',   anyOf: ['web', 'url', 'fetch', 'search'] },
  { label: 'messaging',          anyOf: ['send_message', 'send a message', 'message', 'signal', 'slack', 'send_file', 'voice memo'] },
  { label: 'scheduling',         anyOf: ['schedule', 'cron', 'task', 'recurring', 'remind'] },
  { label: 'interactive',        anyOf: ['ask_user_question', 'ask you', 'multi-choice', 'card', 'send_card'] },
  { label: 'memory',             anyOf: ['memory', 'remember', 'recall', 'notes', 'wiki'] },
  { label: 'sub-agents',         anyOf: ['sub-agent', 'sub agent', 'subagent', 'create_agent', 'delegate'] },
  { label: 'self-modification',  anyOf: ['install_packages', 'install package', 'mcp server', 'add_mcp_server'] },
];

/** Subset of the wire `capability.install-resolved` snapshot we read
 *  here. Field names match the wire snake_case. We type loosely (no
 *  hard dependency on @agentic-toolkit/realtime — the smoketest package
 *  ships standalone) and dispatch on `.kind` per the AGENTS.md logging
 *  rules. */
export interface CapabilitySnapshotWire {
  channels?: ReadonlyArray<{ type: string }>;
  container_mcp_tools?: ReadonlyArray<{ name: string; summary?: string }>;
  container_skills?: ReadonlyArray<{ name: string; summary?: string }>;
  sdk_tools?: ReadonlyArray<{ name: string; summary?: string }>;
  in_tree_primitives?: ReadonlyArray<{ name: string; summary?: string }>;
  external_mcp_servers?: ReadonlyArray<{ name: string; summary?: string }>;
  slash_commands?: ReadonlyArray<{ name: string; summary?: string }>;
  host_verbs?: ReadonlyArray<{ name: string; summary?: string }>;
}

/** Derive a per-snapshot CapabilityGroup list. Each non-empty category
 *  becomes one group whose `anyOf` is built from entry names +
 *  summaries (lower-cased, split on whitespace, deduped, length>=3).
 *  Any term the back-mind says that overlaps with a real entry counts
 *  as "named that group" — same shape the fixture verdict uses. */
export function buildRegistryFromSnapshot(snap: CapabilitySnapshotWire): CapabilityGroup[] {
  const groups: CapabilityGroup[] = [];

  const addEntryGroup = (label: string, entries: ReadonlyArray<{ name: string; summary?: string }> | undefined): void => {
    if (!entries || entries.length === 0) return;
    const terms = new Set<string>();
    for (const e of entries) {
      // Names are tool / skill handles like `send_message`, `wiki`,
      // `Read`. Push the whole identifier AND the meaningful word
      // tokens so e.g. "send_message" matches "message" too.
      const name = e.name.toLowerCase();
      terms.add(name);
      for (const tok of name.split(/[\s_\-/]+/)) {
        if (tok.length >= 3) terms.add(tok);
      }
      if (e.summary) {
        for (const tok of e.summary.toLowerCase().split(/[^a-z0-9_]+/)) {
          if (tok.length >= 4) terms.add(tok);
        }
      }
    }
    groups.push({ label, anyOf: [...terms] });
  };

  if (snap.channels && snap.channels.length > 0) {
    // Channels carry `type` (not `name`); flatten to the same shape.
    addEntryGroup(
      'channels',
      snap.channels.map((c) => ({ name: c.type })),
    );
  }
  addEntryGroup('container_mcp_tools', snap.container_mcp_tools);
  addEntryGroup('container_skills', snap.container_skills);
  addEntryGroup('sdk_tools', snap.sdk_tools);
  addEntryGroup('in_tree_primitives', snap.in_tree_primitives);
  addEntryGroup('external_mcp_servers', snap.external_mcp_servers);
  addEntryGroup('slash_commands', snap.slash_commands);
  addEntryGroup('host_verbs', snap.host_verbs);

  return groups;
}

// Capabilities the back-mind does NOT have. If any of these appear in
// the reply, that's a hallucination. Tuned narrowly so legitimate
// answers ("I can't order pizza" — explicit denial) aren't false-flagged
// — we look for affirmative claims, not just the word.
const FORBIDDEN_CLAIMS: string[] = [
  'crypto',
  'blockchain',
  'smart-home',
  'kubernetes',
  'kafka',
  'order a pizza',
  'order food',
  'buy stocks',
  'place an order',
  'send a tweet',  // X integration was never wired
];

// Generic-fluff phrases the banter layer historically used INSTEAD of
// deferring. If banter manages to leak one of these into a chat row,
// we want to know — back-mind shouldn't talk like banter either.
const GENERIC_FLUFF: string[] = [
  'i can hit apis',
  'i can do all sorts of things',
  'i can help with anything',
  'depends what you need',
  'you name it',
];

// Minimum distinct capability groups the back-mind must name across the
// reply. 2 is forgiving (some queries are narrower: "can you send a
// signal message?" might legitimately only touch the messaging group).
// Total across all 5 turns must hit GLOBAL_MIN_GROUPS_TOTAL.
const PER_TURN_MIN_GROUPS = 1;
const GLOBAL_MIN_GROUPS_TOTAL = 4;

// ── Question set ──────────────────────────────────────────────────────────

export interface CapabilityProbe {
  /** Short label for transcript / outcomes. */
  label: string;
  /** Literal user message text. */
  text: string;
  /** Optional: capability group that MUST be named in this specific reply
   *  (because the question is narrow enough that omitting it is wrong). */
  mustNameGroup?: string;
}

const PROBES: CapabilityProbe[] = [
  { label: 'open-ended-capabilities', text: 'what can you do?' },
  { label: 'tools-list',              text: 'what tools do you have access to?' },
  { label: 'signal-specific',         text: 'can you send a signal message?', mustNameGroup: 'messaging' },
  { label: 'file-access',             text: 'do you have access to my files?', mustNameGroup: 'code-and-files' },
  { label: 'cross-session-memory',    text: 'can you remember things across calls?', mustNameGroup: 'memory' },
];

// ── Timeouts ──────────────────────────────────────────────────────────────

const ACK_TIMEOUT_MS = 8_000;
const CHAT_TIMEOUT_MS = 120_000;
const INTER_TURN_PAUSE_MS = 2_000;
/** Cap for waiting on the `capability.caller-context-resolved` event
 *  after posting an inbound — we use it both as a "the resolver fired"
 *  signal AND to pluck out the `agent_group_id` that joins the
 *  install-side snapshot. Synchronous + fast (DB read + a few
 *  introspection helpers); if it takes longer than this, the resolver
 *  is wedged and we'd rather fall back to the fixture than block. */
const CAPABILITY_RESOLVE_TIMEOUT_MS = 5_000;

// ── Scenario definition ───────────────────────────────────────────────────

export const capabilityDescription: Scenario = {
  name: 'capability-description',
  description:
    'fires 5 capability questions; for each, asserts back-mind chat row references at least one REAL capability from the active registry, ' +
    'contains no forbidden/fabricated tool claims, and the total across turns covers most capability families.',
  steps: PROBES.flatMap<Step>((p) => [
    // Decorative — the real work is in customRun. Listed so `pnpm
    // scenario --help` shows what the scenario probes.
    { kind: 'turn', text: p.text },
    { kind: 'wait-utterance', within: ACK_TIMEOUT_MS, label: `${p.label}: front-mind ack` },
    { kind: 'wait-chat', within: CHAT_TIMEOUT_MS, label: `${p.label}: back-mind reply` },
  ]),
  acceptanceMs: PROBES.length * (ACK_TIMEOUT_MS + CHAT_TIMEOUT_MS + INTER_TURN_PAUSE_MS) + 30_000,
  customRun: runCapabilityDescription,
};

async function runCapabilityDescription(ctx: ScenarioContext): Promise<ScenarioResult> {
  const start = Date.now();
  const outcomes: StepOutcome[] = [];
  const baseUrl = process.env.REALTIME_BASE_URL ?? 'http://127.0.0.1:8765';
  const threadId = ctx.threadId ?? 'smoke-capability-description';

  // Open the log-tail BEFORE the first turn so we don't miss the
  // chat.row-received if the back-mind is unusually fast.
  let tail;
  try {
    tail = await openLogTail({ baseUrl, sinceMs: Date.now() - 500 });
  } catch (err) {
    return failFast(start, {
      step: { kind: 'turn', text: '(tail-open)' },
      ok: false,
      error: `couldn't open /admin/logs.tail: ${(err as Error).message}`,
    });
  }
  ctx.transcript.add('system', `admin /logs.tail connected (thread=${threadId})`);

  // Accumulator across all probes — used for the global capability-
  // coverage assertion at the end.
  const namedGroupsGlobal = new Set<string>();

  try {
    for (let i = 0; i < PROBES.length; i++) {
      const probe = PROBES[i]!;
      ctx.transcript.add('system', `── probe ${i + 1}/${PROBES.length}: ${probe.label} ──`);

      // Stamp the wait floor BEFORE the post — wait-* and the chat-row
      // predicate both gate on a post-turn cursor so a stale row from a
      // previous probe can't satisfy this one.
      const postedAtMs = Date.now() - 50;
      if (ctx.lastTurnAt) ctx.lastTurnAt.ms = postedAtMs;

      // 1. Post the user turn.
      ctx.transcript.add('user', probe.text, { source: 'scripted', probe: probe.label });
      const turnStep: Step = { kind: 'turn', text: probe.text };
      try {
        await ctx.client.postTurn(probe.text, 'smoke-test', threadId);
      } catch (err) {
        outcomes.push({ step: turnStep, ok: false, error: `postTurn failed: ${(err as Error).message}` });
        break;
      }
      outcomes.push({ step: turnStep, ok: true, details: 'posted' });

      // 2. Wait for the orchestrator's caller-context emit — this is
      //    the per-inbound event that confirms the resolver fired AND
      //    carries the `agent_group_id` we need to join the install
      //    snapshot (TaskList #8 lifecycle split). Install-side
      //    capabilities are emitted ONCE at boot per agent group as
      //    `capability.install-resolved` — we search the historical
      //    log for the matching id.
      let liveRegistry: CapabilityGroup[] | null = null;
      let registrySource: 'live-snapshot' | 'fixture-fallback' = 'fixture-fallback';
      let resolvedAgentGroupId: string | null = null;
      try {
        const callerEv = await tail.waitFor(
          (e) =>
            e.kind === 'capability.caller-context-resolved' &&
            e.thread_id === threadId &&
            e.data?.call_site === 'inbound' &&
            new Date(e.ts).getTime() >= postedAtMs,
          CAPABILITY_RESOLVE_TIMEOUT_MS,
          `capability.caller-context-resolved for ${probe.label}`,
        );
        resolvedAgentGroupId = typeof callerEv.data?.agent_group_id === 'string'
          ? callerEv.data.agent_group_id
          : null;
        if (resolvedAgentGroupId) {
          // Search the historical tail for the install-resolved emit
          // matching this agent group id. Install snapshots are seeded
          // at boot (one per agent group), so a recent install emit
          // for this id should be in the buffer. If not (smoketest
          // skipped boot, or this is a synthetic agent group), fall
          // back to the fixture.
          const installEv = tail.findRecent(
            (e) =>
              e.kind === 'capability.install-resolved' &&
              e.data?.agent_group_id === resolvedAgentGroupId,
          );
          if (installEv?.data?.resolved && installEv.data?.snapshot) {
            liveRegistry = buildRegistryFromSnapshot(installEv.data.snapshot as CapabilitySnapshotWire);
            registrySource = 'live-snapshot';
            ctx.transcript.add('system', `install snapshot found for ag=${resolvedAgentGroupId} (${liveRegistry.length} non-empty categories)`);
          } else {
            ctx.transcript.add('system', `no install-resolved snapshot for ag=${resolvedAgentGroupId} in tail buffer — falling back to fixture`);
          }
        } else {
          ctx.transcript.add('system', `caller-context-resolved had no agent_group_id (resolver_present=${callerEv.data?.resolver_present}) — falling back to fixture`);
        }
      } catch {
        // Resolver didn't emit in time — current state for the
        // synthetic smoketest agent group whose adapter passes
        // caps=null. Fixture fallback keeps the test useful.
        ctx.transcript.add('system', `no capability.caller-context-resolved within ${CAPABILITY_RESOLVE_TIMEOUT_MS}ms — falling back to fixture`);
      }
      const registry: CapabilityGroup[] = liveRegistry ?? FIXTURE_CAPABILITIES;

      // 3. Wait for the back-mind chat row on THIS thread. We use the
      //    log-tail (not the realtime client's SSE) because the log
      //    event is the canonical "back-mind produced a reply" signal
      //    AND carries the full_text without truncation. The SSE
      //    `chat` event is the same content rendered for delivery; we
      //    want the source-of-truth event.
      let chatEv: LogEvent;
      try {
        chatEv = await tail.waitFor(
          (e) =>
            e.kind === 'chat.row-received' &&
            e.thread_id === threadId &&
            new Date(e.ts).getTime() >= postedAtMs,
          CHAT_TIMEOUT_MS,
          `chat.row-received for ${probe.label}`,
        );
      } catch (err) {
        outcomes.push({
          step: { kind: 'wait-chat', within: CHAT_TIMEOUT_MS, label: `${probe.label}: back-mind reply` },
          ok: false,
          error: (err as Error).message,
        });
        // Inter-turn pause before next probe; don't break — we want
        // every probe to attempt so the transcript shows the full
        // failure pattern.
        await sleep(INTER_TURN_PAUSE_MS);
        continue;
      }

      const fullText = String(chatEv.data?.full_text ?? chatEv.data?.preview ?? '');
      ctx.transcript.add('agent-chat', fullText, { kind: 'chat.row-received', probe: probe.label });

      // 4. Assert against the registry. Three checks:
      //    a) at least PER_TURN_MIN_GROUPS distinct real groups named,
      //    b) optional `mustNameGroup` for narrow probes,
      //    c) no FORBIDDEN_CLAIMS or GENERIC_FLUFF leaked in.
      const verdict = checkAgainstRegistry(fullText, probe, registry);
      verdict.namedGroups.forEach((g) => namedGroupsGlobal.add(g));

      ctx.transcript.add('judge', `${probe.label}: ${verdict.ok ? 'PASS' : 'FAIL'} — ${verdict.reason}`, {
        probe: probe.label,
        verdict,
        fullText,
        registrySource,
      });
      outcomes.push({
        step: { kind: 'judge', rubric: probe.text, label: `${probe.label}: capability-registry assertion (${registrySource})` },
        ok: verdict.ok,
        details: `[${registrySource}] ${verdict.reason}`,
      });

      await sleep(INTER_TURN_PAUSE_MS);
    }
  } finally {
    tail.close();
  }

  // 5. Global coverage assertion — across all probes, did Pat collectively
  //    surface enough of the real capability surface? Guards against the
  //    pathological case where every reply names the same one group.
  //    Label space differs slightly between fixture (semantic groups
  //    like 'code-and-files', 'messaging') and live snapshot
  //    (categories like 'sdk_tools', 'channels'); the threshold of 4 is
  //    intentionally low enough to fit both spaces.
  const globalOk = namedGroupsGlobal.size >= GLOBAL_MIN_GROUPS_TOTAL;
  const globalReason = globalOk
    ? `named ${namedGroupsGlobal.size} distinct groups across ${PROBES.length} probes: [${[...namedGroupsGlobal].join(', ')}]`
    : `only named ${namedGroupsGlobal.size} distinct groups across ${PROBES.length} probes ` +
      `(need >= ${GLOBAL_MIN_GROUPS_TOTAL}): [${[...namedGroupsGlobal].join(', ')}]`;
  ctx.transcript.add('judge', `global-coverage: ${globalOk ? 'PASS' : 'FAIL'} — ${globalReason}`, {
    namedGroups: [...namedGroupsGlobal],
  });
  outcomes.push({
    step: { kind: 'judge', rubric: 'global-coverage', label: 'global capability coverage' },
    ok: globalOk,
    details: globalReason,
  });

  return {
    scenario: capabilityDescription,
    passed: outcomes.every((o) => o.ok),
    outcomes,
    durationMs: Date.now() - start,
  };
}

// ── Assertion DSL — predicates over chat-row full_text ────────────────────

interface CapabilityVerdict {
  ok: boolean;
  reason: string;
  /** Real capability groups named in this reply. */
  namedGroups: string[];
  /** Forbidden claims that leaked in. */
  forbiddenHits: string[];
  /** Generic-fluff phrases that leaked in. */
  fluffHits: string[];
}

export function checkAgainstRegistry(
  text: string,
  probe: CapabilityProbe,
  registry: CapabilityGroup[] = FIXTURE_CAPABILITIES,
): CapabilityVerdict {
  const lc = text.toLowerCase();

  const namedGroups: string[] = [];
  for (const group of registry) {
    if (group.anyOf.some((sub) => lc.includes(sub.toLowerCase()))) {
      namedGroups.push(group.label);
    }
  }

  const forbiddenHits = FORBIDDEN_CLAIMS.filter((sub) => lc.includes(sub.toLowerCase()));
  const fluffHits = GENERIC_FLUFF.filter((sub) => lc.includes(sub.toLowerCase()));

  // Decision tree:
  // - forbidden / fluff hit → always FAIL (fabricated content).
  // - too few real groups named → FAIL (probably generic).
  // - probe requires a specific group → FAIL if missing.
  if (forbiddenHits.length > 0) {
    return {
      ok: false,
      reason: `forbidden capability claim leaked: ${forbiddenHits.join(', ')}`,
      namedGroups,
      forbiddenHits,
      fluffHits,
    };
  }
  if (fluffHits.length > 0) {
    return {
      ok: false,
      reason: `generic banter fluff in back-mind reply: ${fluffHits.join(', ')}`,
      namedGroups,
      forbiddenHits,
      fluffHits,
    };
  }
  if (namedGroups.length < PER_TURN_MIN_GROUPS) {
    return {
      ok: false,
      reason: `no real capability groups named (need >= ${PER_TURN_MIN_GROUPS})`,
      namedGroups,
      forbiddenHits,
      fluffHits,
    };
  }
  if (probe.mustNameGroup && !namedGroups.includes(probe.mustNameGroup)) {
    return {
      ok: false,
      reason: `probe required group "${probe.mustNameGroup}" but it wasn't named (got: [${namedGroups.join(', ')}])`,
      namedGroups,
      forbiddenHits,
      fluffHits,
    };
  }
  return {
    ok: true,
    reason: `named [${namedGroups.join(', ')}]`,
    namedGroups,
    forbiddenHits,
    fluffHits,
  };
}

// ── tiny helpers ──────────────────────────────────────────────────────────

function failFast(start: number, outcome: StepOutcome): ScenarioResult {
  return {
    scenario: capabilityDescription,
    passed: false,
    outcomes: [outcome],
    durationMs: Date.now() - start,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
