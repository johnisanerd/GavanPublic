/**
 * Unit tests for `_capability-context.ts` — the renderers are pure and
 * deterministic, so we lock the markdown output for the common shapes.
 * Catches drift if anyone tweaks the format without thinking through
 * the prompt impact.
 *
 * Lifecycle split (TaskList #8): install-side renderer +
 * `setInstallCapabilities` cache; caller-side renderer; agent-group
 * keyed lookup via `getInstallCapabilitiesBlock`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  clearInstallCapabilities,
  getInstallCapabilities,
  getInstallCapabilitiesBlock,
  listRegisteredAgentGroups,
  renderCallerContext,
  renderInstallCapabilities,
  setInstallCapabilities,
  stubInstallCapabilitiesBlock,
  type CallerContext,
  type CallerIdentity,
  type CapabilityEntry,
  type ChannelCapability,
  type InstallCapabilities,
  type KnownHandle,
  type PermissionsSurface,
} from './_capability-context.js';

afterEach(() => {
  // Tests share the process-local install cache; reset between cases.
  clearInstallCapabilities();
});

describe('renderInstallCapabilities', () => {
  it('renders the agent group name + id when supplied', () => {
    const snap: InstallCapabilities = {
      agentGroupId: 'ag-abc-123',
      agentGroupName: 'palisade-internal',
    };
    const out = renderInstallCapabilities(snap);
    expect(out).toContain('<capabilities>');
    expect(out).toContain('agent_group_name: palisade-internal');
    expect(out).toContain('agent_group_id: ag-abc-123');
    expect(out).toContain('</capabilities>');
  });

  it('renders channels with their supported message shapes', () => {
    const channels: ChannelCapability[] = [
      { type: 'phone-call', shapes: ['text'] },
      { type: 'signal', shapes: ['text', 'file', 'voice-memo', 'reaction'] },
      { type: 'anam-web', shapes: ['text', 'card'] },
      { type: 'slack' }, // no shapes — still rendered
    ];
    const out = renderInstallCapabilities({ channels });
    expect(out).toContain('<channels>');
    expect(out).toContain('- **phone-call** (text)');
    expect(out).toContain('- **signal** (text, file, voice-memo, reaction)');
    expect(out).toContain('- **anam-web** (text, card)');
    expect(out).toContain('- **slack**');
    expect(out).toContain('</channels>');
  });

  it('renders capability categories with name + summary + flags', () => {
    const tools: CapabilityEntry[] = [
      { name: 'send_message', summary: 'Send text to a configured destination' },
      { name: 'install_packages', summary: 'Install apt/npm deps', flags: ['admin-only', 'approval-gated'] },
      { name: 'send_voice_memo' }, // no summary, no flags
    ];
    const out = renderInstallCapabilities({ containerMcpTools: tools });
    expect(out).toContain('<container_mcp_tools>');
    expect(out).toContain('- **send_message** — Send text to a configured destination');
    expect(out).toContain(
      '- **install_packages** — Install apt/npm deps *[admin-only, approval-gated]*',
    );
    expect(out).toContain('- **send_voice_memo**');
    expect(out).toContain('</container_mcp_tools>');
  });

  it('omits a category tag entirely when the list is empty', () => {
    const out = renderInstallCapabilities({
      containerMcpTools: [],
      containerSkills: [{ name: 'wiki' }],
    });
    expect(out).not.toContain('<container_mcp_tools>');
    expect(out).toContain('<container_skills>');
    expect(out).toContain('- **wiki**');
  });

  it('renders install-side categories in declared order when populated', () => {
    const snap: InstallCapabilities = {
      agentGroupName: 'Pat',
      channels: [{ type: 'signal' }],
      containerMcpTools: [{ name: 'send_message' }],
      containerSkills: [{ name: 'wiki' }],
      sdkTools: [{ name: 'Read' }],
      inTreePrimitives: [{ name: 'agent-browser' }],
      externalMcpServers: [{ name: 'apify' }],
      hostVerbs: [{ name: 'barge-in' }],
    };
    const out = renderInstallCapabilities(snap);
    const idx = (tag: string) => out.indexOf(`\n<${tag}>`);
    expect(idx('channels')).toBeGreaterThan(-1);
    expect(idx('container_mcp_tools')).toBeGreaterThan(idx('channels'));
    expect(idx('container_skills')).toBeGreaterThan(idx('container_mcp_tools'));
    expect(idx('sdk_tools')).toBeGreaterThan(idx('container_skills'));
    expect(idx('in_tree_primitives')).toBeGreaterThan(idx('sdk_tools'));
    expect(idx('external_mcp_servers')).toBeGreaterThan(idx('in_tree_primitives'));
    expect(idx('host_verbs')).toBeGreaterThan(idx('external_mcp_servers'));
    // slash_commands deliberately omitted — front-mind never uses them.
    expect(out).not.toContain('<slash_commands>');
  });

  it('does NOT include caller-side blocks (those live in renderCallerContext)', () => {
    const out = renderInstallCapabilities({
      agentGroupName: 'Pat',
      channels: [{ type: 'signal' }],
    });
    // The install block deliberately omits <caller>, <known_handles>,
    // <permissions> — those land in the USER message via
    // renderCallerContext so the SYSTEM prompt stays stable across
    // inbounds (Anthropic prompt cache).
    expect(out).not.toContain('<caller>');
    expect(out).not.toContain('<known_handles>');
    expect(out).not.toContain('<permissions>');
  });

  it('is deterministic — same input renders byte-identical output', () => {
    const snap: InstallCapabilities = {
      agentGroupName: 'Pat',
      containerMcpTools: [{ name: 'send_message' }],
    };
    expect(renderInstallCapabilities(snap)).toBe(renderInstallCapabilities(snap));
  });
});

describe('renderCallerContext', () => {
  it('emits a stub block when ctx is null', () => {
    const out = renderCallerContext(null);
    expect(out).toContain('<caller_context>');
    expect(out).toContain('no live caller context threaded');
    expect(out).toContain('</caller_context>');
  });

  it('renders the always-present caller block with all fields', () => {
    const caller: CallerIdentity = {
      platformId: 'pstn:+15550100000',
      channelType: 'phone-call',
      displayName: 'Gavan',
      role: 'owner',
      suffix: '4959',
    };
    const out = renderCallerContext({ caller });
    expect(out).toContain('<caller>');
    expect(out).toContain('platform_id: pstn:+15550100000');
    expect(out).toContain('channel: phone-call');
    expect(out).toContain('display_name: Gavan');
    expect(out).toContain('role: owner');
    expect(out).toContain('suffix: 4959');
    expect(out).toContain('</caller>');
  });

  it('skips the caller block when caller is null', () => {
    const out = renderCallerContext({ caller: null });
    // The wrapper intro paragraph mentions the tag name as
    // documentation; the actual section header lands at line-start.
    expect(out).not.toMatch(/^<caller>$/m);
  });

  it('skips optional caller fields cleanly', () => {
    const out = renderCallerContext({
      caller: {
        platformId: 'signal:+15551234567',
        channelType: 'signal',
      },
    });
    expect(out).toContain('platform_id: signal:+15551234567');
    expect(out).toContain('channel: signal');
    expect(out).not.toContain('display_name:');
    expect(out).not.toMatch(/^role:/m);
    expect(out).not.toMatch(/^suffix:/m);
  });

  it('renders known handles with suffix-formatted lines + current-caller marker', () => {
    const handles: KnownHandle[] = [
      {
        platformId: 'pstn:+15550100000',
        channelType: 'pstn',
        label: 'Gavan',
        suffix: '4959',
        isCurrentCaller: true,
      },
      {
        platformId: 'signal:+15550100000',
        channelType: 'signal',
        label: 'Gavan',
        suffix: '4959',
      },
      {
        platformId: 'signal:+15551234567',
        channelType: 'signal',
        suffix: '4567',
      },
    ];
    const out = renderCallerContext({ knownHandles: handles });
    expect(out).toContain('<known_handles>');
    expect(out).toContain('**pstn:+15550100000** ending in 4959 — Gavan (THIS CALL)');
    expect(out).toContain('**signal:+15550100000** ending in 4959 — Gavan');
    expect(out).toContain('**signal:+15551234567** ending in 4567');
    expect(out).toContain('</known_handles>');
  });

  it('skips known-handles block when list is empty', () => {
    const out = renderCallerContext({ knownHandles: [] });
    expect(out).not.toMatch(/^<known_handles>$/m);
  });

  it('renders permissions surface with role + verb lists', () => {
    const permissions: PermissionsSurface = {
      callerRole: 'admin',
      callerVerbs: ['install_packages', 'create_agent'],
      approvalGatedVerbs: ['send to cold-contact'],
    };
    const out = renderCallerContext({ permissions });
    expect(out).toContain('<permissions>');
    expect(out).toContain('caller_role: admin');
    expect(out).toContain('unlocked_verbs:');
    expect(out).toContain('  - install_packages');
    expect(out).toContain('  - create_agent');
    expect(out).toContain('approval_gated_verbs:');
    expect(out).toContain('  - send to cold-contact');
  });

  it('renders permissions with just the role when verb lists are absent', () => {
    const out = renderCallerContext({
      permissions: { callerRole: 'member' },
    });
    expect(out).toContain('caller_role: member');
    expect(out).not.toContain('unlocked_verbs:');
    expect(out).not.toContain('approval_gated_verbs:');
  });

  it('renders full demo scenario shape', () => {
    const ctx: CallerContext = {
      agentGroupId: 'ag-<redacted>',
      caller: {
        platformId: 'pstn:+15550100000',
        channelType: 'phone-call',
        displayName: 'Gavan',
        role: 'owner',
        suffix: '4959',
      },
      knownHandles: [
        {
          platformId: 'pstn:+15550100000',
          channelType: 'pstn',
          label: 'Gavan',
          suffix: '4959',
          isCurrentCaller: true,
        },
        {
          platformId: 'signal:+15550100000',
          channelType: 'signal',
          label: 'Gavan',
          suffix: '4959',
        },
      ],
      permissions: {
        callerRole: 'owner',
        callerVerbs: ['install_packages', 'create_agent', 'send to cold-contact'],
      },
    };
    const out = renderCallerContext(ctx);
    expect(out).toContain('agent_group_id: ag-<redacted>');
    expect(out).toContain('platform_id: pstn:+15550100000');
    expect(out).toContain('role: owner');
    expect(out).toContain('suffix: 4959');
    expect(out).toContain('**signal:+15550100000** ending in 4959 — Gavan');
    expect(out).toContain('caller_role: owner');
  });
});

describe('install-capabilities cache (per agent group)', () => {
  it('returns the stub block when no snapshot is registered', () => {
    const out = getInstallCapabilitiesBlock('ag-unset');
    expect(out).toBe(stubInstallCapabilitiesBlock());
  });

  it('returns the stub block when agentGroupId is null / undefined', () => {
    expect(getInstallCapabilitiesBlock(null)).toBe(stubInstallCapabilitiesBlock());
    expect(getInstallCapabilitiesBlock(undefined)).toBe(stubInstallCapabilitiesBlock());
  });

  it('caches per agent group — different ids get different blocks', () => {
    setInstallCapabilities('ag-a', { agentGroupName: 'AlphaPat', containerMcpTools: [{ name: 'send_message' }] });
    setInstallCapabilities('ag-b', { agentGroupName: 'BetaPat', containerSkills: [{ name: 'wiki' }] });

    const a = getInstallCapabilitiesBlock('ag-a');
    const b = getInstallCapabilitiesBlock('ag-b');

    expect(a).toContain('agent_group_name: AlphaPat');
    expect(a).toContain('<container_mcp_tools>');
    expect(a).not.toContain('agent_group_name: BetaPat');
    expect(a).not.toContain('<container_skills>');

    expect(b).toContain('agent_group_name: BetaPat');
    expect(b).toContain('<container_skills>');
    expect(b).not.toContain('agent_group_name: AlphaPat');
    expect(b).not.toContain('<container_mcp_tools>');
  });

  it('overwrites the cached entry when called twice for the same id', () => {
    setInstallCapabilities('ag-a', { agentGroupName: 'V1' });
    setInstallCapabilities('ag-a', { agentGroupName: 'V2' });
    expect(getInstallCapabilitiesBlock('ag-a')).toContain('agent_group_name: V2');
    expect(getInstallCapabilitiesBlock('ag-a')).not.toContain('V1');
  });

  it('exposes the raw snapshot via getInstallCapabilities', () => {
    const snap: InstallCapabilities = { agentGroupName: 'Pat', sdkTools: [{ name: 'Read' }] };
    setInstallCapabilities('ag-pat', snap);
    expect(getInstallCapabilities('ag-pat')).toBe(snap);
    expect(getInstallCapabilities('ag-other')).toBeNull();
  });

  it('listRegisteredAgentGroups returns all registered ids', () => {
    setInstallCapabilities('ag-a', { agentGroupName: 'a' });
    setInstallCapabilities('ag-b', { agentGroupName: 'b' });
    expect(new Set(listRegisteredAgentGroups())).toEqual(new Set(['ag-a', 'ag-b']));
  });

  it('clearInstallCapabilities drops a single id when supplied', () => {
    setInstallCapabilities('ag-a', { agentGroupName: 'a' });
    setInstallCapabilities('ag-b', { agentGroupName: 'b' });
    clearInstallCapabilities('ag-a');
    expect(getInstallCapabilities('ag-a')).toBeNull();
    expect(getInstallCapabilities('ag-b')).not.toBeNull();
  });

  it('clearInstallCapabilities drops everything when called without args', () => {
    setInstallCapabilities('ag-a', { agentGroupName: 'a' });
    setInstallCapabilities('ag-b', { agentGroupName: 'b' });
    clearInstallCapabilities();
    expect(listRegisteredAgentGroups()).toEqual([]);
  });
});

describe('all four front-mind prompts compose install caps into SYSTEM via render()', () => {
  // Verifiable behavior change from TaskList #8: each prompt's render()
  // looks up the cached install block via ctx.agentGroupId and places
  // it in the SYSTEM prompt — so SYSTEM stays cacheable across inbounds
  // (Anthropic prompt cache) and narration's SYSTEM gets the install
  // surface "for free" without a per-session resolver call.
  it('banter-ack render() embeds install block in SYSTEM', async () => {
    const { render } = await import('./banter-ack.js');
    setInstallCapabilities('ag-test', {
      agentGroupName: 'TestPat',
      containerMcpTools: [{ name: 'send_message', summary: 'just a marker' }],
    });
    const { system, user } = render({
      agentGroupId: 'ag-test',
      backMindState: '',
      history: '',
      userText: 'hi',
    });
    expect(system).toContain('agent_group_name: TestPat');
    expect(system).toContain('- **send_message** — just a marker');
    // And the caller-context block lives in USER (per-inbound). The
    // SYSTEM may mention the tag NAME as documentation but the actual
    // section opener (at line-start) only lands in USER.
    expect(user).toMatch(/^<caller_context>$/m);
    expect(system).not.toMatch(/^<caller_context>$/m);
  });

  it('banter-narration render() embeds install block in SYSTEM', async () => {
    const { render } = await import('./banter-narration.js');
    setInstallCapabilities('ag-test', {
      agentGroupName: 'TestPat',
      containerSkills: [{ name: 'wiki', summary: 'persistent notes' }],
    });
    const { system, user } = render({
      agentGroupId: 'ag-test',
      history: '',
      currentBackMindProgress: '- tool-pre tool="grep"',
    });
    // Narration's SYSTEM gets the install caps for free (lifecycle
    // split fix — was previously missing entirely from narration).
    expect(system).toContain('agent_group_name: TestPat');
    expect(system).toContain('- **wiki** — persistent notes');
    expect(user).toContain('<current_back_mind_progress>');
  });

  it('banter-render render() embeds install block in SYSTEM', async () => {
    const { render } = await import('./banter-render.js');
    setInstallCapabilities('ag-test', {
      agentGroupName: 'TestPat',
      sdkTools: [{ name: 'Read', summary: 'read files' }],
    });
    const { system, user } = render({
      agentGroupId: 'ag-test',
      backMindText: 'Result',
      history: '',
      backMindState: '',
    });
    expect(system).toContain('agent_group_name: TestPat');
    expect(system).toContain('- **Read** — read files');
    expect(user).toContain('<back_mind_result>');
  });

  it('request-layer render() embeds install block in SYSTEM', async () => {
    const { render } = await import('./request-layer.js');
    setInstallCapabilities('ag-test', {
      agentGroupName: 'TestPat',
      channels: [{ type: 'signal', shapes: ['text'] }],
    });
    const { system, user } = render({
      agentGroupId: 'ag-test',
      backMindState: '',
      history: '',
      isProcessing: false,
      userText: 'hi',
      banterResponse: 'hey',
    });
    expect(system).toContain('agent_group_name: TestPat');
    expect(system).toContain('- **signal** (text)');
    expect(user).toContain('<user_just_said>');
  });

  it('falls back to stub install block when agentGroupId has no cached snapshot', async () => {
    const { render } = await import('./banter-ack.js');
    const { system } = render({
      agentGroupId: 'ag-not-seeded',
      backMindState: '',
      history: '',
      userText: 'hi',
    });
    expect(system).toContain('no install capability snapshot registered');
  });

  it('falls back to stub install block when agentGroupId is null', async () => {
    const { render } = await import('./banter-ack.js');
    const { system } = render({
      agentGroupId: null,
      backMindState: '',
      history: '',
      userText: 'hi',
    });
    expect(system).toContain('no install capability snapshot registered');
  });
});
