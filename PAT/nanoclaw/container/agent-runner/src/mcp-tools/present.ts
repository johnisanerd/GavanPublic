/**
 * Presenter MCP tools — drive the pat-web slide iframe.
 *
 * The container reads the packet directly from disk
 * (`/workspace/agent/packet/`) — the packet is mounted into the
 * group's workspace at provisioning time. Slide commands go out as
 * HTTP POSTs to pat-web's slide-bus endpoint, which fans them out
 * to the open deck iframe(s) via SSE.
 *
 * Tools:
 *   - audience_ready()            → wait-marker; resolves when operator says go
 *   - start_presentation()        → open deck iframe
 *   - end_presentation()          → close deck iframe
 *   - present_advance(n)          → move deck cursor to slide n
 *   - present_resume(n)           → same as advance, semantically distinct (post-Q&A)
 *   - present_get_slide(n)        → read spec for slide n from disk
 *   - present_inject_slide(spec)  → validate + inject + advance
 */
import fs from 'fs';
import path from 'path';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const PACKET_ROOT = '/workspace/agent/packet';
const CURSOR_FILE = path.join(PACKET_ROOT, '.cursor');

/** Slide-bus endpoint on pat-web. Set via env at container spawn.
 *  Falls back to a default that works in dev. */
function slideBusUrl(): string {
  return process.env.PAT_WEB_SLIDE_BUS_URL ?? 'http://host.docker.internal:8788/api/slide-bus';
}

/** Scenario slug — used so multiple decks on one pat-web instance
 *  can be routed. Set per-container at spawn (matches the agent
 *  group's packet slug). */
function scenarioSlug(): string {
  return process.env.PAT_WEB_SCENARIO_SLUG ?? 'default';
}

/** PAT: thread tag stamped on every slide-bus POST so pat-web's
 *  thread-keyed state buckets correctly. The host sets
 *  PAT_WEB_THREAD_ID from session.thread_id at container spawn —
 *  e.g. `anam-web-call-<sessionId>` for avatar calls. When unset
 *  (dev/manual runs) we omit the field and the server falls back
 *  to the empty-thread bucket. */
function threadId(): string | null {
  return process.env.PAT_WEB_THREAD_ID ?? null;
}

function log(msg: string): void {
  console.error(`[present-tool] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

async function postToBus(payload: Record<string, unknown>): Promise<{ ok: boolean; status: number; body: string }> {
  const url = `${slideBusUrl()}/${scenarioSlug()}`;
  const t = threadId();
  // PAT: stamp the thread tag on every POST so pat-web routes to the
  // correct (slug, thread) bucket. Existing keys in `payload` win,
  // so callers can still override (e.g. tests).
  const body = t && !('thread' in payload) ? { ...payload, thread: t } : payload;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const respBody = await res.text();
    if (!res.ok) {
      log(`bus POST ${url} failed: ${res.status} ${respBody}`);
    }
    return { ok: res.ok, status: res.status, body: respBody };
  } catch (e) {
    log(`bus POST error: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, status: 0, body: String(e) };
  }
}

