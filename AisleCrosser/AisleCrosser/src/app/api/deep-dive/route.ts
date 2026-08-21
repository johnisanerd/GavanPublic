import { NextResponse, after } from "next/server";
import { launchDeepDiveSchema } from "@/lib/utils/validation";
import { generateId } from "@/lib/utils/ids";
import * as researchStore from "@/lib/store/research";
import * as deepDiveStore from "@/lib/store/deep-dives";
import { runDeepDive } from "@/lib/agents/deep-dive-runner";
import type { DeepDive } from "@/lib/types/deep-dive";

export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = launchDeepDiveSchema.parse(body);

    // Load research to get context
    const research = await researchStore.getResearch(parsed.researchId);
    if (!research) {
      return NextResponse.json({ error: "Research not found" }, { status: 404 });
    }

    // Find the recommendation
    const rec = research.recommendations.find((r) => r.id === parsed.recommendationId);
    if (!rec) {
      return NextResponse.json({ error: "Recommendation not found" }, { status: 404 });
    }

    // Get the connection
    const connections = rec.personalConnections || [];
    if (parsed.connectionIndex >= connections.length) {
      return NextResponse.json({ error: "Connection index out of range" }, { status: 400 });
    }

    const conn = connections[parsed.connectionIndex];

    // Find the initiative title
    const initiative = await (await import("@/lib/store/initiatives")).getInitiative(research.initiativeId);
    const initiativeTitle = initiative?.title || "Unknown Initiative";

    // Create the deep dive record
    const deepDiveId = generateId("dive");
    const dive: DeepDive = {
      id: deepDiveId,
      researchId: parsed.researchId,
      recommendationId: parsed.recommendationId,
      connectionIndex: parsed.connectionIndex,
      connectionType: conn.type,
      connectionDetail: conn.detail,
      targetLegislatorName: rec.targetLegislatorName,
      initiativeTitle,
      status: "queued",
      results: [],
      toolCalls: [],
      startedAt: new Date().toISOString(),
    };

    await deepDiveStore.createDeepDive(dive);

    // Use after() to keep function alive on Vercel
    after(async () => {
      try {
        await runDeepDive(deepDiveId);
      } catch (err) {
        console.error(`[api/deep-dive] Background runner failed for ${deepDiveId}:`, err);
      }
    });

    return NextResponse.json({ deepDiveId });
  } catch (err) {
    console.error("[api/deep-dive] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid request" },
      { status: 400 }
    );
  }
}
