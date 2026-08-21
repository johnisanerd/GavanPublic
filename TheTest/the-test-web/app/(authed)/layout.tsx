import { ClerkProvider } from "@clerk/nextjs";

import { DEV_NO_AUTH } from "@/lib/dev-no-auth";

// Clerk context only wraps the authed subtree (admin + sign-in), so the
// public root layout / pages never depend on Clerk being configured.
export default function AuthedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Dev-only: skip ClerkProvider locally (it throws without keys) so the admin
  // renders for design work. DEV_NO_AUTH is non-prod-only (see lib/dev-no-auth.ts).
  if (DEV_NO_AUTH) {
    return <>{children}</>;
  }
  return <ClerkProvider>{children}</ClerkProvider>;
}
