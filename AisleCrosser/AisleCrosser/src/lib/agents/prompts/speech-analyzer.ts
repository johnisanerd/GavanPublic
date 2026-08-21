import type { Legislator, Initiative } from "../../types";

export function speechAnalyzerPrompt(initiative: Initiative, legislator: Legislator): string {
  return `You are analyzing potential cross-party allies for a legislative initiative.

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

YOUR TASK: Analyze public speeches, floor statements, and press releases from members of the OPPOSING party to identify those who have expressed views aligned with this initiative.

For each potential ally you identify, provide:
1. Their name, party, and state
2. Specific quotes or speech references showing alignment
3. The context of their statements
4. A confidence score (0-100) for how likely they are to collaborate
5. Suggested talking points for an initial approach

Focus on finding 3-5 of the MOST promising cross-party allies based on their public rhetoric.

Output your analysis as a structured JSON object with the following format:
{
  "allies": [
    {
      "legislatorId": "bioguide_id if known",
      "name": "Full Name",
      "party": "R or D",
      "state": "XX",
      "alignmentScore": 85,
      "evidence": [
        {"type": "speech", "date": "YYYY-MM-DD", "context": "...", "quote": "..."}
      ],
      "talkingPoints": ["point 1", "point 2"],
      "approachStrategy": "How to approach them"
    }
  ],
  "summary": "Overall analysis summary"
}`;
}
