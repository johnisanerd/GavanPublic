// PAT (webapp security): the pat-web public-endpoint token. When the app is
// locked down (the server has PAT_WEB_TOKEN set), the browser reads its token
// from the page URL (?token=…, shared in the demo link) and sends it on the
// gated POSTs (session-token, scenarios/upload, log-event, session-ended,
// barge-in). Empty when the app runs open (no token in the URL) — the server
// treats an unset PAT_WEB_TOKEN as open too, so this is a no-op in that mode.
//
// This is DISTINCT from the CRM-log-reading PAT_VIEWER_TOKEN — never reuse that.
const _params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
export const PAT_WEB_TOKEN = _params.get('token') ?? '';

/** Merge the pat-web token header into a fetch headers object (no-op when open). */
export function patWebHeaders(base: Record<string, string> = {}): Record<string, string> {
  return PAT_WEB_TOKEN ? { ...base, 'x-pat-web-token': PAT_WEB_TOKEN } : base;
}
