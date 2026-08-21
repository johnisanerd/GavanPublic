"use client";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Initiative } from "@/lib/types";

interface InitiativeCardProps {
  initiative: Initiative;
  onLaunchResearch: (initiativeId: string) => void;
}

const statusVariants = {
  draft: "default",
  active: "navy",
  researching: "gold",
  completed: "green",
} as const;

export function InitiativeCard({ initiative, onLaunchResearch }: InitiativeCardProps) {
  return (
    <Card padding="lg" className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h3 className="title-lg">{initiative.title}</h3>
          <div className="flex items-center gap-3 mt-2">
            <Badge variant={statusVariants[initiative.status]}>{initiative.status}</Badge>
            <Badge variant="navy">{initiative.policyArea}</Badge>
          </div>
        </div>
      </div>

      <p className="body-lg">{initiative.description}</p>

      {initiative.goals.length > 0 && (
        <div>
          <h4 className="label-md mb-3">Goals</h4>
          <ul className="space-y-2">
            {initiative.goals.map((goal, i) => (
              <li key={i} className="flex items-start gap-3 body-lg">
                <span className="text-gold mt-0.5">&#8226;</span>
                {goal}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="pt-2">
        <Button
          size="lg"
          onClick={() => onLaunchResearch(initiative.id)}
          disabled={initiative.status === "researching"}
          className="w-full"
        >
          {initiative.status === "researching" ? "Research in Progress..." : "Find Allies Across the Aisle"}
        </Button>
      </div>
    </Card>
  );
}
