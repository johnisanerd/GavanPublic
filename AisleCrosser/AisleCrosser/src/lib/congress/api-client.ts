const CONGRESS_BASE = "https://api.congress.gov/v3";
const GOVTRACK_BASE = "https://www.govtrack.us/api/v2";

function getCongressApiKey(): string {
  return process.env.CONGRESS_API_KEY || "";
}

export async function fetchCongressMembers(chamber: "senate" | "house", congress = 118) {
  const apiKey = getCongressApiKey();
  const url = `${CONGRESS_BASE}/member?chamber=${chamber}&congress=${congress}&limit=250&api_key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Congress API error: ${res.status}`);
  return res.json();
}

export async function fetchMemberDetails(bioguideId: string) {
  const apiKey = getCongressApiKey();
  const url = `${CONGRESS_BASE}/member/${bioguideId}?api_key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Congress API error: ${res.status}`);
  return res.json();
}

export async function fetchBillsByMember(bioguideId: string) {
  const apiKey = getCongressApiKey();
  const url = `${CONGRESS_BASE}/member/${bioguideId}/sponsored-legislation?limit=20&api_key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Congress API error: ${res.status}`);
  return res.json();
}

export async function fetchGovTrackPerson(query: string) {
  const url = `${GOVTRACK_BASE}/person?q=${encodeURIComponent(query)}&limit=10`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GovTrack API error: ${res.status}`);
  return res.json();
}

export async function fetchGovTrackVotes(personId: number, session?: number) {
  let url = `${GOVTRACK_BASE}/vote_voter?person=${personId}&limit=50&order_by=-created`;
  if (session) url += `&session=${session}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GovTrack API error: ${res.status}`);
  return res.json();
}

export async function fetchGovTrackCosponsorship(billId: number) {
  const url = `${GOVTRACK_BASE}/cosponsorship?bill=${billId}&limit=50`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GovTrack API error: ${res.status}`);
  return res.json();
}
