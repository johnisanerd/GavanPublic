"use client";

import { useState, useEffect, useCallback } from "react";
import { LegislatorCard } from "./legislator-card";
import type { LegislatorSearchResult, Chamber } from "@/lib/types";

interface LegislatorSearchProps {
  onSelect: (legislator: LegislatorSearchResult) => void;
}

export function LegislatorSearch({ onSelect }: LegislatorSearchProps) {
  const [chamber, setChamber] = useState<Chamber>("senate");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LegislatorSearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  const search = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ chamber });
      if (query) params.set("q", query);
      const res = await fetch(`/api/legislators?${params}`);
      const data = await res.json();
      // Shuffle results so it's not always Dems before Reps
      const list = data.legislators || [];
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      setResults(list);
    } finally {
      setLoading(false);
    }
  }, [chamber, query]);

  useEffect(() => {
    const timeout = setTimeout(search, 300);
    return () => clearTimeout(timeout);
  }, [search]);

  return (
    <div className="h-full flex flex-col gap-3">
      {/* Chamber Toggle */}
      <div className="flex-shrink-0 flex gap-0">
        <button
          onClick={() => setChamber("senate")}
          className={`flex-1 py-3 px-6 text-base font-semibold transition-tonal ${
            chamber === "senate"
              ? "bg-navy text-white"
              : "bg-surface-low text-ink-muted hover:bg-surface-mid"
          }`}
        >
          Senate
        </button>
        <button
          onClick={() => setChamber("house")}
          className={`flex-1 py-3 px-6 text-base font-semibold transition-tonal ${
            chamber === "house"
              ? "bg-navy text-white"
              : "bg-surface-low text-ink-muted hover:bg-surface-mid"
          }`}
        >
          House
        </button>
      </div>

      {/* Search Input */}
      <input
        type="text"
        placeholder="Search by name or state..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="flex-shrink-0 w-full px-5 py-3 text-base bg-surface-bright ghost-border
          focus:ring-2 focus:ring-gold/30 focus:outline-none
          placeholder:text-ink-muted transition-tonal"
      />

      {/* Results — fills remaining space and scrolls */}
      <div className="flex-1 min-h-0 overflow-y-auto space-y-3 ghost-border bg-surface-bright p-3">
        {loading ? (
          <div className="text-center py-16 text-ink-muted body-lg">Searching...</div>
        ) : results.length === 0 ? (
          <div className="text-center py-16 text-ink-muted body-lg">No legislators found</div>
        ) : (
          results.map((leg) => (
            <LegislatorCard
              key={leg.id}
              name={leg.name}
              party={leg.party}
              chamber={leg.chamber}
              state={leg.state}
              district={leg.district}
              imageUrl={leg.imageUrl}
              onClick={() => onSelect(leg)}
            />
          ))
        )}
      </div>
    </div>
  );
}
