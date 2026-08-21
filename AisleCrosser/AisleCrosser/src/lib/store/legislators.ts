import type { Legislator, LegislatorSearchResult, Chamber, Party } from "../types";
import { readJSON, writeJSON } from "./base";

interface LegislatorIndex {
  legislators: Legislator[];
  lastUpdated: string;
}

export async function getLegislatorIndex(): Promise<Legislator[]> {
  const index = await readJSON<LegislatorIndex>("legislators.json");
  return index?.legislators ?? [];
}

export async function getLegislator(id: string): Promise<Legislator | null> {
  const legislators = await getLegislatorIndex();
  return legislators.find((l) => l.id === id) ?? null;
}

export async function searchLegislators(params: {
  q?: string;
  chamber?: Chamber;
  party?: Party;
  state?: string;
}): Promise<LegislatorSearchResult[]> {
  let legislators = await getLegislatorIndex();

  if (params.chamber) {
    legislators = legislators.filter((l) => l.chamber === params.chamber);
  }
  if (params.party) {
    legislators = legislators.filter((l) => l.party === params.party);
  }
  if (params.state) {
    legislators = legislators.filter((l) => l.state.toLowerCase() === params.state!.toLowerCase());
  }
  if (params.q) {
    const query = params.q.toLowerCase();
    legislators = legislators.filter(
      (l) =>
        l.name.toLowerCase().includes(query) ||
        l.firstName.toLowerCase().includes(query) ||
        l.lastName.toLowerCase().includes(query) ||
        l.state.toLowerCase().includes(query)
    );
  }

  return legislators.map((l) => ({
    id: l.id,
    name: l.name,
    party: l.party,
    chamber: l.chamber,
    state: l.state,
    district: l.district,
    imageUrl: l.imageUrl,
  }));
}

export async function saveLegislatorIndex(legislators: Legislator[]): Promise<void> {
  await writeJSON("legislators.json", {
    legislators,
    lastUpdated: new Date().toISOString(),
  });
}
