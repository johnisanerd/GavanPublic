import type { DeepDive } from "../types/deep-dive";
import { readJSON, writeJSON, listJSON } from "./base";

export async function getDeepDive(id: string): Promise<DeepDive | null> {
  return readJSON<DeepDive>(`deep-dives/${id}.json`);
}

export async function createDeepDive(dive: DeepDive): Promise<void> {
  await writeJSON(`deep-dives/${dive.id}.json`, dive);
}

export async function updateDeepDive(id: string, updates: Partial<DeepDive>): Promise<DeepDive | null> {
  const dive = await getDeepDive(id);
  if (!dive) return null;
  const updated = { ...dive, ...updates };
  await writeJSON(`deep-dives/${id}.json`, updated);
  return updated;
}

export async function listDeepDivesByResearch(researchId: string): Promise<DeepDive[]> {
  const all = await listJSON<DeepDive>("deep-dives");
  return all.filter((d) => d.researchId === researchId);
}
