"use client";

import { useState, useEffect, useCallback, use } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LegislatorCard } from "@/components/legislator/legislator-card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import type { Legislator, Initiative } from "@/lib/types";

interface SponsoredBill {
  id: string;
  congress: number;
  type: string;
  number: number;
  title: string;
  policyArea: string;
  introducedDate: string;
  latestAction?: string;
  latestActionDate?: string;
  url: string;
}

export default function DashboardPage({ params }: { params: Promise<{ legislatorId: string }> }) {
  const { legislatorId } = use(params);
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session") || "";
  const router = useRouter();

  const [legislator, setLegislator] = useState<Legislator | null>(null);
  const [initiatives, setInitiatives] = useState<Initiative[]>([]);
  const [bills, setBills] = useState<SponsoredBill[]>([]);
  const [billsLoading, setBillsLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [researchingBill, setResearchingBill] = useState<string | null>(null);

  // Inline initiative creation
  const [newInitiative, setNewInitiative] = useState("");
  const [creating, setCreating] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [legRes, initRes] = await Promise.all([
        fetch(`/api/legislators/${legislatorId}`),
        fetch(`/api/initiatives?legislatorId=${legislatorId}`),
      ]);

      if (legRes.ok) setLegislator(await legRes.json());
      if (initRes.ok) {
        const data = await initRes.json();
        setInitiatives(data.initiatives || []);
      }
    } finally {
      setLoading(false);
    }
  }, [legislatorId]);

  const fetchBills = useCallback(async () => {
    setBillsLoading(true);
    try {
      const res = await fetch(`/api/legislators/${legislatorId}/bills`);
      if (res.ok) {
        const data = await res.json();
        setBills(data.bills || []);
      }
    } finally {
      setBillsLoading(false);
    }
  }, [legislatorId]);

  useEffect(() => {
    fetchData();
    fetchBills();
  }, [fetchData, fetchBills]);

  const pushToResearch = (data: { researchId: string; legislatorName?: string; legislatorParty?: string; legislatorState?: string; initiativeTitle?: string }) => {
    const params = new URLSearchParams();
    if (data.legislatorName) params.set("leg", data.legislatorName);
    if (data.legislatorParty) params.set("party", data.legislatorParty);
    if (data.legislatorState) params.set("state", data.legislatorState);
    if (data.initiativeTitle) params.set("init", data.initiativeTitle);
    const qs = params.toString();
    router.push(`/research/${data.researchId}${qs ? "?" + qs : ""}`);
  };

  const handleLaunchResearch = async (initiativeId: string) => {
    const res = await fetch("/api/research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initiativeId }),
    });

    if (res.ok) {
      const data = await res.json();
      pushToResearch(data);
    }
  };

  // Create initiative + launch research in one call
  const handleCreateAndResearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newInitiative.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          legislatorId,
          title: newInitiative.trim(),
        }),
      });
      if (res.ok) {
        const data = await res.json();
        pushToResearch(data);
      } else {
        console.error("Failed to launch research:", await res.text());
      }
    } finally {
      setCreating(false);
    }
  };

  // "Find Allies for Bill": single call to create initiative + launch research
  const handleResearchBill = async (bill: SponsoredBill) => {
    setResearchingBill(bill.id);
    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          legislatorId,
          title: bill.title,
          policyArea: bill.policyArea || "Other",
          existingBillIds: [bill.id],
        }),
      });
      if (res.ok) {
        const data = await res.json();
        pushToResearch(data);
      } else {
        console.error("Failed to launch research:", await res.text());
      }
    } catch (err) {
      console.error("Research bill error:", err);
    } finally {
      setResearchingBill(null);
    }
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <Spinner size="lg" />
          <p className="body-lg text-ink-muted mt-4">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ── Fixed chrome: compact legislator header + inline create ── */}
      <div className="flex-shrink-0 max-w-5xl mx-auto w-full px-6 pt-4 pb-3">
        {legislator && (
          <div className="flex items-center gap-4">
            <LegislatorCard
              name={legislator.name}
              party={legislator.party}
              chamber={legislator.chamber}
              state={legislator.state}
              district={legislator.district}
              imageUrl={legislator.imageUrl}
              size="sm"
            />
          </div>
        )}

        {/* Inline initiative input */}
        <form onSubmit={handleCreateAndResearch} className="mt-3 flex gap-2">
          <input
            type="text"
            value={newInitiative}
            onChange={(e) => setNewInitiative(e.target.value)}
            placeholder="Describe a policy goal to find allies for..."
            className="flex-1 px-4 py-2.5 text-sm bg-surface-bright ghost-border
              focus:ring-2 focus:ring-gold/30 focus:outline-none
              placeholder:text-ink-muted transition-tonal"
          />
          <Button type="submit" size="md" disabled={creating || !newInitiative.trim()}>
            {creating ? "..." : "Find Allies"}
          </Button>
        </form>

        <div className="mt-3 h-px bg-surface-high" />
      </div>

      {/* ── Scrollable content ── */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-5xl mx-auto w-full px-6 py-4">
          {/* Sponsored Bills — full width grid */}
          <div>
            <div className="flex items-center gap-2 mb-4">
              <h2 className="label-md">Sponsored Bills</h2>
              {billsLoading && <Spinner size="sm" />}
            </div>

            {billsLoading ? (
              <div className="bg-surface-low p-6 text-center">
                <Spinner size="sm" className="mx-auto mb-2" />
                <p className="text-xs text-ink-muted">Fetching from Congress.gov...</p>
              </div>
            ) : bills.length === 0 ? (
              <div className="bg-surface-low p-6 text-center">
                <p className="text-sm text-ink-muted">No sponsored bills found.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {bills.map((bill) => {
                  const alreadyImported = initiatives.some(
                    (init) => init.existingBillIds?.includes(bill.id)
                  );
                  return (
                    <Card key={bill.id} padding="sm" className="flex flex-col justify-between gap-2">
                      <div>
                        <div className="flex items-start justify-between gap-2 mb-1.5">
                          <Badge variant="navy" size="sm">{bill.type}{bill.number}</Badge>
                          <Badge variant="default" size="sm">{bill.policyArea}</Badge>
                        </div>
                        <p className="text-sm font-medium text-ink leading-snug">
                          {bill.title}
                        </p>
                      </div>
                      {alreadyImported ? (
                        <span className="label-md text-emerald-600">Researched</span>
                      ) : (
                        <Button
                          size="sm"
                          onClick={() => handleResearchBill(bill)}
                          disabled={researchingBill === bill.id}
                          className="w-full"
                        >
                          {researchingBill === bill.id ? "Starting..." : "Find Allies for Bill"}
                        </Button>
                      )}
                    </Card>
                  );
                })}
              </div>
            )}
          </div>

          {/* Previous Research — only show if there's history */}
          {initiatives.length > 0 && (
            <div className="mt-8">
              <h2 className="label-md mb-3">Previous Research</h2>
              <div className="space-y-2">
                {initiatives.map((initiative) => (
                  <div key={initiative.id} className="flex items-center justify-between gap-4 bg-surface-low px-4 py-2.5">
                    <span className="text-sm text-ink truncate flex-1">{initiative.title}</span>
                    <Badge variant={initiative.status === "completed" ? "green" : initiative.status === "researching" ? "gold" : "default"} size="sm">
                      {initiative.status}
                    </Badge>
                    <Button
                      size="sm"
                      onClick={() => handleLaunchResearch(initiative.id)}
                      disabled={initiative.status === "researching"}
                    >
                      {initiative.status === "researching" ? "Running..." : "View"}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
