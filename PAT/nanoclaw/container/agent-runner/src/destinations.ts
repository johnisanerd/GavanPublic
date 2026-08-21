/**
 * Destination map — lives in inbound.db's `destinations` table.
 *
 * The host writes this table before every container wake AND on demand
 * (e.g. when a new child agent is created mid-session). The container
 * queries the table live on every lookup, so admin changes take effect
 * immediately — no restart required.
 *
 * This table is BOTH the routing map and the container-visible ACL.
 * The host re-validates on the delivery side against the central DB,
 * so even if this table is stale the host's enforcement is authoritative.
 */
import { getInboundDb } from './db/connection.js';

export interface DestinationEntry {
  name: string;
  displayName: string;
  type: 'channel' | 'agent';
  channelType?: string;
  platformId?: string;
  agentGroupId?: string;
}

interface DestRow {
  name: string;
  display_name: string | null;
  type: 'channel' | 'agent';
  channel_type: string | null;
  platform_id: string | null;
  agent_group_id: string | null;
}

function rowToEntry(row: DestRow): DestinationEntry {
  return {
    name: row.name,
    displayName: row.display_name ?? row.name,
    type: row.type,
    channelType: row.channel_type ?? undefined,
    platformId: row.platform_id ?? undefined,
    agentGroupId: row.agent_group_id ?? undefined,
  };
}

export function getAllDestinations(): DestinationEntry[] {
  const rows = getInboundDb().prepare('SELECT * FROM destinations ORDER BY name').all() as DestRow[];
  return rows.map(rowToEntry);
}

export function findByName(name: string): DestinationEntry | undefined {
  const row = getInboundDb().prepare('SELECT * FROM destinations WHERE name = ?').get(name) as DestRow | undefined;
  return row ? rowToEntry(row) : undefined;
}

/**
 * Reverse lookup: given routing fields from an inbound message, find
 * which destination they correspond to (what does this agent call the sender?).
 */
export function findByRouting(
  channelType: string | null | undefined,
  platformId: string | null | undefined,
): DestinationEntry | undefined {
  if (!channelType || !platformId) return undefined;
  const db = getInboundDb();
  const row =
    channelType === 'agent'
      ? (db.prepare("SELECT * FROM destinations WHERE type = 'agent' AND agent_group_id = ?").get(platformId) as
          | DestRow
          | undefined)
      : (db
          .prepare("SELECT * FROM destinations WHERE type = 'channel' AND channel_type = ? AND platform_id = ?")
          .get(channelType, platformId) as DestRow | undefined);
  return row ? rowToEntry(row) : undefined;
}

/**
 * Generate the system-prompt addendum: agent identity + destination map.
 *
 * Identity is injected here (not in the shared CLAUDE.md) because it's
 * per-agent-group and changes when the operator renames an agent, while
 * the shared base is identical across all agents.
 */
export function buildSystemPromptAddendum(assistantName?: string): string {
  const sections: string[] = [];

  if (assistantName) {
    sections.push(
      [
        '# You are ' + assistantName,
        '',
        `Your name is **${assistantName}**. Use it when the channel asks who you are, when introducing yourself, and when signing any message that explicitly calls for a signature.`,
      ].join('\n'),
    );
  }

  sections.push(buildDestinationsSection());
  sections.push(buildModelsSection());

  return sections.join('\n\n');
}

// PAT: render a "## Models in use" block from the live env vars the host
// forwarded. Defaults mirror realtime/src/llm-provider.ts constants — if
// the realtime layer's defaults change, update both. Pre-emptive answer
// to "what model are you running?" — the question fires on every fresh
// caller and used to need a code lookup.
const DEFAULT_BACK_MIND_MODEL = 'claude-sonnet-4-6';
const DEFAULT_FAST_MODEL = 'anthropic/claude-haiku-4-5-20251001';
const DEFAULT_REQUEST_LAYER_MODEL = 'anthropic/claude-sonnet-4-6';

function buildModelsSection(): string {
  const env = process.env;
  const backMind = env.NANOCLAW_MODEL ?? DEFAULT_BACK_MIND_MODEL;
  const fastFallback = env.FAST_MODEL ?? DEFAULT_FAST_MODEL;
  const banterAck = env.BANTER_ACK_MODEL ?? fastFallback;
  const banterRender = env.BANTER_RENDER_MODEL ?? fastFallback;
  const narration = env.NARRATION_MODEL ?? fastFallback;
  const requestLayer = env.REQUEST_LAYER_MODEL ?? env.FAST_MODEL ?? DEFAULT_REQUEST_LAYER_MODEL;

  return [
    '## Models in use',
    '',
    'Use these when a caller asks what model is running. Resolved at',
    'container-spawn time from the host environment; if env vars change,',
    'new spawns pick up the change.',
    '',
    `- **back-mind** (you): \`${backMind}\``,
    `- **banter-ack** (front-mind, sub-second user-turn acks): \`${banterAck}\``,
    `- **banter-render** (front-mind, re-renders your reply in Pat voice for TTS): \`${banterRender}\``,
    `- **narration** (front-mind, ambient progress while you work): \`${narration}\``,
    `- **request-layer** (front-mind, decides whether to wake you): \`${requestLayer}\``,
  ].join('\n');
}

function buildDestinationsSection(): string {
  const all = getAllDestinations();

  if (all.length === 0) {
    return [
      '## Sending messages',
      '',
      'You currently have no configured destinations. You cannot send messages until an admin wires one up.',
    ].join('\n');
  }

  // Conformed to upstream's always-wrap model on the v2.1.19 upgrade: the
  // agent addresses every message with <message to="name"> — including the
  // single-destination case. For voice (phone-call / anam-web) the caller is
  // a registered destination (provisionMessagingGroup auto-creates it), so the
  // single-destination branch below names it and the back-mind wraps to it.
  const lines = ['## Sending messages', ''];
  if (all.length === 1) {
    const d = all[0];
    const label = d.displayName && d.displayName !== d.name ? ` (${d.displayName})` : '';
    lines.push(`Your destination is \`${d.name}\`${label}.`);
  } else {
    lines.push('You can send messages to the following destinations:', '');
    for (const d of all) {
      const label = d.displayName && d.displayName !== d.name ? ` (${d.displayName})` : '';
      lines.push(`- \`${d.name}\`${label}`);
    }
  }
  lines.push('');
  lines.push(
    'Wrap each delivered message in a `<message to="name">…</message>` block; include several blocks in one response to address several destinations. `<internal>…</internal>` marks thinking you don\'t want sent.',
  );
  lines.push('');
  lines.push(
    'When replying to an incoming message, default to addressing the destination it came `from` (every inbound `<message>` tag carries a `from="name"` attribute). Pick a different destination when the request asks for it (e.g., "tell Laura that…").',
  );
  lines.push('');
  lines.push(
    'The `send_message` MCP tool is the same delivery, available mid-turn — handy for a quick acknowledgment ("on it") before a slow tool call. Each `send_message` call and each final-response `<message>` block lands as its own message in the conversation, so they read as a sequence rather than as one combined reply.',
  );
  return lines.join('\n');
}
