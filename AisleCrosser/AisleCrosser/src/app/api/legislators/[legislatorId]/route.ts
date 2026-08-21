import { NextResponse } from "next/server";
import { getLegislator, getLegislatorIndex, saveLegislatorIndex } from "@/lib/store/legislators";
import { SEED_LEGISLATORS } from "@/lib/congress/seed-data";

async function ensureSeeded() {
  const existing = await getLegislatorIndex();
  if (existing.length === 0) {
    await saveLegislatorIndex(SEED_LEGISLATORS);
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ legislatorId: string }> }
) {
  await ensureSeeded();
  const { legislatorId } = await params;
  const legislator = await getLegislator(legislatorId);

  if (!legislator) {
    return NextResponse.json({ error: "Legislator not found" }, { status: 404 });
  }

  return NextResponse.json(legislator);
}
