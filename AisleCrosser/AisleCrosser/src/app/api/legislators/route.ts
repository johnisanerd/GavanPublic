import { NextRequest, NextResponse } from "next/server";
import { searchLegislators, getLegislatorIndex, saveLegislatorIndex } from "@/lib/store/legislators";
import { SEED_LEGISLATORS } from "@/lib/congress/seed-data";
import type { Chamber, Party } from "@/lib/types";

async function ensureSeeded() {
  const existing = await getLegislatorIndex();
  if (existing.length === 0) {
    await saveLegislatorIndex(SEED_LEGISLATORS);
  }
}

export async function GET(request: NextRequest) {
  await ensureSeeded();

  const params = request.nextUrl.searchParams;
  const results = await searchLegislators({
    q: params.get("q") || undefined,
    chamber: (params.get("chamber") as Chamber) || undefined,
    party: (params.get("party") as Party) || undefined,
    state: params.get("state") || undefined,
  });

  return NextResponse.json({ legislators: results, count: results.length });
}
