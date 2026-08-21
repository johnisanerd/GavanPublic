import type { Research } from "../types";
import type { FeedbackState } from "../types/agent";
import { readJSON, writeJSON, listJSON } from "./base";

export async function getResearch(id: string): Promise<Research | null> {
  return readJSON<Research>(`research/${id}.json`);
}

export async function createResearch(research: Research): Promise<void> {
  await writeJSON(`research/${research.id}.json`, research);
}

export async function updateResearch(id: string, updates: Partial<Research>): Promise<Research | null> {
  const research = await getResearch(id);
  if (!research) return null;
  const updated = { ...research, ...updates };
  await writeJSON(`research/${id}.json`, updated);
  return updated;
}

export async function listResearchByInitiative(initiativeId: string): Promise<Research[]> {
  const all = await listJSON<Research>("research");
  return all.filter((r) => r.initiativeId === initiativeId);
}

export async function submitFeedback(
  researchId: string,
  targetType: "recommendation" | "reasoning_step",
  targetId: string,
  feedback: FeedbackState
): Promise<boolean> {
  const research = await getResearch(researchId);
  if (!research) return false;

  if (targetType === "recommendation") {
    const rec = research.recommendations.find((r) => r.id === targetId);
    if (!rec) return false;
    rec.feedback = feedback;
  } else {
    for (const rec of research.recommendations) {
      const step = rec.reasoningChain.find((s) => s.id === targetId);
      if (step) {
        // Store feedback on the recommendation level referencing the step
        if (!rec.feedback) rec.feedback = feedback;
        break;
      }
    }
  }

  await writeJSON(`research/${researchId}.json`, research);
  return true;
}
