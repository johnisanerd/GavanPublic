import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

import { DEV_NO_AUTH } from "@/lib/dev-no-auth";

// Next.js 16 renamed Middleware -> Proxy. Clerk runs from proxy.ts.
// Scoped matcher: Clerk ONLY runs on /admin, /api/admin, /sign-in.
// The public ingestion paths (/api/typeform/webhook, /g/*, /api/health, /)
// never invoke Clerk, so an auth misconfig can't break data collection.
const isPublicRoute = createRouteMatcher(["/sign-in(.*)"]);

// Dev-only escape hatch: skip Clerk entirely so the admin can be rendered
// locally without auth keys, for design work. DEV_NO_AUTH is only ever true in a
// non-production build with the local flag set, so this can NEVER run in a
// deployed env (see lib/dev-no-auth.ts).
const handler = clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export default DEV_NO_AUTH ? () => undefined : handler;

export const config = {
  matcher: [
    "/admin",
    "/admin/:path*",
    "/api/admin/:path*",
    "/sign-in",
    "/sign-in/:path*",
  ],
};
