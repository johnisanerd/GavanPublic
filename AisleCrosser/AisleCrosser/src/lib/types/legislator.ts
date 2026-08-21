export type Chamber = "senate" | "house";
export type Party = "D" | "R" | "I";

export interface Legislator {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  chamber: Chamber;
  party: Party;
  state: string;
  district?: number;
  imageUrl?: string;
  phone?: string;
  office?: string;
  committees: string[];
  termStart: string;
  termEnd: string;
}

export interface LegislatorSearchResult {
  id: string;
  name: string;
  party: Party;
  chamber: Chamber;
  state: string;
  district?: number;
  imageUrl?: string;
}
