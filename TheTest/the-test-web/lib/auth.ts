import { currentUser } from "@clerk/nextjs/server";

import { DEV_NO_AUTH } from "@/lib/dev-no-auth";

// Belt-and-suspenders domain gate (in addition to Clerk's dashboard allowlist).
const ALLOWED_DOMAIN = "palisaderesearch.org";

export async function requirePalisadeUser(): Promise<{ email: string } | null> {
  // Dev-only: stub the viewer locally so the admin renders without Clerk keys.
  // DEV_NO_AUTH can only be true in a non-production build (see lib/dev-no-auth.ts).
  if (DEV_NO_AUTH) {
    return { email: "dev@palisaderesearch.org" };
  }
  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress?.toLowerCase() ?? "";
  return email.endsWith("@" + ALLOWED_DOMAIN) ? { email } : null;
}
