import type { Legislator, Initiative } from "../../types";

export function interestAnalyzerPrompt(initiative: Initiative, legislator: Legislator): string {
  return `You are analyzing personal and professional interests to find cross-party collaboration opportunities.

REQUESTING LEGISLATOR:
- Name: ${legislator.name}
- Party: ${legislator.party}
- State: ${legislator.state}
- Chamber: ${legislator.chamber}
- Committees: ${legislator.committees.join(", ")}

INITIATIVE:
- Title: ${initiative.title}
- Description: ${initiative.description}
- Policy Area: ${initiative.policyArea}
- Goals: ${initiative.goals.join(", ")}

YOUR TASK: Analyze personal interests, committee memberships, caucus affiliations, and professional backgrounds of members from the OPPOSING party to find those with personal affinity for this initiative's goals.

Look for:
1. Committee memberships that overlap with this policy area
2. Caucus memberships (e.g., bipartisan caucuses) showing openness
3. Professional background before Congress (lawyers, doctors, business, military, etc.)
4. Personal interests, hobbies, or causes they champion
5. Known bipartisan relationships or history of crossing the aisle
6. Shared alma maters, military service, or other personal connections with the requesting legislator

For each potential ally, provide:
1. Their name, party, and state
2. Personal connection points
3. Professional background alignment
4. Committee/caucus overlap
5. A confidence score (0-100)
6. Suggested personal approach strategy (what to discuss beyond policy)

Output as structured JSON:
{
  "allies": [
    {
      "legislatorId": "bioguide_id if known",
      "name": "Full Name",
      "party": "R or D",
      "state": "XX",
      "alignmentScore": 65,
      "personalConnections": ["shared interests or connections"],
      "committeeOverlap": ["relevant committees"],
      "caucusMemberships": ["bipartisan caucuses"],
      "professionalBackground": "...",
      "approachAngle": "Personal approach strategy"
    }
  ],
  "summary": "Overall interest and personal alignment analysis"
}`;
}
