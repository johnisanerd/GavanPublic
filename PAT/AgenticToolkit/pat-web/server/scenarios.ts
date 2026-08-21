/**
 * Scenarios server endpoints — operator-facing upload + list + fetch.
 * Lives on pat-frontend (operator console) per the Option-2 split.
 *
 * Endpoints:
 *   GET  /api/scenarios            — list provisioned scenarios
 *   GET  /api/scenarios/:slug      — fetch one scenario's packet
 *                                    (manifest + slides[])
 *   POST /api/scenarios/upload     — upload a pamphlet (markdown) or
 *                                    a pre-built DSL bundle.
 *                                    Pamphlet → Opus translation →
 *                                    validate-retry × 3 → provision
 *                                    against nanoclaw /scenarios/provision.
 *
 * Storage:
 *   - `<data>/scenarios.json` per-app index (operator console knows what
 *     scenarios it provisioned).
 *   - `<data>/packets/<slug>/{manifest,slides}.json` — read-through copy
 *     so the deck loader on pat-web can fetch via `/api/packets/<slug>`
 *     without round-tripping nanoclaw.
 *
 * The OpenRouter translator runs server-side so the API key never
 * touches the browser.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Hono } from 'hono';
import {
  validateSpec,
  type SlideSpec,
  type PacketManifest,
  type PresentationDisplay,
} from '@agentic-toolkit/scenarios/presentation';
import {
  loadIndex,
  saveIndex,
  upsertScenario,
  findScenario,
  provisionScenario,
  ProvisionError,
  type ScenarioRow,
} from '@agentic-toolkit/scenarios';

const NANOCLAW_HOST =
  process.env.NANOCLAW_PROVISION_URL ?? 'http://localhost:8767';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TRANSLATOR_MODEL = process.env.PACKET_TRANSLATOR_MODEL ?? 'anthropic/claude-opus-4-7';
const MAX_TRANSLATE_RETRIES = 3;
const DATA_DIR = process.env.PAT_FRONTEND_DATA_DIR ?? join(process.cwd(), 'data');
const SCENARIOS_INDEX = join(DATA_DIR, 'scenarios.json');

interface TranslatedPacket {
  manifest: PacketManifest;
  slides: SlideSpec[];
  deep_context?: string;
  audience_qa?: string;
  tone?: string;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// ─── Opus pamphlet → DSL translator ────────────────────────────────

const TRANSLATOR_SYSTEM_PROMPT = `You translate a presentation pamphlet (markdown prose with embedded stage directions, off-script notes, etc.) into a structured packet for an AI presenter agent.

You are designing Palisade Research slides. The deck must feel on-brand, audience-respectful, and pace well in spoken delivery. Every choice you make below has an audience consequence — slides that fail the brand also fail the audience.

OUTPUT FORMAT — strict JSON, no markdown fences, no commentary:

{
  "manifest": {
    "slug": "kebab-case-slug",
    "title": "Human-readable title",
    "audience": "audience descriptor like 'Senate staffer'",
    "duration_budget_s": <total seconds>,
    "slide_count": <N>,
    "persona": { "name": "..." } | null
  },
  "slides": [ <SlideSpec>, ... ],
  "deep_context": "markdown body for cross-cutting context pack",
  "audience_qa": "markdown body for cross-cutting Q&A appendix",
  "tone": "markdown body for tone / restraint rules"
}

SlideSpec union (pick one layout per slide):

  title:      { slide: N, layout: "title", title, subtitle?, duration_s, notes, background?: {color?,image?,gradient?} }
  section:    { slide: N, layout: "section", label, duration_s, notes }
  bullets:    { slide: N, layout: "bullets", title, items: ["..."], emphasis?: "default"|"large", fragment?: bool, duration_s, notes }
  two-col:    { slide: N, layout: "two-col", title?, left: SLOT, right: SLOT, ratio?, duration_s, notes }
  image-full: { slide: N, layout: "image-full", figure: "/path.png", caption?, duration_s, notes }
  quote:      { slide: N, layout: "quote", text, attribution?, source?, duration_s, notes }
  stat:       { slide: N, layout: "stat", value, label, context?, background?: "stone"|"steel", duration_s, notes }
  table:      { slide: N, layout: "table", title?, columns: [...], rows: [[...]], duration_s, notes }

SLOT (used in two-col):
  { kind: "text", body: "..." }
  { kind: "list", body: ["..."] }
  { kind: "figure", body: "/path.png", caption? }
  { kind: "code", body: "...", language? }

SlideNotes:
  {
    spoken: "<verbatim text the presenter speaks, drawn from the pamphlet>",
    stage_directions?: [
      {
        after: "<exact substring of spoken text to anchor at>",
        occurrence?: <0-indexed when after appears multiple times>,
        action: "<action name, e.g. signal_send_demo>",
        args?: {...},
        fireAndForget?: true
      }
    ],
    off_script?: {
      faq?: [ { q, a?, a_ref? }, ... ],
      additional_context?: ["..."],
      transitions?: ["..."]
    }
  }

CONTENT BUDGETS — validator caps, respect them or split content:
  - title: title ≤ 60 chars, subtitle ≤ 100 chars
  - section: label ≤ 40 chars (use it as a chapter marker, not a sentence)
  - bullets: ≤ 5 items, each ≤ 90 chars, title ≤ 60 chars
  - two-col: per-side text ≤ 160 chars, list ≤ 3 items × 75 chars, caption ≤ 90 chars
  - image-full: caption ≤ 100 chars
  - quote: text ≤ 180 chars
  - stat: value ≤ 12 chars (e.g. "81%", "10×", "$1-2/hr", "2h 41m"); label ≤ 70 chars; context ≤ 50 chars (DM Mono caps eyebrow)
  - table: ≤ 6 columns, ≤ 9 rows, cell ≤ 35 chars

OVER-BUDGET CONTENT MUST BE SPLIT INTO MULTIPLE SLIDES, NOT TRUNCATED.
For a multi-slide build of a single conceptual idea, add auto_animate_from: "prev" on the second slide so reveal animates the continuation cleanly.

PALISADE DESIGN RULES (mandatory):

  1. Covers + closing-pivot slides use Foundation Blue background.
     For title-layout covers: background: { color: "#173164" }.
     For statement quote / closing pivots: prefer quote layout with no background override (rendered Foundation Blue via CSS) or use stat with background: "steel" for hard pivots.

  2. Mandate a visual element every ~3 slides. A pure bullets-after-bullets-after-bullets run is the failure mode. Visual elements are: image-full, two-col WITH a figure or code slot, section divider (the right-half distorted-lines treatment is automatic), stat, or quote. If the pamphlet does not supply photos, you can still use section dividers and stat layouts to break the rhythm.

  3. Hero numbers belong in stat, not in tables. If a table cell is doing the heavy lifting ("81%", "10×", "$2/hr", "2h 41m"), promote it to a stat slide right before or after the table. Tables exist for cross-cuts (comparisons across rows), not for the One Big Number.

  4. Section dividers reset audience attention. Insert one between major content runs (intro → trend → caveats → ask). Label ≤ 40 chars, sentence case, optionally prefixed with a section number ("02 — The capability is doubling").

  5. Prefer two-col as the default content layout when you have a caption-or-callout + a content block. It is the strongest brand template. Reserve bullets for genuinely list-shaped content.

  6. Bullets register: use emphasis: "large" for callout-style bullets (3-4 items, ≤90 chars each, "**Lead.** body sentence." structure). Use the default register for true enumerations. Set fragment: true if the spoken script reveals points one at a time.

  7. Word economy: every word must earn its slot. Body prose ≤ 16-18 words per sentence. No filler. Sentence case (not Title Case) on titles. No exclamation marks except in a single deliberate close slide.

  8. Quote layout has NO quotation marks rendered — the layout supplies the visual register. Don't include "" in the text field.

PRESERVE the spoken script faithfully in notes.spoken — light editing for flow is OK; do not paraphrase entire sections. Stage directions in italics in the pamphlet (e.g. *[at this beat, the agent sends Signal messages]*) become stage_directions entries; the anchor "after" should be the unique substring immediately before the stage direction fires.

PRESERVE off-script notes verbatim where reasonable; trim where they obviously exceed slot budgets.

deep_context: copy the pamphlet's "Deep Context Pack" or equivalent appendix material faithfully.
audience_qa: copy any cross-cutting Q&A appendix.
tone: extract any tone guidance (restraint, voice, what to avoid) from the pamphlet preamble.`;

interface TranslationAttempt {
  packet?: TranslatedPacket;
  errors?: string[];
}

async function callOpenRouter(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
): Promise<{ ok: boolean; body: string; error?: string }> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { ok: false, body: '', error: 'OPENROUTER_API_KEY not set' };
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        'HTTP-Referer': 'https://pat-frontend.fly.dev/',
        'X-Title': 'pat-frontend scenarios translator',
      },
      body: JSON.stringify({
        model: TRANSLATOR_MODEL,
        messages,
        temperature: 0.2,
        max_tokens: 16000,
      }),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, body: text, error: `OpenRouter ${res.status}` };
    return { ok: true, body: text };
  } catch (e) {
    return { ok: false, body: '', error: e instanceof Error ? e.message : String(e) };
  }
}

function extractFirstJsonObject(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fence) return fence[1];
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

async function translatePamphlet(pamphletMd: string): Promise<TranslationAttempt> {
  const history: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: TRANSLATOR_SYSTEM_PROMPT },
    { role: 'user', content: pamphletMd },
  ];

  for (let attempt = 0; attempt < MAX_TRANSLATE_RETRIES; attempt++) {
    const r = await callOpenRouter(history);
    if (!r.ok) return { errors: [`OpenRouter error: ${r.error}`] };
    let assistantText: string;
    try {
      const parsed = JSON.parse(r.body) as { choices?: Array<{ message?: { content?: string } }> };
      assistantText = parsed.choices?.[0]?.message?.content ?? '';
    } catch {
      return { errors: ['Could not parse OpenRouter response body'] };
    }
    const jsonStr = extractFirstJsonObject(assistantText);
    if (!jsonStr) {
      history.push({ role: 'assistant', content: assistantText });
      history.push({
        role: 'user',
        content:
          'Your response did not contain a valid JSON object. Re-emit the full packet as a single top-level JSON object with no surrounding prose.',
      });
      continue;
    }
    let packet: TranslatedPacket;
    try {
      packet = JSON.parse(jsonStr) as TranslatedPacket;
    } catch (e) {
      history.push({ role: 'assistant', content: assistantText });
      history.push({
        role: 'user',
        content: `Your JSON failed to parse: ${e instanceof Error ? e.message : String(e)}. Re-emit valid JSON.`,
      });
      continue;
    }
    const validationErrors: string[] = [];
    for (const slide of packet.slides ?? []) {
      const v = validateSpec(slide);
      for (const issue of v.issues) {
        if (issue.severity === 'error') {
          validationErrors.push(
            `[slide ${slide.slide}] ${issue.path ? `${issue.path}: ` : ''}${issue.message}`,
          );
        }
      }
    }
    if (validationErrors.length === 0) return { packet };
    if (attempt < MAX_TRANSLATE_RETRIES - 1) {
      history.push({ role: 'assistant', content: assistantText });
      history.push({
        role: 'user',
        content:
          'Validation failed on your previous output. Fix the following issues and re-emit the FULL packet as valid JSON:\n\n' +
          validationErrors.map((e) => `- ${e}`).join('\n') +
          '\n\nRemember: over-budget content must be SPLIT across slides, not truncated. Use auto_animate_from: "prev" to keep multi-slide builds cohesive.',
      });
    } else {
      return { errors: validationErrors };
    }
  }
  return { errors: ['Translation exceeded max retries'] };
}

// ─── Hono routes ───────────────────────────────────────────────────

export function registerScenarios(app: Hono): void {
  app.get('/api/scenarios', (c) => c.json(loadIndex(SCENARIOS_INDEX)));

  const fetchPacketHandler = (slug: string): { status: number; body: unknown } => {
    const idx = loadIndex(SCENARIOS_INDEX);
    const row = findScenario(idx, slug);
    if (!row) return { status: 404, body: { error: 'not found' } };
    if (!row.packet_dir) return { status: 500, body: { error: 'packet_dir missing' } };
    try {
      const manifest = JSON.parse(readFileSync(join(row.packet_dir, 'manifest.json'), 'utf8'));
      const slides = JSON.parse(readFileSync(join(row.packet_dir, 'slides.json'), 'utf8'));
      return { status: 200, body: { manifest, slides } };
    } catch (e) {
      return {
        status: 500,
        body: { error: `packet unreadable: ${e instanceof Error ? e.message : String(e)}` },
      };
    }
  };

  app.get('/api/scenarios/:slug', (c) => {
    const r = fetchPacketHandler(c.req.param('slug'));
    return r.status === 200
      ? c.json(r.body as object)
      : c.json(r.body as object, r.status as 404 | 500);
  });

  // Alias — DeckPage.tsx loads packets via /api/packets/<slug>.
  app.get('/api/packets/:slug', (c) => {
    const r = fetchPacketHandler(c.req.param('slug'));
    return r.status === 200
      ? c.json(r.body as object)
      : c.json(r.body as object, r.status as 404 | 500);
  });

  app.post('/api/scenarios/upload', async (c) => {
    interface Payload {
      pamphlet?: string;
      title?: string;
      slug?: string;
      specs?: TranslatedPacket;
    }
    let payload: Payload;
    try {
      payload = (await c.req.json()) as Payload;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    let packet: TranslatedPacket | null = null;
    let translationErrors: string[] | null = null;

    if (payload.specs) {
      const errs: string[] = [];
      for (const slide of payload.specs.slides) {
        const v = validateSpec(slide);
        for (const iss of v.issues) {
          if (iss.severity === 'error') {
            errs.push(`[slide ${slide.slide}] ${iss.path ? `${iss.path}: ` : ''}${iss.message}`);
          }
        }
      }
      if (errs.length > 0) translationErrors = errs;
      else packet = payload.specs;
    } else if (payload.pamphlet) {
      const r = await translatePamphlet(payload.pamphlet);
      if (r.errors) translationErrors = r.errors;
      else if (r.packet) packet = r.packet;
    } else {
      return c.json({ error: 'provide { pamphlet } or { specs }' }, 400);
    }

    if (!packet) {
      return c.json({ error: 'translation/validation failed', issues: translationErrors }, 422);
    }

    // PAT (security): always slugify — payload.slug is client-supplied and flows
    // into provisionScenario + join(DATA_DIR, 'packets', slug) below. Using it
    // verbatim allowed path traversal ("../../..."); slugify strips every
    // non-alphanumeric, so a traversal payload collapses to a safe slug. The
    // `|| 'scenario'` guards an all-symbols input slugifying to empty.
    const slug = slugify(payload.slug || packet.manifest.slug || payload.title || packet.manifest.title) || 'scenario';
    packet.manifest.slug = slug;
    packet.manifest.slide_count = packet.slides.length;

    let provision;
    try {
      provision = await provisionScenario('presentation', slug, {
        manifest: packet.manifest,
        slides: packet.slides,
        deep_context: packet.deep_context,
        audience_qa: packet.audience_qa,
        tone: packet.tone,
      }, { nanoclawHost: NANOCLAW_HOST });
    } catch (e) {
      if (e instanceof ProvisionError) {
        return c.json({ error: `provisioning failed (${e.status})`, body: e.body }, 500);
      }
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }

    // Persist a local copy for the operator console's /api/scenarios/:slug
    // fetch path (DeckPage's loadPacket fallback).
    const localPacketDir = join(DATA_DIR, 'packets', slug);
    mkdirSync(localPacketDir, { recursive: true });
    writeFileSync(join(localPacketDir, 'manifest.json'), JSON.stringify(packet.manifest, null, 2));
    writeFileSync(join(localPacketDir, 'slides.json'), JSON.stringify(packet.slides, null, 2));
    if (packet.deep_context) writeFileSync(join(localPacketDir, 'deep-context.md'), packet.deep_context);
    if (packet.audience_qa) writeFileSync(join(localPacketDir, 'audience-qa.md'), packet.audience_qa);
    if (packet.tone) writeFileSync(join(localPacketDir, 'tone.md'), packet.tone);

    const display: PresentationDisplay = {
      slide_count: packet.slides.length,
      duration_budget_s: packet.manifest.duration_budget_s,
      cover_title:
        packet.slides[0]?.layout === 'title' ? packet.slides[0].title : undefined,
    };

    const idx = loadIndex(SCENARIOS_INDEX);
    const row: ScenarioRow = {
      slug,
      kind: 'presentation',
      title: packet.manifest.title,
      audience: packet.manifest.audience,
      agent_group_id: provision.agent_group_id,
      messaging_group_id: provision.messaging_group_id,
      created_at: new Date().toISOString(),
      packet_dir: localPacketDir,
      display: display as unknown as Record<string, unknown>,
    };
    upsertScenario(idx, row);
    mkdirSync(dirname(SCENARIOS_INDEX), { recursive: true });
    saveIndex(SCENARIOS_INDEX, idx);

    return c.json({ ok: true, scenario: row });
  });
}

// Silence "imported but never used" complaints from the type imports
// when this file is compiled in isolation — the types are referenced
// in the runtime code via type assertions.
export type _SuppressUnused = { _: PresentationDisplay; __: typeof existsSync };
