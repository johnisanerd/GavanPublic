import type { Initiative } from "../types";
import { readJSON, writeJSON, deleteJSON, listJSON } from "./base";

export async function getInitiative(id: string): Promise<Initiative | null> {
  return readJSON<Initiative>(`initiatives/${id}.json`);
}

export async function createInitiative(initiative: Initiative): Promise<void> {
  await writeJSON(`initiatives/${initiative.id}.json`, initiative);
}

export async function updateInitiative(id: string, updates: Partial<Initiative>): Promise<Initiative | null> {
  const initiative = await getInitiative(id);
  if (!initiative) return null;
  const updated = { ...initiative, ...updates, updatedAt: new Date().toISOString() };
  await writeJSON(`initiatives/${id}.json`, updated);
  return updated;
}

export async function deleteInitiative(id: string): Promise<boolean> {
  return deleteJSON(`initiatives/${id}.json`);
}

export async function listInitiativesByLegislator(legislatorId: string): Promise<Initiative[]> {
  const all = await listJSON<Initiative>("initiatives");
  return all.filter((i) => i.legislatorId === legislatorId);
}
