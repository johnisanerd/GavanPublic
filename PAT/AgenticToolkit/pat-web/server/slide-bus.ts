/**
 * Slide bus — server-side relay between nanoclaw MCP tools
 * (producers) and pat-web deck iframes (consumers).
 *
 * Producers POST to /api/slide-bus/:slug with a JSON command:
 *   {cmd: "open"}                  - open the deck iframe in pat-web App
 *   {cmd: "close"}                 - close the iframe
 *   {cmd: "audience-ready"}        - operator confirmed audience is ready
 *   {cmd: "advance", n}            - move deck cursor to slide n (0-indexed)
 *   {cmd: "resume", n}             - same as advance, emitted post-Q&A
 *   {cmd: "next"}                  - relative advance (server tracks cursor)
 *   {cmd: "prev"}                  - relative regress
 *   {cmd: "frag-next"}             - advance one fragment within slide
 *   {cmd: "frag-prev"}             - regress one fragment within slide
 *   {cmd: "inject", spec, after?}  - validate + inject new slide; returns
 *                                    {newIndex} on success, 422 + errors on fail
 *
 * Consumers (App.tsx for the iframe lifecycle; DeckPage.tsx for slide
 * commands) subscribe via GET /api/slide-bus/:slug/events (SSE).
 *
 * Per-slug isolation: each presentation gets its own bus channel.
 * Not a queue — commands fire-and-forget. If a consumer isn't
 * connected, the command is dropped (warning logged). Consumers are
 * expected to reconnect promptly.
 */
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { validateSpec } from '@agentic-toolkit/scenarios/presentation';
import type { SlideSpec } from '@agentic-toolkit/scenarios/presentation';

/** Per-(slug,thread) channels. The key is `${slug}::${thread ?? ''}`
 *  — empty-thread bucket exists for legacy/dev callers that haven't
 *  been updated to include a thread. PAT: thread-keying lets each
 *  call session get its own sticky cursor so a fresh call doesn't
 *  inherit slide N from the previous tester's leftover state. */
const channels = new Map<string, Set<(line: string) => void>>();

/** Per-(slug,thread) latest state — replayed to new SSE subscribers
 *  so a page reload mid-presentation re-acquires the iframe-open
 *  state and current slide cursor. Without this, the agent's
 *  `start_presentation` and `present_advance` commands are lost the
 *  moment the user refreshes (slide-bus is fire-and-forget by design,
 *  but the iframe-open + cursor are sticky in spirit). */
interface SlideBusState {
  deckOpen: boolean;
  cursor: number; // 0-indexed; -1 = not yet advanced
  audienceReady: boolean;
}
const states = new Map<string, SlideBusState>();

function busKey(slug: string, thread: string | null | undefined): string {
  return `${slug}::${thread ?? ''}`;
}

function state(slug: string, thread: string | null | undefined): SlideBusState {
  const k = busKey(slug, thread);
  let s = states.get(k);
  if (!s) {
    s = { deckOpen: false, cursor: -1, audienceReady: false };
    states.set(k, s);
  }
  return s;
}

function channel(slug: string, thread: string | null | undefined): Set<(line: string) => void> {
  const k = busKey(slug, thread);
  let s = channels.get(k);
  if (!s) {
    s = new Set();
    channels.set(k, s);
  }
  return s;
}

function broadcast(slug: string, thread: string | null | undefined, payload: unknown): number {
  // Update sticky state so new subscribers can replay.
  if (payload && typeof payload === 'object') {
    const p = payload as { cmd?: string; n?: number };
    const st = state(slug, thread);
    if (p.cmd === 'open') st.deckOpen = true;
    else if (p.cmd === 'close') st.deckOpen = false;
    else if (p.cmd === 'audience-ready') st.audienceReady = true;
    else if ((p.cmd === 'advance' || p.cmd === 'resume') && typeof p.n === 'number') st.cursor = p.n;
    // PAT: relative-nav cursor tracking — increment/decrement off
    // current state so the next subscriber's replay reflects the new
    // position.
    else if (p.cmd === 'next') st.cursor = Math.max(0, st.cursor) + 1;
    else if (p.cmd === 'prev') st.cursor = Math.max(0, st.cursor - 1);
    // frag-next / frag-prev intentionally do NOT touch the slide
    // cursor — fragments live within a slide.
  }

  const subs = channels.get(busKey(slug, thread));
  if (!subs || subs.size === 0) return 0;
  const line = JSON.stringify(payload);
  for (const send of subs) {
    try {
      send(line);
    } catch (e) {
      console.error(`[slide-bus] send to ${slug}/${thread ?? '-'} failed:`, e);
    }
  }
  return subs.size;
}

