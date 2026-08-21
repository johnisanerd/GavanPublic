import type { Session } from "../types";
import { readJSON, writeJSON } from "./base";

export async function getSession(id: string): Promise<Session | null> {
  return readJSON<Session>(`sessions/${id}.json`);
}

export async function createSession(session: Session): Promise<void> {
  await writeJSON(`sessions/${session.id}.json`, session);
}

export async function updateSession(id: string, updates: Partial<Session>): Promise<Session | null> {
  const session = await getSession(id);
  if (!session) return null;
  const updated = { ...session, ...updates };
  await writeJSON(`sessions/${id}.json`, updated);
  return updated;
}
