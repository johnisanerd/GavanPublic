import type { Scenario, SmokeChannel, SmokeTier } from './index.js';
import { baseline } from './baseline.js';
import { bargeIn } from './barge-in.js';
import { bargeInCancel } from './barge-in-cancel.js';
import { bargeInNewTask } from './barge-in-new-task.js';
import { bargeInRefine } from './barge-in-refine.js';
import { topicSwitch } from './topic-switch.js';
import { taskStack } from './task-stack.js';
import { ambiguity } from './ambiguity.js';
import { installFailureRecovery } from './install-failure-recovery.js';
import { multiPartRendition } from './multi-part-rendition.js';
import { outboundColdDispatch } from './outbound-cold-dispatch.js';
import { selfKnowledgeArchitecture } from './self-knowledge-architecture.js';
import { capabilityDescription } from './capability-description.scenario.js';
import { signalProdInbound } from './signal-prod-inbound.scenario.js';
import { signalPublish } from './signal-publish.scenario.js';
import { signalVoiceMemo } from './signal-voice-memo.scenario.js';
import { signalAttachment } from './signal-attachment.scenario.js';
import { signalSimOutbound } from './signal-sim-outbound.scenario.js';
import { publishFile } from './publish-file.scenario.js';
import { callBaseline } from './call-baseline.scenario.js';

export const SCENARIOS: Record<string, Scenario> = {
  baseline,
  'barge-in': bargeIn,
  'barge-in-cancel': bargeInCancel,
  'barge-in-refine': bargeInRefine,
  'barge-in-new-task': bargeInNewTask,
  'topic-switch': topicSwitch,
  'task-stack': taskStack,
  'ambiguity': ambiguity,
  'install-failure-recovery': installFailureRecovery,
  'multi-part-rendition': multiPartRendition,
  'outbound-cold-dispatch': outboundColdDispatch,
  'self-knowledge-architecture': selfKnowledgeArchitecture,
  'capability-description': capabilityDescription,
  'signal-prod-inbound': signalProdInbound,
  'signal-publish': signalPublish,
  'signal-voice-memo': signalVoiceMemo,
  'signal-attachment': signalAttachment,
  'signal-sim-outbound': signalSimOutbound,
  'publish-file': publishFile,
  'call-baseline': callBaseline,
};

/**
 * Selection catalog: scenario name → { sid, channel, tiers }. This is the
 * matrix the runner selects over (`--channel`, `--level`, or explicit SID).
 * One glance shows the whole coverage grid; a new scenario adds one line.
 *
 * sid = stable short test ID (R#=rest, C#=call, S#=signal). `tiers` controls
 * whether `--level quick|thorough` picks it up; `[]` = selectable only by
 * explicit name/SID (e.g. prod-only or heavy scenarios). Scenarios absent
 * from this map default to { channel:'rest', tiers:['thorough'] }, no sid.
 */
export interface ScenarioMeta {
  sid: string;
  channel: SmokeChannel;
  tiers: SmokeTier[];
}

const SCENARIO_META: Record<string, ScenarioMeta> = {
  // rest (realtime text)
  baseline: { sid: 'R1', channel: 'rest', tiers: ['quick', 'thorough'] },
  'publish-file': { sid: 'R2', channel: 'rest', tiers: ['thorough'] },
  'barge-in': { sid: 'R3', channel: 'rest', tiers: ['thorough'] },
  'barge-in-cancel': { sid: 'R3c', channel: 'rest', tiers: ['thorough'] },
  'barge-in-refine': { sid: 'R3r', channel: 'rest', tiers: ['thorough'] },
  'barge-in-new-task': { sid: 'R3n', channel: 'rest', tiers: ['thorough'] },
  'topic-switch': { sid: 'R3t', channel: 'rest', tiers: ['thorough'] },
  'capability-description': { sid: 'R4', channel: 'rest', tiers: ['thorough'] },
  'install-failure-recovery': { sid: 'R8', channel: 'rest', tiers: ['thorough'] },
  'self-knowledge-architecture': { sid: 'R9', channel: 'rest', tiers: ['thorough'] },
  'outbound-cold-dispatch': { sid: 'R10', channel: 'rest', tiers: [] }, // needs --channel-probe
  'task-stack': { sid: 'R13', channel: 'rest', tiers: ['thorough'] },
  ambiguity: { sid: 'R14', channel: 'rest', tiers: ['thorough'] },
  'multi-part-rendition': { sid: 'R15', channel: 'rest', tiers: ['thorough'] },
  // call (real Cartesia voice)
  'call-baseline': { sid: 'C1', channel: 'call', tiers: ['quick', 'thorough'] },
  // signal (rig → PAT). Feature scenarios run against STAGING and assert on
  // the rig's WS view of PAT's outbound. signal-prod-inbound is prod-targeted,
  // name/SID-only.
  'signal-prod-inbound': { sid: 'S1prod', channel: 'signal', tiers: [] },
  // S3/S4/S6 assert on the real signal-cli rig, currently BLOCKED by the rig
  // B2B decrypt desync (see KNOWN_ISSUES). SID/name-only until the rig burner
  // is re-registered — kept so they're runnable the moment it's fixed.
  'signal-publish': { sid: 'S3', channel: 'signal', tiers: [] },
  'signal-voice-memo': { sid: 'S4', channel: 'signal', tiers: [] },
  'signal-attachment': { sid: 'S6', channel: 'signal', tiers: [] },
  // SS1 — the WORKING Signal-feature coverage via the simulated capture
  // transport (PAT_TEST_OUTBOUND_ADAPTER=1). Drives realtime /inbound (needs
  // the rest tunnel), so it's bucketed under `rest` for transport selection.
  'signal-sim-outbound': { sid: 'SS1', channel: 'rest', tiers: ['thorough'] },
};

