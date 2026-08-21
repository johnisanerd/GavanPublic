/**
 * Provision client — POSTs a validated content packet to NanoClaw's
 * /scenarios/provision endpoint. Lives in the scenarios package so
 * any consumer (pat-frontend server, smoketest harness, future
 * automation) calls the same code path.
 *
 * The NanoClaw endpoint dispatches by `kind` to a per-kind writer
 * (presentation today; interview/demo/etc. later). Each writer
 * materializes the packet on disk + provisions the agent group +
 * wires a messaging group. Returns ids.
 */
import type { ProvisionRequest, ProvisionResponse, ScenarioKind } from './types.js';

export interface ProvisionClientOpts {
  /** Base URL of NanoClaw's admin/scenarios server. Default targets
   *  the dev port (8767). Override in prod / Fly. */
  nanoclawHost?: string;
}

export class ProvisionError extends Error {
  public readonly status: number;
  public readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'ProvisionError';
    this.status = status;
    this.body = body;
  }
}

export async function provisionScenario<Content = unknown>(
  kind: ScenarioKind,
  slug: string,
  content: Content,
  opts: ProvisionClientOpts = {},
): Promise<ProvisionResponse> {
  const host = opts.nanoclawHost ?? process.env.NANOCLAW_HOST_URL ?? 'http://localhost:8767';
  const req: ProvisionRequest<Content> = { kind, slug, content };

  const res = await fetch(`${host}/scenarios/provision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new ProvisionError(`provision failed (${res.status})`, res.status, body);
  }

  return (await res.json()) as ProvisionResponse;
}
