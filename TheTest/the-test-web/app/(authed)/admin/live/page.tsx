import { LiveView } from "./live-view";

export const dynamic = "force-dynamic";

// Research → Live results: incoming responses as they land. Wrapped in the admin
// shell + auth by the (authed)/admin layout.
export default function LivePage() {
  return <LiveView />;
}