const DEFAULT_META: Omit<ScenarioMeta, 'sid'> = { channel: 'rest', tiers: ['thorough'] };

/** Attach sid/channel/tiers onto the scenario objects from SCENARIO_META. */
for (const [name, s] of Object.entries(SCENARIOS)) {
  const m = SCENARIO_META[name];
  s.sid = m?.sid;
  s.channel = m?.channel ?? DEFAULT_META.channel;
  s.tiers = m?.tiers ?? DEFAULT_META.tiers;
}

export function getScenario(name: string): Scenario | null {
  return SCENARIOS[name] ?? null;
}

export function allScenarios(): Scenario[] {
  return Object.values(SCENARIOS);
}

/** Resolve a token to a scenario by exact name OR sid (case-insensitive sid). */
export function resolveScenario(token: string): Scenario | null {
  if (SCENARIOS[token]) return SCENARIOS[token];
  const lc = token.toLowerCase();
  return allScenarios().find((s) => s.sid?.toLowerCase() === lc) ?? null;
}

export interface SelectOpts {
  /** Restrict to these channels. Undefined/empty = all channels. */
  channels?: SmokeChannel[];
  /** Tier to include. Undefined = 'quick'. A scenario matches if its tiers
   *  array includes this value. */
  tier?: SmokeTier;
  /** Explicit names/SIDs — when non-empty, overrides channel/tier and runs
   *  exactly these (any order, matched by name or sid). */
  ids?: string[];
}

/**
 * Named suites — the `--suite=<name>` selection layer over channel+tier.
 * Suites carry the transport, so `--suite=call-thorough` implies the Cartesia
 * WS without a separate flag. `quick`/`thorough` are cross-channel unions.
 * `/pat-smoke` maps operator intent → a suite name rather than hand-listing
 * scenarios. A suite that resolves to zero scenarios (e.g. signal-* while the
 * rig transport is parked) is a valid, honest empty run — surfaced by the CLI.
 */
export const SUITES: Record<string, SelectOpts> = {
  'rest-quick': { channels: ['rest'], tier: 'quick' },
  'rest-thorough': { channels: ['rest'], tier: 'thorough' },
  'call-quick': { channels: ['call'], tier: 'quick' },
  'call-thorough': { channels: ['call'], tier: 'thorough' },
  'signal-quick': { channels: ['signal'], tier: 'quick' },
  'signal-thorough': { channels: ['signal'], tier: 'thorough' },
  quick: { tier: 'quick' }, // all channels, quick pulse
  thorough: { tier: 'thorough' }, // all channels, full feature set
};

export function suiteNames(): string[] {
  return Object.keys(SUITES);
}

/** Resolve a suite name to its scenarios (throws on unknown name). */
export function selectSuite(name: string): Scenario[] {
  const opts = SUITES[name];
  if (!opts) throw new Error(`unknown suite: ${name} (available: ${suiteNames().join(', ')})`);
  return selectScenarios(opts);
}

/** The core selector the CLI + skill use. */
export function selectScenarios(opts: SelectOpts): Scenario[] {
  if (opts.ids && opts.ids.length > 0) {
    return opts.ids.map((t) => {
      const s = resolveScenario(t);
      if (!s) throw new Error(`unknown scenario name/sid: ${t}`);
      return s;
    });
  }
  const tier: SmokeTier = opts.tier ?? 'quick';
  const channels = opts.channels && opts.channels.length > 0 ? new Set(opts.channels) : null;
  return allScenarios().filter(
    (s) => (!channels || channels.has(s.channel ?? 'rest')) && (s.tiers ?? []).includes(tier),
  );
}