function readSlideSpec(n: number): { ok: boolean; spec?: string; error?: string } {
  const filePath = path.join(PACKET_ROOT, 'slides', `${String(n).padStart(2, '0')}.yaml`);
  try {
    const body = fs.readFileSync(filePath, 'utf8');
    return { ok: true, spec: body };
  } catch (e) {
    return { ok: false, error: `slide ${n} spec not readable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function writeCursor(n: number): void {
  try {
    fs.writeFileSync(CURSOR_FILE, String(n));
  } catch (e) {
    log(`cursor write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─── Tools ─────────────────────────────────────────────────────────

export const startPresentation: McpToolDefinition = {
  tool: {
    name: 'start_presentation',
    description:
      `Open the slide deck iframe in pat-web alongside the avatar. Call once, ` +
      `right when you begin delivery. After this fires the audience can see the slides.`,
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    const r = await postToBus({ cmd: 'open' });
    if (!r.ok) return err(`start_presentation: bus unreachable (${r.status})`);
    return ok('deck iframe opened in pat-web');
  },
};

export const endPresentation: McpToolDefinition = {
  tool: {
    name: 'end_presentation',
    description:
      `Close the slide deck iframe. Call when you're done with the deck and Q&A — ` +
      `the operator should usually signal this with "thanks, we're wrapping."`,
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    const r = await postToBus({ cmd: 'close' });
    if (!r.ok) return err(`end_presentation: bus unreachable (${r.status})`);
    return ok('deck iframe closed');
  },
};

export const presentAdvance: McpToolDefinition = {
  tool: {
    name: 'present_advance',
    description:
      `Move the deck to slide n (1-indexed). The audience now sees slide n on screen. ` +
      `Always call this at the END of every slide turn — the deck doesn't change otherwise. ` +
      `Persists the cursor to disk for crash recovery.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        n: { type: 'number', description: '1-indexed slide number to advance to' },
      },
      required: ['n'],
    },
  },
  async handler(args) {
    const n = Number(args.n);
    if (!Number.isFinite(n) || n < 1) return err(`invalid slide number: ${args.n}`);
    writeCursor(n);
    const r = await postToBus({ cmd: 'advance', n: n - 1 });
    if (!r.ok) return err(`present_advance: bus unreachable (${r.status})`);
    return ok(`advanced to slide ${n}`);
  },
};

export const presentResume: McpToolDefinition = {
  tool: {
    name: 'present_resume',
    description:
      `Return to slide n after a Q&A interlude. Semantically equivalent to ` +
      `present_advance but emits a distinct event for telemetry — the channel uses ` +
      `it to re-arm the auto-advance loop after an interrupt.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        n: { type: 'number', description: '1-indexed slide to resume on' },
      },
      required: ['n'],
    },
  },
  async handler(args) {
    const n = Number(args.n);
    if (!Number.isFinite(n) || n < 1) return err(`invalid slide number: ${args.n}`);
    writeCursor(n);
    const r = await postToBus({ cmd: 'resume', n: n - 1 });
    if (!r.ok) return err(`present_resume: bus unreachable (${r.status})`);
    return ok(`resumed at slide ${n}`);
  },
};

export const presentGetSlide: McpToolDefinition = {
  tool: {
    name: 'present_get_slide',
    description:
      `Read the YAML spec for slide n (1-indexed). Returns the full spec including ` +
      `notes.spoken, notes.off_script, stage_directions. Use this to retrieve content ` +
      `for the current slide or to look up off-script notes for a Q&A question.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        n: { type: 'number', description: '1-indexed slide number' },
      },
      required: ['n'],
    },
  },
  async handler(args) {
    const n = Number(args.n);
    if (!Number.isFinite(n) || n < 1) return err(`invalid slide number: ${args.n}`);
    const r = readSlideSpec(n);
    if (!r.ok) return err(r.error!);
    return ok(r.spec!);
  },
};

export const presentInjectSlide: McpToolDefinition = {
  tool: {
    name: 'present_inject_slide',
    description:
      `Generate and inject a new slide at runtime — typically during Q&A when the audience ` +
      `asks for a chart you don't have. Pass a JSON object matching the SlideSpec shape ` +
      `(layout + typed slots + notes.spoken). Use ONLY figure-free layouts ('bullets', 'table', ` +
      `'quote', 'callouts-3', 'two-col' without figure slots) — image generation is too slow ` +
      `for live use. Pat-web validates the spec; if validation fails the tool returns the errors ` +
      `and you can retry with corrections. Returns the new slide index, then call present_advance.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        spec: {
          type: 'object',
          description: 'Full SlideSpec — must include layout, notes.spoken, plus layout-specific slot fields',
        },
        after: {
          type: 'number',
          description: 'Optional: 1-indexed slide to inject after. Defaults to the current cursor.',
        },
      },
      required: ['spec'],
    },
  },
  async handler(args) {
    const spec = args.spec as Record<string, unknown>;
    const after = typeof args.after === 'number' ? args.after : undefined;
    if (!spec || typeof spec !== 'object') return err('spec must be a JSON object');
    const r = await postToBus({ cmd: 'inject', spec, after });
    if (!r.ok) {
      // Bus returns 422 with JSON body on validation failure
      return err(`present_inject_slide rejected: ${r.body}`);
    }
    try {
      const parsed = JSON.parse(r.body) as { newIndex: number };
      if (typeof parsed.newIndex === 'number') {
        return ok(
          `slide injected at index ${parsed.newIndex + 1} (1-indexed). Call present_advance(${parsed.newIndex + 1}) to navigate.`,
        );
      }
    } catch {
      // fall through
    }
    return ok(`slide injected (response: ${r.body})`);
  },
};

registerTools([startPresentation, endPresentation, presentAdvance, presentResume, presentGetSlide, presentInjectSlide]);
