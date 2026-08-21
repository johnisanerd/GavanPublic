/**
 * Presentation packet → presenter-agent-group provisioning.
 *
 * Called from pat-web's upload endpoint after the packet has been
 * translated (pamphlet → DSL) and validated. We don't re-translate
 * or re-LLM-call here — this is the pure side-effect step that takes
 * a finished packet, creates the agent group, wires it to a fresh
 * anam-web messaging group, and writes the packet files into the
 * group's workspace.
 *
 * Idempotent on slug: if a presenter group with the same slug
 * exists, we update its packet contents in place (no DB churn).
 *
 * Workflow:
 *   1. Resolve folder name (`presenter-<slug>`) — generate or reuse
 *   2. createAgentGroup if new
 *   3. initGroupFilesystem (writes CLAUDE.local.md, container.json,
 *      .claude-shared/, etc.)
 *   4. Write packet/ contents under groups/<folder>/packet/
 *   5. Seed CLAUDE.local.md with the presenter mission preamble
 *   6. Provision a fresh anam-web messaging group → wired to the
 *      new agent group, per-thread session mode
 *   7. Return ids
 *
 * Container needs `PAT_WEB_SCENARIO_SLUG` and `PAT_WEB_SLIDE_BUS_URL`
 * env. Those are container-config concerns, not provisioning — the
 * MCP tool reads them at call time. We bake the slug into
 * container.json's env so spawns pick it up; the URL is operator-
 * controlled at startup.
 */
import fs from 'fs';
import path from 'path';

import { extractPresentationSlides, renderPresentationSlide } from '@agentic-toolkit/scenarios/presentation';

import { createAgentGroup, getAgentGroupByFolder } from '../db/agent-groups.js';
import { getMessagingGroupByPlatform, provisionMessagingGroup } from '../db/messaging-groups.js';
import { initGroupFilesystem } from '../group-init.js';
import { GROUPS_DIR } from '../config.js';
import { log } from '../log.js';
import type { AgentGroup } from '../types.js';

export interface ProvisionInput {
  slug: string;
  manifest: Record<string, unknown>;
  /** PAT Phase 6: canonical packet shape is reveal HTML — one
   *  `<section>` per slide with speaker notes in `<aside class="notes">`
   *  containing `<timeline>` and `<context>` blocks. Must be provided;
   *  the extractor parses it at provision time to produce the
   *  `<presentation_slide>` envelopes that ride in the agent's system
   *  prompt. */
  slides_html: string;
  deep_context?: string;
  audience_qa?: string;
  tone?: string;
}

export interface ProvisionOutput {
  agent_group_id: string;
  messaging_group_id: string;
  folder: string;
  packet_dir: string;
}

const CLAUDE_LOCAL_PREAMBLE = `# Presenter agent

You are an AI presenter. The full packet — manifest, every slide's
spec, tone guide, deep context, and audience Q&A — is bundled
directly into your system prompt via \`_packet-bundle.md\`
(imported below). You do NOT need to call \`present_get_slide\` or
\`Read\` on packet/ files; everything is already in your context.

## ⚠️ EVERYTHING IN \`send_message\` IS SPOKEN BY THE AVATAR

The audience hears every word you put in \`send_message\`. There is
NO operator-only channel, NO status path, NO debug channel. Tool
calls and their results are invisible to the audience; chat text
is not.

**Forbidden in \`send_message\`:**
- "Slide N delivered." / "Done with slide N." / "Moving to next slide."
- "Let me call X tool now." / "Calling start_presentation()."
- "I'll start the presentation now." / "Beginning delivery."
- "Loading slide 1..." / "Now I'll show..."
- Any narration of what you're doing or about to do.

For concrete good / bad timelines (full conversational sequences), see
\`/app/skills/present-slides/SKILL.md\` — section "Full timeline examples".

After delivering a slide, **end your turn silently**. No further
\`send_message\`. The host watches for the terminator tag
(\`<slide_next/>\`) and advances the deck. The next inbound (from
the operator or audience) will resume you.

## Delivery mode: TAG-STREAM (the only mode this packet uses)

The host parses your \`send_message\` text for inline XML tags
(\`<verbatim a="..."/>\`, \`<frag_next/>\`, \`<slide_next/>\`,
\`<tool_*/>\`, etc.) wrapped in a top-level \`<timeline>...</timeline>\`
element, and drives the deck + TTS off them. See
\`/app/skills/present-slides/SKILL.md\` for the full tag vocabulary
and good/bad timeline content examples.

Per-slide contract:

- ONE \`send_message\` per turn, containing exactly ONE
  \`<timeline>...</timeline>\` wrapper. After it, STOP — do not iterate.
- Open with \`<timeline>\`, close with \`</timeline>\`. The wrapper drives
  the delivering/conversing state machine; without it the narrator
  may fire filler over your authored content.
- Inside the wrapper, the text ends with a terminator (BEFORE the
  close): \`<slide_next/>\` (advance), \`<slide_go_to n="N"/>\` (jump),
  or \`<ask_for_questions/>\` (pause for follow-up).
- Use \`<verbatim a="all"/>\` to splice the current slide's
  \`notes.spoken\` verbatim (it's the bare-string default).
- Use \`<frag_next/>\` between bullet chunks when the slide has
  \`fragment: true\` (visible in the bundle below).
- Every word of prose between tags is heard by the audience.
  Choose carefully.

## Setup phase (one call, once per session)

1. \`start_presentation()\` — opens the deck iframe on the user's screen.
2. STOP. Wait for the operator's inbound to begin (e.g. "begin",
   "audience is ready", "go ahead"). Do NOT auto-start; the operator
   chooses the moment. After their signal, deliver slide 1.
3. After the final slide, call \`end_presentation()\` to close.

There is NO \`audience_ready()\` call. Skip it.

This agent group exists for ONE presentation. Refuse unrelated
requests with "I'm in presenter mode right now."

@./_packet-bundle.md
`;

