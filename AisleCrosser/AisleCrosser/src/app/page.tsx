"use client";

import { useRouter } from "next/navigation";
import { LegislatorSearch } from "@/components/legislator/legislator-search";
import type { LegislatorSearchResult } from "@/lib/types";

export default function HomePage() {
  const router = useRouter();

  const handleSelect = async (legislator: LegislatorSearchResult) => {
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ legislatorId: legislator.id }),
    });

    if (res.ok) {
      const session = await res.json();
      router.push(`/dashboard/${legislator.id}?session=${session.id}`);
    }
  };

  return (
    <div className="h-full flex flex-col overflow-hidden max-w-2xl mx-auto px-6 pt-6">
      <div className="flex-shrink-0 mb-5">
        <h1 className="display-lg mb-2">
          Find Allies
        </h1>
        <p className="body-lg max-w-lg">
          Select a legislator to find cross-party allies.
        </p>
      </div>

      <div className="flex-1 min-h-0 pb-6">
        <LegislatorSearch onSelect={handleSelect} />
      </div>
    </div>
  );
}
