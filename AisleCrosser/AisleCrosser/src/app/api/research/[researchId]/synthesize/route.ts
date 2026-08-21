import { NextRequest, NextResponse } from "next/server";
import { getResearch, updateResearch } from "@/lib/store/research";
import { getLegislator } from "@/lib/store/legislators";
import { getInitiative } from "@/lib/store/initiatives";
import { synthesizeCandidate } from "@/lib/agents/orchestrator";

export const maxDuration = 60;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ researchId: string }> }
) {
  const { researchId } = await params;
  const { candidateName } = await request.json();
  if (!candidateName) {
    return NextResponse.json({ error: "candidateName required" }, { status: 400 });
  }

  const research = await getResearch(researchId);
  if (!research) {
    return NextResponse.json({ error: "Research not found" }, { status: 404 });
  }

  const candidate = research.candidates?.find(
    (c: { name: string }) => c.name.toLowerCase() === candidateName.toLowerCase()
  );
  if (!candidate) {
    return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
  }

  if (candidate.approachStrategy) {
    return NextResponse.json({
      approachStrategy: candidate.approachStrategy,
      talkingPoints: candidate.talkingPoints || [],
      sharedInterests: candidate.sharedInterests || [],
    });
  }

  const legislator = await getLegislator(research.legislatorId);
  if (!legislator) {
    return NextResponse.json({ error: "Legislator not found" }, { status: 404 });
  }

  const initiative = await getInitiative(research.initiativeId);
  if (!initiative) {
    return NextResponse.json({ error: "Initiative not found" }, { status: 404 });
  }

  try {
    const result = await synthesizeCandidate(candidate, legislator, initiative);

    candidate.approachStrategy = result.approachStrategy;
    candidate.talkingPoints = result.talkingPoints;
    candidate.sharedInterests = result.sharedInterests;
    candidate.status = "synthesized";
    await updateResearch(researchId, { candidates: research.candidates });

    return NextResponse.json(result);
  } catch (err) {
    console.error(`[synthesize] Failed for ${candidateName}:`, err);
    return NextResponse.json({ error: "Synthesis failed" }, { status: 500 });
  }
}
