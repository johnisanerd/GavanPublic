/**
 * PUBLIC_ runtime env injection — the client half of the credential prefix model
 * (`plans/deployment-and-credentials.md`, Pillar B).
 *
 * Any env var named `PUBLIC_<NAME>` is, by convention, safe to expose to the
 * browser. At serve time we strip the `PUBLIC_` prefix and inject the result as
 * `window.__PUBLIC_ENV__` via a synchronous inline <script> in <head> — so it's
 * defined before the deferred module bundle runs (no async flash, no fetch).
 *
 * This replaces the old `VITE_`-build-arg mechanism (Clerk publishable key baked
 * into the bundle at build time): the value is now a plain runtime Fly secret
 * (`PUBLIC_CLERK_PUBLISHABLE_KEY`), so a deploy can never ship a keyless client.
 *
 * The SAME mechanism runs in dev (a vite `transformIndexHtml` plugin reads
 * `PUBLIC_*` from the loaded .env) and in prod (the Hono server, below) — so the
 * client only ever reads `window.__PUBLIC_ENV__`, never `import.meta.env`.
 */

const PREFIX = 'PUBLIC_';

/** PUBLIC_-prefixed env vars, prefix stripped → canonical name. */
export function collectPublicEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith(PREFIX) && v != null && v !== '') out[k.slice(PREFIX.length)] = v;
  }
  return out;
}

/**
 * A synchronous inline <script> assigning `window.__PUBLIC_ENV__`. `<` is escaped
 * so a value can never close the <script> tag (XSS-safe inline JSON).
 */
export function buildPublicEnvScript(env: Record<string, string | undefined>): string {
  const json = JSON.stringify(collectPublicEnv(env)).replace(/</g, '\\u003c');
  return `<script>window.__PUBLIC_ENV__=${json};</script>`;
}

/** Insert the public-env script just before </head> (or prepend if none). */
export function injectPublicEnv(html: string, env: Record<string, string | undefined>): string {
  const script = buildPublicEnvScript(env);
  return html.includes('</head>') ? html.replace('</head>', `${script}</head>`) : `${script}${html}`;
}