function nowSlug(): string {
  return new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
}

function folderForSlug(slug: string): string {
  // Conservative slugification — agent group folders need to be
  // safe filenames and DB-distinguishable.
  const safe = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `presenter-${safe || nowSlug()}`;
}

function generateGroupId(): string {
  return `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function writePacket(folder: string, input: ProvisionInput): string {
  const packetDir = path.resolve(GROUPS_DIR, folder, 'packet');
  fs.mkdirSync(packetDir, { recursive: true });

  // manifest.yaml — JSON is valid YAML, simpler than emitting yaml.
  // PAT Phase 6: every packet is tag-stream delivery mode now;
  // the legacy send_message rendition path is gone.
  const manifestToWrite = {
    delivery_mode: 'tag-stream',
    ...input.manifest,
  };
  fs.writeFileSync(path.join(packetDir, 'manifest.yaml'), JSON.stringify(manifestToWrite, null, 2) + '\n');

  // PAT Phase 6: canonical packet shape is `slides.html` — reveal HTML
  // that the extractor parses to produce per-slide PresentationSlide
  // objects. Replaces the legacy per-slide JSON-YAML files.
  fs.writeFileSync(path.join(packetDir, 'slides.html'), input.slides_html);

  if (input.deep_context) {
    fs.writeFileSync(path.join(packetDir, 'deep-context.md'), input.deep_context);
  }
  if (input.audience_qa) {
    fs.writeFileSync(path.join(packetDir, 'audience-qa.md'), input.audience_qa);
  }
  if (input.tone) {
    fs.writeFileSync(path.join(packetDir, 'tone.md'), input.tone);
  }

  // PAT: `.cursor` on disk was scrapped — the host owns the
  // cursor in-memory keyed by threadKey. No on-disk seed needed.

  return packetDir;
}

/** PAT: concat the packet (manifest + every slide + tone +
 *  deep-context + audience-qa) into a single Markdown bundle that
 *  CLAUDE.local.md @-imports. Lets the agent see the whole packet
 *  in its system prompt without any present_get_slide / Read tool
 *  round-trips — dramatic latency win for short-presentation cases.
 *  Re-written on every provision so re-uploaded packets stay in sync. */
function writePacketBundle(folder: string, input: ProvisionInput, packetDir: string): void {
  const lines: string[] = [];
  lines.push('# Packet bundle (auto-loaded; no need to call present_get_slide or Read)');
  lines.push('');
  lines.push('Everything below is your packet — manifest, every slide spec,');
  lines.push('tone guide, deep context, audience Q&A. Use directly when');
  lines.push("composing each slide's send_message text. **DO NOT call");
  lines.push('`present_get_slide` or `Read` on packet/ files — the content');
  lines.push('is already in your system prompt.**');
  lines.push('');
  lines.push('## manifest.yaml');
  lines.push('```json');
  lines.push(fs.readFileSync(path.join(packetDir, 'manifest.yaml'), 'utf8').trimEnd());
  lines.push('```');
  lines.push('');
  if (input.tone) {
    lines.push('## tone.md');
    lines.push('```markdown');
    lines.push(input.tone.trimEnd());
    lines.push('```');
    lines.push('');
  }
  // PAT Phase 6: emit one <presentation_slide> XML envelope per slide
  // (extracted from slides.html at provision time). Replaces the
  // legacy per-slide JSON inlining. Agent reads `<content>` for the
  // visible slide HTML, `<timeline>` for the authored action sequence
  // it can splice via `<timeline_span/>`, and `<context>` for free-form
  // off-script Q&A reference material.
  lines.push('## Slides');
  lines.push('');
  const extracted = extractPresentationSlides(input.slides_html);
  for (const slide of extracted) {
    lines.push(`### slide ${slide.n} — ${slide.id}`);
    lines.push('```xml');
    lines.push(renderPresentationSlide(slide));
    lines.push('```');
    lines.push('');
  }
  if (input.deep_context) {
    lines.push('');
    lines.push('## deep-context.md');
    lines.push('```markdown');
    lines.push(input.deep_context.trimEnd());
    lines.push('```');
  }
  if (input.audience_qa) {
    lines.push('');
    lines.push('## audience-qa.md');
    lines.push('```markdown');
    lines.push(input.audience_qa.trimEnd());
    lines.push('```');
  }
  lines.push('');
  const bundlePath = path.resolve(GROUPS_DIR, folder, '_packet-bundle.md');
  fs.writeFileSync(bundlePath, lines.join('\n'));
}

