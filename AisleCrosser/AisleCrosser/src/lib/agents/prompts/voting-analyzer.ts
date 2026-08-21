import type { Legislator, Initiative } from "../../types";

export function votingAnalyzerPrompt(initiative: Initiative, legislator: Legislator): string {
  return `You are analyzing voting records to find cross-party collaboration opportunities.

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

YOUR TASK: Analyze voting records and bill co-sponsorship patterns from members of the OPPOSING party to find those whose legislative actions suggest alignment with this initiative.

Look for:
1. Votes on related legislation where they broke with their party
2. Bills they've co-sponsored with the requesting legislator's party
3. Amendments they've proposed in related policy areas
4. Committee positions that give them influence on this topic

For each potential ally, provide:
1. Their name, party, and state
2. Specific votes or bills showing alignment
3. A pattern analysis of their voting behavior on this topic
4. A confidence score (0-100)
5. Key bills or votes to reference in conversation

Output as structured JSON:
{
  "allies": [
    {
      "legislatorId": "bioguide_id if known",
      "name": "Full Name",
      "party": "R or D",
      "state": "XX",
      "alignmentScore": 75,
      "votingEvidence": [
        {"billId": "HR-XXXX", "title": "...", "vote": "Yea/Nay", "partyLine": true/false, "date": "YYYY-MM-DD"}
      ],
      "cosponsorshipHistory": ["bill descriptions"],
      "keyReferencePoints": ["specific bills/votes to mention"]
    }
  ],
  "summary": "Overall voting alignment analysis"
}`;
}
