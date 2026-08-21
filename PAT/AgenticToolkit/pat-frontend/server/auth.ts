/**
 * PAT: operator auth for the control-plane API (Phase 0).
 *
 * Correct OAuth, no minted tokens. Operators authenticate via their Clerk
 * session: pat-frontend serves the SPA and /api on the SAME origin, so Clerk's
 * `__session` cookie is sent automatically on every request — including the
 * Timeline's EventSource (which can't set headers) — and we verify it with
 * `@clerk/backend`'s `authenticateRequest` (reads the cookie OR an Authorization
 * Bearer). No middleware needed, so it works on streaming routes too.
 *
 * The viewer token (PAT_VIEWER_TOKEN) is LEGACY — kept only for machine/iframe
 * callers (e.g. the pat-web embed) that have no Clerk session. Operators never
 * receive or use it.
 *
 * Identity, not (yet) authorization: the @palisaderesearch.org domain check is
 * the gate. Per-person roles (person_roles) layer on later.
 */
import { createClerkClient } from '@clerk/backend';
import type { Context } from 'hono';

const ALLOWED_DOMAIN = 'palisaderesearch.org';

// Origins allowed to authenticate (CSRF protection — Clerk validates the token's
// `azp` against this list). Our own surfaces only.
const AUTHORIZED_PARTIES = [
  'https://pat.plsd.app', // PAT: prod custom domain
  'https://pat-staging.plsd.app', // PAT: staging custom domain
  'https://pat-frontend.fly.dev',
  'https://pat-frontend-staging.fly.dev',
  'http://localhost:5173',
  'http://localhost:5174',
];

export interface Operator {
  userId: string;
  email: string;
  firstName?: string;
  lastName?: string;
}

let _clerk: ReturnType<typeof createClerkClient> | null = null;
function clerk() {
  if (!_clerk) {
    _clerk = createClerkClient({
      secretKey: process.env.CLERK_SECRET_KEY,
      // Dual-use (plans/deployment-and-credentials.md): the publishable key is
      // PUBLIC_ (client-injected) but @clerk/hono needs it server-side too.
      publishableKey: process.env.PUBLIC_CLERK_PUBLISHABLE_KEY ?? process.env.CLERK_PUBLISHABLE_KEY,
    });
  }
  return _clerk;
}

/** Pure domain gate — the testable core of the auth decision. Parse-don't-
 *  suffix-match: require exactly one '@' and an exact domain match, so tricks
 *  like `a@b@palisaderesearch.org` or `x@palisaderesearch.org.evil.com` fail. */
export function isOperatorEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  const at = e.indexOf('@');
  if (at <= 0 || at !== e.lastIndexOf('@')) return false; // exactly one '@', non-empty local part
  return e.slice(at + 1) === ALLOWED_DOMAIN;
}

/** True when Clerk is configured (keys present). */
export function clerkEnabled(): boolean {
  return !!process.env.CLERK_SECRET_KEY;
}

/**
 * Resolve the authenticated operator for a request, or null (→ 403).
 *
 * Verifies the Clerk session (cookie or Bearer) with authenticateRequest — no
 * middleware, so this is safe on streaming routes. Dev bypass:
 * ADMIN_DEV_NO_AUTH=1 stubs an operator locally without Clerk keys.
 */
export async function requireOperator(c: Context): Promise<Operator | null> {
  if (process.env.ADMIN_DEV_NO_AUTH === '1') {
    return { userId: 'dev', email: 'dev@palisaderesearch.org' };
  }
  if (!clerkEnabled()) return null;

  let userId: string;
  try {
    const requestState = await clerk().authenticateRequest(c.req.raw, {
      authorizedParties: AUTHORIZED_PARTIES,
    });
    if (!requestState.isSignedIn) return null;
    const auth = requestState.toAuth();
    if (!auth?.userId) return null;
    userId = auth.userId;
  } catch {
    return null;
  }

  try {
    const user = await clerk().users.getUser(userId);
    const email =
      user.primaryEmailAddress?.emailAddress?.toLowerCase() ??
      user.emailAddresses?.[0]?.emailAddress?.toLowerCase();
    if (!isOperatorEmail(email)) return null;
    return {
      userId,
      email: email!,
      firstName: user.firstName ?? undefined,
      lastName: user.lastName ?? undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Route gate: a valid operator (Clerk session — the normal path) OR the legacy
 * viewer token (machine/iframe-embed only). Returns true when authorized.
 */
export async function requireOperatorOrToken(c: Context, viewerToken: string): Promise<boolean> {
  const t = c.req.query('token') ?? '';
  if (viewerToken && t === viewerToken) return true; // legacy machine/embed path
  return (await requireOperator(c)) !== null;
}
