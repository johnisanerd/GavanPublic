import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { createResearch } from "@/lib/store/research";
import { getInitiative, createInitiative } from "@/lib/store/initiatives";
import { getLegislator } from "@/lib/store/legislators";
import { launchResearchSchema } from "@/lib/utils/validation";
import { generateId } from "@/lib/utils/ids";
import { runResearch } from "@/lib/agents/orchestrator";

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const body = await request.json();
  const parsed = launchResearchSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.issues }, { status: 400 });
  }

  const data = parsed.data;
  let initiativeId: string;
  let legislatorId: string;
  let initiativeTitle: string;

  if ("initiativeId" in data) {
    const initiative = await getInitiative(data.initiativeId);
    if (!initiative) {
      return NextResponse.json({ error: "Initiative not found" }, { status: 404 });
    }
    initiativeId = initiative.id;
    legislatorId = initiative.legislatorId;
    initiativeTitle = initiative.title;
  } else {
    const now = new Date().toISOString();
    const initiative = {
      id: generateId("init"),
      sessionId: "default",
      legislatorId: data.legislatorId,
      title: data.title,
      description: data.description || data.title,
      policyArea: data.policyArea || "Other",
      goals: data.goals || ["Find cross-party allies"],
      existingBillIds: data.existingBillIds,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    };
    await createInitiative(initiative);
    initiativeId = initiative.id;
    legislatorId = data.legislatorId;
    initiativeTitle = data.title;
  }

  // Fetch legislator info to embed in research record
  const legislator = await getLegislator(legislatorId);

  const research = {
    id: generateId("res"),
    initiativeId,
    legislatorId,
    initiativeTitle,
    legislatorName: legislator?.name,
    legislatorParty: legislator?.party,
    legislatorState: legislator?.state,
    status: "queued" as const,
    agents: [],
    candidates: [],
    recommendations: [],
    startedAt: new Date().toISOString(),
  };

  await createResearch(research);

  after(async () => {
    try {
      await runResearch(research.id);
    } catch (err) {
      console.error(`Research ${research.id} failed:`, err);
    }
  });

  return NextResponse.json({
    researchId: research.id,
    legislatorName: research.legislatorName,
    legislatorParty: research.legislatorParty,
    legislatorState: research.legislatorState,
    initiativeTitle: research.initiativeTitle,
  }, { status: 201 });
}