/** Seed CLAUDE.local.md with the presenter preamble. Caller-provided
 *  instructions in initGroupFilesystem only write on first creation
 *  (the file is then agent-writable). For presenter groups, we
 *  *re-write* on every provision to keep the preamble in sync with
 *  packet updates — packet may have been re-uploaded with new content. */
function seedClaudeLocal(folder: string): void {
  const filePath = path.resolve(GROUPS_DIR, folder, 'CLAUDE.local.md');
  fs.writeFileSync(filePath, CLAUDE_LOCAL_PREAMBLE);
}

export function provisionPresentation(input: ProvisionInput): ProvisionOutput {
  const folder = folderForSlug(input.slug);
  let group: AgentGroup | undefined = getAgentGroupByFolder(folder);
  if (!group) {
    const id = generateGroupId();
    const groupRow: AgentGroup = {
      id,
      name: typeof input.manifest.title === 'string' ? input.manifest.title : input.slug,
      folder,
      agent_provider: null,
      created_at: new Date().toISOString(),
    };
    createAgentGroup(groupRow);
    initGroupFilesystem(groupRow);
    group = groupRow;
    log.info('Created presenter agent group', { slug: input.slug, folder, id });
  } else {
    log.info('Updating existing presenter agent group', { slug: input.slug, folder, id: group.id });
  }

  const packetDir = writePacket(folder, input);
  writePacketBundle(folder, input, packetDir);
  seedClaudeLocal(folder);

  // Provision a fresh anam-web messaging group dedicated to this
  // scenario. platformId convention: `anam-web:scenario-<slug>` —
  // channel-agnostic `:scenario-` infix so other transports (signal,
  // future video, etc.) can host the same scenario without renaming.
  const platformId = `anam-web:scenario-${input.slug}`;
  const existingMg = getMessagingGroupByPlatform('anam-web', platformId);
  let messagingGroupId: string;
  if (existingMg) {
    messagingGroupId = existingMg.id;
    log.info('Reusing existing presenter messaging group', { slug: input.slug, mgId: messagingGroupId });
  } else {
    const result = provisionMessagingGroup({
      channelType: 'anam-web',
      platformId,
      mgName: `presenter-${input.slug}`,
      unknownSenderPolicy: 'public',
      mga: {
        agent_group_id: group.id,
        engage_mode: 'pattern',
        engage_pattern: '.*',
        sender_scope: 'all',
        ignored_message_policy: 'accumulate',
        session_mode: 'per-thread',
        priority: 0,
      },
    });
    messagingGroupId = result.id;
    log.info('Created presenter messaging group', {
      slug: input.slug,
      mgId: messagingGroupId,
      platformId,
    });
  }

  return {
    agent_group_id: group.id,
    messaging_group_id: messagingGroupId,
    folder,
    packet_dir: packetDir,
  };
}
