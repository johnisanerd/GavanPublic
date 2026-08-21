/**
 * Unit coverage for the assertion DSL in capability-description.scenario.ts.
 *
 * The scenario itself needs a running NanoClaw to drive — these tests
 * cover only the registry-matching logic so we can be confident the
 * predicates fail loud on the exact failure modes the scenario is
 * supposed to catch (banter fluff in chat row, fabricated tool claims,
 * generic deflection).
 */
import { describe, expect, it } from 'vitest';

import {
  buildRegistryFromSnapshot,
  checkAgainstRegistry,
  type CapabilityProbe,
  type CapabilitySnapshotWire,
} from './capability-description.scenario.js';

const openProbe: CapabilityProbe = { label: 'open-ended', text: 'what can you do?' };
const signalProbe: CapabilityProbe = {
  label: 'signal',
  text: 'can you send a signal message?',
  mustNameGroup: 'messaging',
};
const filesProbe: CapabilityProbe = {
  label: 'files',
  text: 'do you have access to my files?',
  mustNameGroup: 'code-and-files',
};

describe('checkAgainstRegistry', () => {
  it('passes when reply names a real capability family', () => {
    const reply =
      "Yeah, I can read and edit files, run bash commands, and search the web. " +
      "Also send messages on Signal and Slack.";
    const v = checkAgainstRegistry(reply, openProbe);
    expect(v.ok).toBe(true);
    expect(v.namedGroups).toEqual(
      expect.arrayContaining(['code-and-files', 'shell-and-system', 'web-and-research', 'messaging']),
    );
    expect(v.forbiddenHits).toEqual([]);
    expect(v.fluffHits).toEqual([]);
  });

  it('catches the historical banter-fluff regression', () => {
    // Verbatim phrase from the bug (sprint/backlog.md "Banter answers
    // capability/tool questions itself instead of deferring"):
    //   "Yeah, I've got tool calls too — so I can hit APIs, run searches,
    //    that kind of thing. Depends what you need."
    const reply = "Yeah, I've got tool calls too — so I can hit APIs, run searches, that kind of thing. Depends what you need.";
    const v = checkAgainstRegistry(reply, openProbe);
    expect(v.ok).toBe(false);
    expect(v.fluffHits.length).toBeGreaterThan(0);
    // The reason should explicitly mention banter fluff so it's
    // diagnosable from the test output alone.
    expect(v.reason).toMatch(/fluff/i);
  });

  it('catches fabricated infra claims (kubernetes / blockchain etc)', () => {
    const reply =
      "I run on Kubernetes and Kafka, with a blockchain memory store. " +
      "I can also read files and search the web.";
    const v = checkAgainstRegistry(reply, openProbe);
    expect(v.ok).toBe(false);
    expect(v.forbiddenHits).toEqual(expect.arrayContaining(['kubernetes', 'kafka', 'blockchain']));
  });

  it('catches replies that name zero real groups', () => {
    const reply = "I'm an AI assistant. I can help you with various things.";
    const v = checkAgainstRegistry(reply, openProbe);
    expect(v.ok).toBe(false);
    expect(v.namedGroups).toEqual([]);
    expect(v.reason).toMatch(/no real capability/i);
  });

  it('enforces probe-specific required group (signal → messaging)', () => {
    // Reply technically lists a real capability (code-and-files), but
    // it dodges the question about Signal entirely — that's a fail.
    const reply = "I can edit files and run bash commands.";
    const v = checkAgainstRegistry(reply, signalProbe);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/messaging/);
  });

  it("passes the signal probe when 'send_message' / 'signal' is named", () => {
    const reply = "Yeah, I can use send_message to ping Signal numbers — what should the message say?";
    const v = checkAgainstRegistry(reply, signalProbe);
    expect(v.ok).toBe(true);
    expect(v.namedGroups).toContain('messaging');
  });

  it("passes the files probe when 'read' / 'file' is named", () => {
    const reply = "Yes — I can read and edit files in your workspace.";
    const v = checkAgainstRegistry(reply, filesProbe);
    expect(v.ok).toBe(true);
    expect(v.namedGroups).toContain('code-and-files');
  });

  it('forbidden-claim check trumps real-capability hits', () => {
    // Mentions real capabilities AND a forbidden one — should still fail.
    const reply = "I can edit files, search the web, and place an order for you on DoorDash.";
    const v = checkAgainstRegistry(reply, openProbe);
    expect(v.ok).toBe(false);
    expect(v.forbiddenHits).toContain('place an order');
  });
});

describe('buildRegistryFromSnapshot', () => {
  it('builds one CapabilityGroup per non-empty wire category', () => {
    const snap: CapabilitySnapshotWire = {
      channels: [{ type: 'signal' }, { type: 'phone-call' }],
      container_mcp_tools: [
        { name: 'send_message', summary: 'send a message to a channel or contact' },
        { name: 'schedule_task' },
      ],
      sdk_tools: [{ name: 'Read' }, { name: 'Bash' }],
    };
    const groups = buildRegistryFromSnapshot(snap);
    const labels = groups.map((g) => g.label);
    expect(labels).toEqual(expect.arrayContaining(['channels', 'container_mcp_tools', 'sdk_tools']));
    // Empty categories are dropped.
    expect(labels).not.toContain('container_skills');
    expect(labels).not.toContain('external_mcp_servers');
  });

  it('verdict against a live snapshot matches the back-mind chat row', () => {
    const snap: CapabilitySnapshotWire = {
      channels: [{ type: 'signal' }],
      container_mcp_tools: [
        { name: 'send_message', summary: 'send a message to a contact' },
      ],
      sdk_tools: [{ name: 'Read' }, { name: 'Bash' }],
    };
    const registry = buildRegistryFromSnapshot(snap);
    const reply = 'I can send_message on Signal, and use Read or Bash on the workspace.';
    const v = checkAgainstRegistry(reply, { label: 'open', text: 'what can you do?' }, registry);
    expect(v.ok).toBe(true);
    expect(v.namedGroups).toEqual(expect.arrayContaining(['channels', 'container_mcp_tools', 'sdk_tools']));
  });

  it('returns empty registry when snapshot has no non-empty categories', () => {
    expect(buildRegistryFromSnapshot({})).toEqual([]);
    expect(buildRegistryFromSnapshot({ channels: [] })).toEqual([]);
  });
});