interface InjectResult {
  ok: boolean;
  newIndex?: number;
  errors?: Array<{ severity: 'error' | 'warning'; code: string; message: string; path?: string }>;
}

/** Per-slug runtime appendix slides. Accumulate as the agent calls
 *  present_inject_slide during a presentation. Not persisted across
 *  pat-web restarts for v0; the deck reads them via the SSE inject
 *  event. */
const runtimeSlides = new Map<string, unknown[]>();

function appendRuntime(slug: string, thread: string | null | undefined, spec: unknown): number {
  const k = busKey(slug, thread);
  let arr = runtimeSlides.get(k);
  if (!arr) {
    arr = [];
    runtimeSlides.set(k, arr);
  }
  arr.push(spec);
  return arr.length - 1;
}

export function registerSlideBus(app: Hono): void {
  app.get('/api/slide-bus/:slug/events', (c) => {
    const slug = c.req.param('slug');
    // PAT: per-call thread-keying. When `?thread=` is present, state
    // and channels are scoped to (slug, thread) so each call gets a
    // fresh sticky cursor. Callers without a thread land in the empty
    // bucket — used by dev/manual POSTs and legacy testing.
    const thread = c.req.query('thread') ?? null;
    return streamSSE(c, async (sse) => {
      const ch = channel(slug, thread);
      const send = (line: string) => sse.writeSSE({ data: line });
      ch.add(send);
      send(JSON.stringify({ cmd: 'hello', slug, thread, ts: new Date().toISOString() }));

      // Replay sticky state so a refreshed/late-arriving subscriber
      // can re-acquire the deck. Order matters: audience-ready before
      // open, open before advance, so consumer state machines
      // transition naturally.
      const st = state(slug, thread);
      if (st.audienceReady) send(JSON.stringify({ cmd: 'audience-ready', _replay: true }));
      if (st.deckOpen) send(JSON.stringify({ cmd: 'open', _replay: true }));
      if (st.cursor >= 0) send(JSON.stringify({ cmd: 'advance', n: st.cursor, _replay: true }));

      // Also replay any runtime-injected slides so refresh keeps them.
      const runtime = runtimeSlides.get(busKey(slug, thread));
      if (runtime) {
        for (let i = 0; i < runtime.length; i++) {
          send(JSON.stringify({ cmd: 'inject', spec: runtime[i], runtimeIndex: i, _replay: true }));
        }
      }

      await new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener('abort', () => {
          ch.delete(send);
          resolve();
        });
      });
    });
  });

  app.post('/api/slide-bus/:slug', async (c) => {
    const slug = c.req.param('slug');
    let payload: Record<string, unknown>;
    try {
      payload = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const cmd = payload.cmd;
    if (typeof cmd !== 'string') {
      return c.json({ error: 'missing cmd' }, 400);
    }
    // PAT: producer thread tag. The nanoclaw container's MCP tools
    // read `PAT_WEB_THREAD_ID` from env (set by container-runner from
    // session.thread_id) and stamp it on every POST. The server uses
    // this to route to the correct (slug, thread) bucket.
    const thread = typeof payload.thread === 'string' ? payload.thread : null;

    if (cmd === 'inject') {
      const spec = payload.spec as Record<string, unknown> | undefined;
      if (!spec || typeof spec !== 'object') {
        const result: InjectResult = {
          ok: false,
          errors: [
            { severity: 'error', code: 'missing_spec', message: 'inject requires `spec`' },
          ],
        };
        return c.json(result, 422);
      }
      const validation = validateSpec(spec as unknown as SlideSpec);
      if (!validation.ok) {
        const result: InjectResult = {
          ok: false,
          errors: validation.issues.filter((i) => i.severity === 'error'),
        };
        return c.json(result, 422);
      }
      const idx = appendRuntime(slug, thread, spec);
      broadcast(slug, thread, { cmd: 'inject', spec, runtimeIndex: idx });
      const result: InjectResult = { ok: true, newIndex: idx };
      return c.json(result);
    }

    const fanout = broadcast(slug, thread, payload);
    return c.json({ ok: true, fanout });
  });
}

export function _subscriberCount(slug: string, thread: string | null = null): number {
  return channels.get(busKey(slug, thread))?.size ?? 0;
}
