/**
 * Capability tab routes.
 *
 * The front-mind capability list (the structured introspection A1 is
 * building per plans/one-flow-well.md §6b) hasn't been formally
 * exposed yet. Until it lands, this endpoint returns a STUB shape
 * that matches the agreed export contract, derived from the
 * hand-maintained `BACK_MIND_CAPABILITIES` prose in
 * realtime/src/prompts/_back-mind-capabilities.ts plus the 10-category
 * taxonomy from plans/one-flow-well.md.
 *
 * When A1 ships its exporter, this route swaps to read from realtime/
 * (or fetches from nanoclaw) and returns the live shape — the UI
 * contract is stable.
 *
 * Routes:
 *   GET /api/capabilities → { source, generated_at, groups: Group[] }
 *
 * Type:
 *   interface Group { id; label; description?; items: Item[] }
 *   interface Item  { id; label; kind; available; details? }
 */
import type { Hono } from 'hono';

import { requireOperatorOrToken } from './auth';

export interface CapabilityItem {
  id: string;
  label: string;
  /** Family of capability — drives which icon / badge the UI shows. */
  kind:
    | 'mcp-tool'
    | 'sdk-tool'
    | 'external-mcp'
    | 'channel'
    | 'skill'
    | 'slash-command'
    | 'permission'
    | 'memory'
    | 'self-mod'
    | 'subagent'
    | 'xml-tag';
  /** True if this is actually wired into this agent group, false if
   *  it's just globally available but not wired here. The UI shows
   *  the unwired ones dimmed so the operator can see them. */
  available: boolean;
  details?: string;
}

export interface CapabilityGroup {
  id: string;
  label: string;
  description?: string;
  items: CapabilityItem[];
}

interface CapabilityPayload {
  source: 'stub' | 'realtime' | 'nanoclaw';
  generated_at: string;
  groups: CapabilityGroup[];
}

/** Stub data. Tracks the 10-category taxonomy from
 *  plans/one-flow-well.md and the back-mind capability prose.
 *
 *  TODO(live-resolver): the `xml-directives` group below is currently
 *  a STUB — the entries are hand-curated from the actual tag taxonomy
 *  in `realtime/src/scenario-action-stream.ts`,
 *  `realtime/src/prompts/_voice-tags.ts`, and
 *  `nanoclaw/container/agent-runner/src/destinations.ts`. When the
 *  realtime capability-resolver (plans/one-flow-well.md §6b) starts
 *  reporting output-vocabulary alongside input-tools, this group
 *  should be sourced from it so it stays in sync with what the
 *  parser/interpreter actually accepts — same pattern as how
 *  back-mind tools eventually swap from this stub to the live
 *  nanoclaw snapshot. */
