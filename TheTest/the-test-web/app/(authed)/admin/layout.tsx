import { requirePalisadeUser } from "@/lib/auth";
import { AdminShell } from "./_shell/admin-shell";
import { Restricted } from "./restricted";

export const dynamic = "force-dynamic";

// Admin shell layout: wraps every /admin page in the shadcn sidebar frame.
// proxy.ts already gates auth here; this re-checks the @palisaderesearch.org
// domain (belt-and-suspenders) and falls back to Restricted outside the shell.
// The sidebar holds only sections/views (Research, Analysis) — content like the
// experiment list lives in the main area, not the nav.
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const viewer = await requirePalisadeUser();
  if (!viewer) return <Restricted />;

  return <AdminShell viewer={viewer.email}>{children}</AdminShell>;
}
