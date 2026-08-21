import { Badge } from "@/components/ui/badge";
import type { Party } from "@/lib/types";

const partyConfig: Record<Party, { label: string; variant: "blue" | "red" | "purple" }> = {
  D: { label: "Democrat", variant: "blue" },
  R: { label: "Republican", variant: "red" },
  I: { label: "Independent", variant: "purple" },
};

export function PartyBadge({ party, size = "md" }: { party: Party; size?: "sm" | "md" }) {
  const config = partyConfig[party];
  return (
    <Badge variant={config.variant} size={size}>
      {config.label}
    </Badge>
  );
}