export function buildStub(): CapabilityPayload {
  const groups: CapabilityGroup[] = [
    {
      id: 'xml-directives',
      label: 'Output vocabulary (XML)',
      description:
        'Top-level XML blocks the back-mind can emit as its response. Everything else (say / presentation / speech / tool dispatch) nests inside <timeline>.',
      items: [
        {
          id: 'xml-message',
          label: '<message to="…">',
          kind: 'xml-tag',
          available: true,
          details:
            'Destination-routed delivery. Primary output shape. Multi-destination supported (multiple <message> blocks in one response). Text outside <message> blocks is scratchpad — logged but not sent. `to=` accepts a destination name or namespaced handle (e.g. `signal:+E164` for cold-contact).',
        },
        {
          id: 'xml-timeline',
          label: '<timeline>',
          kind: 'xml-tag',
          available: true,
          details:
            'Wraps a playback sequence for voice/scenario mode. Contains <say> beats, presentation tags (<slide_next/> / <frag_next/>), speech tags (<break/> / <emotion> / <spell>), and tool dispatches (<tool_*/>). Auto-closed at end-of-stream if unclosed.',
        },
        {
          id: 'xml-silent',
          label: '<silent>',
          kind: 'xml-tag',
          available: true,
          details:
            'Sentinel for "no output." Suppressed downstream. Used by narration/banter call sites where the model is allowed to opt out. Some call sites forbid it and forward every delta as-is.',
        },
      ],
    },
    {
      id: 'messaging',
      label: 'Cross-channel messaging',
      description:
        'Send messages, files, and voice memos to other people Pat is wired to.',
      items: [
        { id: 'send_message', label: 'send_message', kind: 'mcp-tool', available: true },
        { id: 'send_file', label: 'send_file', kind: 'mcp-tool', available: true },
        { id: 'send_voice_memo', label: 'send_voice_memo', kind: 'mcp-tool', available: true },
        { id: 'edit_message', label: 'edit_message', kind: 'mcp-tool', available: true },
        { id: 'add_reaction', label: 'add_reaction', kind: 'mcp-tool', available: true },
      ],
    },
    {
      id: 'code-files',
      label: 'Code & files',
      description: 'Read, edit, write, grep, glob across the workspace.',
      items: [
        { id: 'Read', label: 'Read', kind: 'sdk-tool', available: true },
        { id: 'Edit', label: 'Edit', kind: 'sdk-tool', available: true },
        { id: 'Write', label: 'Write', kind: 'sdk-tool', available: true },
        { id: 'Grep', label: 'Grep', kind: 'sdk-tool', available: true },
        { id: 'Glob', label: 'Glob', kind: 'sdk-tool', available: true },
      ],
    },
    {
      id: 'shell',
      label: 'Shell & system',
      description: 'Run arbitrary shell commands.',
      items: [{ id: 'Bash', label: 'Bash', kind: 'sdk-tool', available: true }],
    },
    {
      id: 'web',
      label: 'Web & research',
      // Apify + Firecrawl are container-side skills (nanoclaw/container/skills/
      // {apify, firecrawl}/SKILL.md), not first-party SDK tools — the back-mind
      // reaches them via the OneCLI-credentialed gateway. We surface them in
      // this group so an operator looking at "what can Pat do on the web"
      // sees the full picture; the host-side capability-resolver walks them
      // out of container.json's mcpServers + the container/skills/ tree, but
      // this dashboard stub mirrors that catalog explicitly.
      items: [
        { id: 'WebFetch', label: 'WebFetch', kind: 'sdk-tool', available: true },
        { id: 'WebSearch', label: 'WebSearch', kind: 'sdk-tool', available: true },
        {
          id: 'apify',
          label: 'Apify (20k+ actors)',
          kind: 'external-mcp',
          available: true,
          details: 'TikTok/IG/YouTube/Reddit scrapers, Google/Bing search, e-commerce extractors',
        },
        {
          id: 'firecrawl',
          label: 'Firecrawl',
          kind: 'external-mcp',
          available: true,
          details: 'JS-rendered pages as clean Markdown — mcp__firecrawl__* tools + firecrawl skill, via api.firecrawl.dev',
        },
      ],
    },
    {
      id: 'scheduling',
      label: 'Scheduling',
      items: [
        { id: 'schedule_task', label: 'schedule_task', kind: 'mcp-tool', available: true },
        { id: 'list_tasks', label: 'list_tasks', kind: 'mcp-tool', available: true },
        { id: 'cancel_task', label: 'cancel_task', kind: 'mcp-tool', available: true },
        { id: 'pause_task', label: 'pause_task', kind: 'mcp-tool', available: true },
        { id: 'resume_task', label: 'resume_task', kind: 'mcp-tool', available: true },
        { id: 'update_task', label: 'update_task', kind: 'mcp-tool', available: true },
      ],
    },
    {
      id: 'interactive',
      label: 'Interactive',
      items: [
        { id: 'ask_user_question', label: 'ask_user_question', kind: 'mcp-tool', available: true },
        { id: 'send_card', label: 'send_card', kind: 'mcp-tool', available: true },
      ],
    },
    {
      id: 'memory',
      label: 'Memory & wiki',
      description: 'Persistent cross-session notes.',
      items: [
        { id: 'memory-dir', label: 'memory/', kind: 'memory', available: true },
      ],
    },
    {
      id: 'subagents',
      label: 'Sub-agents',
      items: [
        { id: 'create_agent', label: 'create_agent', kind: 'subagent', available: true },
      ],
    },
    {
      id: 'self-mod',
      label: 'Self-modification',
      items: [
        { id: 'install_packages', label: 'install_packages', kind: 'self-mod', available: true },
        { id: 'add_mcp_server', label: 'add_mcp_server', kind: 'self-mod', available: true },
      ],
    },
    {
      id: 'channels',
      label: 'Channels wired',
      description: 'Inbound surfaces this agent group can be reached on.',
      items: [
        { id: 'pstn', label: 'PSTN (phone-call)', kind: 'channel', available: true },
        { id: 'signal', label: 'Signal', kind: 'channel', available: true },
        { id: 'anam-web', label: 'anam-web avatar', kind: 'channel', available: true },
        { id: 'slack', label: 'Slack', kind: 'channel', available: false, details: 'installed but not wired' },
      ],
    },
  ];
  return {
    source: 'stub',
    generated_at: new Date().toISOString(),
    groups,
  };
}

export function registerCapabilityRoutes(app: Hono, viewerToken: string): void {
  app.get('/api/capabilities', async (c) => {
    if (!(await requireOperatorOrToken(c, viewerToken))) return c.text('unauthorized', 401);
    return c.json(buildStub());
  });
}
