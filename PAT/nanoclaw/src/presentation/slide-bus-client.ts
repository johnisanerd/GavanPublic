/**
 * PAT: host-side slide-bus client. The agent container's MCP tools
 * POST directly to pat-web's slide-bus for setup-phase events (open,
 * close, advance via present_advance). The tag-stream architecture
 * (plans/presenter-tag-stream.md) adds a host-side dispatch path:
 * when the orchestrator parses a chat row in scenario mode, it
 * dispatches digested nav/fragment actions to pat-web via this
 * client.
 *
 * URL: `PAT_WEB_SLIDE_BUS_URL` env, default
 * `http://127.0.0.1:8788/api/slide-bus` (in-process; nanoclaw and
 * pat-web share the host in dev and on production VMs alike). The
 * full URL becomes `${SLIDE_BUS_URL}/${slug}`.
 *
 * Best-effort: a slide-bus POST failure is logged but does NOT abort
 * the action stream. Prose continues to reach Anam via the rendition
 * transport; only the visual nav is dropped.
 */

import { log } from '../log.js';

function slideBusBase(): string {
  return (process.env.PAT_WEB_SLIDE_BUS_URL ?? 'http://127.0.0.1:8788/api/slide-bus').replace(/\/$/, '');
}

export interface SlideBusPostResult {
  ok: boolean;
  status: number;
  body?: string;
}

/**
 * Post a slide-bus command for the given scenario slug. Returns the
 * HTTP result; never throws — network errors and non-2xx responses
 * are logged and reported via the return value.
 *
 * PAT: optional `thread` is stamped into the payload so pat-web's
 * (slug, thread)-keyed state buckets receive the message. When omitted
 * (legacy callers or dev/manual use) the POST lands in the empty-thread
 * bucket on the server. Subscribers and POSTers must agree on the
 * thread to see each other.
 */
export async function postSlideBus(
  slug: string,
  payload: Record<string, unknown>,
  thread?: string | null,
): Promise<SlideBusPostResult> {
  const url = `${slideBusBase()}/${slug}`;
  const body = thread && !('thread' in payload) ? { ...payload, thread } : payload;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const respBody = await res.text().catch(() => '');
    if (!res.ok) {
      log.warn('slide-bus POST failed', { url, status: res.status, body: respBody, payload: body });
    }
    return { ok: res.ok, status: res.status, body: respBody };
  } catch (err) {
    log.warn('slide-bus POST threw', { url, err: String(err), payload: body });
    return { ok: false, status: 0, body: err instanceof Error ? err.message : String(err) };
  }
}
