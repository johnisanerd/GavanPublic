import type { Legislator, Initiative } from "../../types";

export function constituencyAnalyzerPrompt(initiative: Initiative, legislator: Legislator): string {
  return `You are analyzing constituent interests to find cross-party collaboration opportunities.

REQUESTING LEGISLATOR:
- Name: ${legislator.name}
- Party: ${legislator.party}
- State: ${legislator.state}
- Chamber: ${legislator.chamber}

INITIATIVE:
- Title: ${initiative.title}
- Description: ${initiative.description}
- Policy Area: ${initiative.policyArea}
- Goals: ${initiative.goals.join(", ")}

YOUR TASK: Analyze the constituencies of members from the OPPOSING party to identify those whose districts/states have strong overlap with the goals of this initiative.

Consider:
1. Economic profile of their district/state (industries, employment, major employers)
2. Demographic composition and how it relates to the initiative
3. Local issues that align with the initiative's goals
4. Recent local events or challenges this initiative would address
5. Whether their constituents have expressed support for related policies

For each potential ally, provide:
1. Their name, party, state, and district (if House)
2. Specific constituency interests that align
3. Economic or demographic data supporting alignment
4. How framing the initiative benefits their constituents
5. A confidence score (0-100)

Output as structured JSON:
{
  "allies": [
    {
      "legislatorId": "bioguide_id if known",
      "name": "Full Name",
      "party": "R or D",
      "state": "XX",
      "district": null,
      "alignmentScore": 70,
      "constituencyOverlap": [
        {"factor": "Industry presence", "detail": "...", "relevance": "high/medium/low"}
      ],
      "framingStrategy": "How to frame the initiative for their constituents",
      "localContext": "Relevant local issues or events"
    }
  ],
  "summary": "Overall constituency alignment analysis"
}`;
}
