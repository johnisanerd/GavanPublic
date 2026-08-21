import { Card } from "@/components/ui/card";
import { PartyBadge } from "./party-badge";
import type { Party, Chamber } from "@/lib/types";

interface LegislatorCardProps {
  name: string;
  party: Party;
  chamber: Chamber;
  state: string;
  district?: number;
  imageUrl?: string;
  size?: "sm" | "lg";
  onClick?: () => void;
}

export function LegislatorCard({
  name,
  party,
  chamber,
  state,
  district,
  imageUrl,
  size = "sm",
  onClick,
}: LegislatorCardProps) {
  const isClickable = !!onClick;

  return (
    <Card
      padding={size === "lg" ? "lg" : "md"}
      className={`flex items-center gap-5 ${isClickable ? "cursor-pointer hover:bg-surface-low transition-tonal" : ""}`}
      onClick={onClick}
    >
      <div className={`${size === "lg" ? "h-16 w-16" : "h-12 w-12"} bg-surface-mid flex items-center justify-center overflow-hidden flex-shrink-0`}>
        {imageUrl ? (
          <img src={imageUrl} alt={name} className="h-full w-full object-cover" />
        ) : (
          <span className={`${size === "lg" ? "text-xl" : "text-base"} font-serif font-bold text-ink-muted`}>
            {name.split(" ").map((n) => n[0]).join("")}
          </span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <h3 className={`${size === "lg" ? "headline-md" : "title-lg"} ${size === "lg" ? "" : "truncate"}`}>
          {name}
        </h3>
        <div className="flex items-center gap-3 mt-1 flex-wrap">
          <PartyBadge party={party} size="sm" />
          <span className="label-md">
            {state}{district ? `-${district}` : ""} &middot; {chamber === "senate" ? "Senate" : "House"}
          </span>
        </div>
      </div>
    </Card>
  );
}
