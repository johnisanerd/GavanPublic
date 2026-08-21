/**
 * publish-file — full tool-chain smoke: ask the agent to create a file and
 * publish it with the publish_file MCP tool, then ACTUALLY FETCH the signed
 * URL it hands back and verify the content round-tripped.
 *
 * Covers, in one scenario: realtime inbound → back-mind container → MCP
 * tool → session-DB ncl RPC → host file-publish (HMAC signing) →
 * pat-frontend public /files/pub proxy → real HTTP fetch from outside.
 *
 * Works against local or staging (the URL the agent returns embeds the
 * deployment's own PAT_PUBLIC_BASE_URL — we fetch whatever it says, so
 * pointing REALTIME_BASE_URL at a tunnel to staging exercises the real
 * public domain).
 *
 * The correlation token makes the content check exact: the file must
 * contain the nonce we asked for, so a stale/pre-existing published file
 * can't false-pass.
 */
import type { Scenario, ScenarioContext } from './index.js';

const nonce = `PAT-SMOKE-${Date.now().toString(36)}`;

function extractPublishedUrl(ctx: ScenarioContext): string | null {
  // Newest agent-chat entry containing a /files/pub/ link wins.
  const entries = [...ctx.transcript.all()].reverse();
  for (const e of entries) {
    if (e.source !== 'agent-chat') continue;
    const m = /https?:\/\/\S+\/files\/pub\/\S+/.exec(e.text);
    if (m) return m[0].replace(/[)\]>.,]+$/, '');
  }
  return null;
}

export const publishFile: Scenario = {
  name: 'publish-file',
  description:
    'agent creates a file, publishes it via publish_file, replies with the signed URL; harness fetches the URL and verifies content + expiry semantics.',
  steps: [
    {
      kind: 'turn',
      text:
        `Please do exactly this, without asking me anything: create a file in your workspace ` +
        `named smoke-publish.md whose entire content is the single line "${nonce}", publish it ` +
        `with your publish_file tool with a 2 hour expiry, and reply with the published URL.`,
    },
    { kind: 'wait-chat', within: 180000, matching: /\/files\/pub\//, label: 'reply containing a /files/pub/ URL' },
    {
      kind: 'check',
      label: 'fetch the published URL — 200 + nonce content',
      fn: async (ctx) => {
        const url = extractPublishedUrl(ctx);
        if (!url) return { ok: false, details: 'no /files/pub/ URL found in any agent-chat entry' };
        const res = await fetch(url);
        const body = await res.text();
        if (res.status !== 200) return { ok: false, details: `GET ${url} → ${res.status}: ${body.slice(0, 200)}` };
        if (!body.includes(nonce)) {
          return { ok: false, details: `content mismatch: expected "${nonce}", got "${body.slice(0, 120)}"` };
        }
        return { ok: true, details: `${url} → 200, nonce matched` };
      },
    },
    {
      kind: 'check',
      label: 'tampered expiry is refused',
      fn: async (ctx) => {
        const url = extractPublishedUrl(ctx);
        if (!url) return { ok: false, details: 'no URL to tamper with' };
        const tampered = new URL(url);
        tampered.searchParams.set('exp', '9999999999');
        const res = await fetch(tampered.toString());
        return res.status === 404
          ? { ok: true, details: 'tampered exp → 404' }
          : { ok: false, details: `tampered exp → ${res.status} (expected 404)` };
      },
    },
    {
      kind: 'judge',
      label: 'clean reply with just the link',
      rubric:
        'Did the agent reply with the published file URL (a /files/pub/ link) without asking clarifying questions and without inventing extra unrequested work? Minor pleasantries are fine.',
    },
  ],
  acceptanceMs: 240000,
};
