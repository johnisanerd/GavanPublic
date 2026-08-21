/**
 * Scenario-context loader — reads packet metadata from disk and
 * constructs a `ScenarioContext` for the realtime library's front-mind
 * prompts.
 *
 * Wired into `ChannelOrchestrator` via the `scenarioResolver` option.
 * The orchestrator calls this on every inbound / chat-row delivery to
 * thread scenario meta into banter-ack / banter-render /
 * banter-narration / request-layer prompts. Non-scenario platformIds
 * return null; the orchestrator skips the threading.
 *
 * Convention: a session is "in scenario mode" when its messaging-group
 * platform_id contains `:scenario-<slug>` (provision.ts mints these,
 * pat-web's useAnamSession sets them on `?scenario=<slug>`).
 *
 * Folder lookup: the on-disk agent-group folder is currently named
 * `presenter-<slug>` (folderForSlug in provision.ts). We tolerate both
 * `presenter-<slug>` and `scenario-<slug>` to make re-provisioning a
 * non-event when the folder convention also lands.
 *
 * I/O cost: ~100us per call (small files, no network). Acceptable to
 * call per-inbound for now. Add an LRU keyed on platformId if a hot
 * call site (e.g. per delta during streaming) starts hitting it.
 */
import fs from 'fs';
import path from 'path';

import { conversationKey, type ScenarioContext } from '@agentic-toolkit/realtime';
import { extractPresentationSlides } from '@agentic-toolkit/scenarios/presentation';

import { GROUPS_DIR } from '../config.js';
import { getScenarioCursor } from './scenario-cursor.js';

const SCENARIO_INFIX = ':scenario-';

/** Extract the scenario slug from a messaging-group platform_id, or
 *  null when the platform_id isn't a scenario routing key. */
export function extractScenarioSlug(platformId: string): string | null {
  const idx = platformId.indexOf(SCENARIO_INFIX);
  if (idx < 0) return null;
  const slug = platformId.slice(idx + SCENARIO_INFIX.length);
  return slug.length > 0 ? slug : null;
}

/** Resolve the on-disk packet directory for a scenario slug. Returns
 *  the first directory that exists; null when neither is present. */
function findPacketDir(slug: string): string | null {
  for (const prefix of ['presenter-', 'scenario-']) {
    const candidate = path.resolve(GROUPS_DIR, `${prefix}${slug}`, 'packet');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

interface Manifest {
  slug?: string;
  title?: string;
  audience?: string;
  slide_count?: number;
  kind?: string;
  persona?: { name?: string };
}

function readManifest(packetDir: string): Manifest | null {
  const filePath = path.join(packetDir, 'manifest.yaml');
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as Manifest;
  } catch {
    return null;
  }
}

// PAT: `.cursor` on disk was removed — the host owns the cursor
// in-memory keyed by threadKey (see `scenario-cursor.ts`). This
// helper used to read the legacy file; if you're looking for cursor
// state now, use `getScenarioCursor(threadKey)`.

function readTone(packetDir: string): string | undefined {
  const filePath = path.join(packetDir, 'tone.md');
  if (!fs.existsSync(filePath)) return undefined;
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw.length > 0 ? raw : undefined;
}

/** PAT Phase 6: read slides.html, extract the authored timeline for
 *  slide N. The slides.html file is the canonical packet shape —
 *  reveal HTML with one <section> per slide, speaker notes in
 *  <aside class="notes"> containing <timeline> and <context> blocks.
 *  extractPresentationSlides parses the HTML and returns the
 *  per-slide PresentationSlide objects; we index in to slide N
 *  (1-based) and return its .timeline string verbatim.
 *
 *  Returns null when slides.html doesn't exist or the slide isn't
 *  present at the requested index. The orchestrator's
 *  hydrateTimelineSpan reads this — null means `<timeline_span/>`
 *  emissions short-circuit with reason='no-authored-timeline'. */
function readSlideTimeline(packetDir: string, n: number): string | null {
  const filePath = path.join(packetDir, 'slides.html');
  if (!fs.existsSync(filePath)) return null;
  try {
    const html = fs.readFileSync(filePath, 'utf8');
    const slides = extractPresentationSlides(html);
    const slide = slides[n - 1];
    if (!slide) return null;
    return slide.timeline.length > 0 ? slide.timeline : null;
  } catch {
    return null;
  }
}

/** PAT: tag-stream mode flag — opt-in via manifest's
 *  `delivery_mode: 'tag-stream'`. Default `false` keeps existing
 *  scenarios on the send_message rendition path. */
function readTagStreamFlag(packetDir: string): boolean {
  const filePath = path.join(packetDir, 'manifest.yaml');
  if (!fs.existsSync(filePath)) return false;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const m = JSON.parse(raw) as { delivery_mode?: string };
    return m?.delivery_mode === 'tag-stream';
  } catch {
    return false;
  }
}

/** Build a `ScenarioContext` for the given platform_id, or return null
 *  when the platform_id isn't a scenario routing key or the packet
 *  can't be read. The orchestrator calls this synchronously per
 *  inbound; null result means "non-scenario session, run as default
 *  Pat." */
export function loadScenarioContext(platformId: string, threadId: string | null = null): ScenarioContext | null {
  const slug = extractScenarioSlug(platformId);
  if (!slug) return null;
  const packetDir = findPacketDir(slug);
  if (!packetDir) return null;
  const manifest = readManifest(packetDir);
  if (!manifest) return null;
  const tagStreamEnabled = readTagStreamFlag(packetDir);
  // PAT: cursor is in-memory, keyed by threadKey. Each anam-web
  // session mints a fresh threadId so the cursor starts at 1
  // automatically. Legacy `present_advance` MCP path is dead in
  // tag-stream mode and there are no non-tag-stream packets anymore.
  const currentSlide = getScenarioCursor(conversationKey(threadId, platformId));
  return {
    slug,
    kind: manifest.kind ?? 'presentation',
    title: manifest.title ?? slug,
    audience: manifest.audience,
    persona_name: manifest.persona?.name,
    slide_count: manifest.slide_count,
    current_slide: currentSlide,
    tone: readTone(packetDir),
    tag_stream_enabled: tagStreamEnabled,
    // PAT Phase 6: authored timeline string for `<timeline_span/>`
    // hydration. Loaded for tag-stream packets only — non-tag-stream
    // packets don't have any use for spans.
    current_slide_authored_timeline: tagStreamEnabled
      ? (readSlideTimeline(packetDir, currentSlide) ?? undefined)
      : undefined,
  };
}
