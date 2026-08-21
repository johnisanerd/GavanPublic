import { NextRequest, NextResponse } from "next/server";
import { fetchBillsByMember } from "@/lib/congress/api-client";

interface CongressBill {
  congress: number;
  type: string;
  number: number;
  title: string;
  latestAction?: { text: string; actionDate: string };
  policyArea?: { name: string };
  introducedDate?: string;
  url?: string;
}

// Simple in-memory cache — bills don't change often
const cache = new Map<string, { data: unknown; timestamp: number }>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ legislatorId: string }> }
) {
  const { legislatorId } = await params;

  // Check cache
  const cached = cache.get(legislatorId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return NextResponse.json(cached.data);
  }

  try {
    const raw = await fetchBillsByMember(legislatorId);
    const bills = (raw.sponsoredLegislation || [])
      .filter((bill: CongressBill) => bill.title)
      .map((bill: CongressBill) => {
        const type = bill.type || "BILL";
        const num = bill.number || 0;
        const congress = bill.congress || 118;
        return {
          id: `${type.toLowerCase()}${num}-${congress}`,
          congress,
          type,
          number: num,
          title: bill.title,
          policyArea: bill.policyArea?.name || "General",
          introducedDate: bill.introducedDate || "",
          latestAction: bill.latestAction?.text,
          latestActionDate: bill.latestAction?.actionDate,
          url: num ? `https://congress.gov/bill/${congress}th-congress/${type.toLowerCase().replace(/\./g, "")}-bill/${num}` : "",
        };
      });

    const result = { legislatorId, bills, total: bills.length };
    cache.set(legislatorId, { data: result, timestamp: Date.now() });

    return NextResponse.json(result);
  } catch (err) {
    console.error(`[bills] Failed to fetch bills for ${legislatorId}:`, err);
    return NextResponse.json({ legislatorId, bills: [], total: 0, error: "Failed to fetch from Congress.gov" });
  }
}
