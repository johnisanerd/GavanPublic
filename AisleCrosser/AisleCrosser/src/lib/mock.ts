/**
 * Mock data for testing without LLM calls.
 * Activated by AI_MODEL=mock
 */

import type { Candidate, Recommendation } from "./types/agent";
import { generateId } from "./utils/ids";

const MOCK_CANDIDATES: Partial<Candidate>[] = [
  { name: "Lisa Murkowski", party: "R", state: "AK", chamber: "senate", score: 88 },
  { name: "Susan Collins", party: "R", state: "ME", chamber: "senate", score: 85 },
  { name: "Todd Young", party: "R", state: "IN", chamber: "senate", score: 82 },
  { name: "John Cornyn", party: "R", state: "TX", chamber: "senate", score: 78 },
  { name: "Shelley Moore Capito", party: "R", state: "WV", chamber: "senate", score: 75 },
  { name: "Bill Cassidy", party: "R", state: "LA", chamber: "senate", score: 72 },
];

export function getMockCandidates(chamber: string): Candidate[] {
  return MOCK_CANDIDATES
    .filter((c) => c.chamber === chamber)
    .map((c, i) => ({
      id: generateId("cand"),
      name: c.name!,
      party: c.party as "R" | "D" | "I",
      state: c.state!,
      chamber: c.chamber as "senate" | "house",
      score: c.score!,
      nominatedBy: ["speech_analyzer", "voting_analyzer"].slice(0, (i % 3) + 1) as Candidate["nominatedBy"],
      evidence: [
        {
          agentType: "voting_analyzer" as const,
          category: "voting",
          summary: `Mock evidence: ${c.name} has a strong bipartisan record on this issue.`,
          confidence: (c.score! / 100),
        },
      ],
      connections: [
        {
          type: "Alma Mater",
          detail: "Both attended Yale Law School",
          sharedWith: "the requesting legislator",
          source: "Mock data",
          confidence: 0.9,
        },
      ],
      status: "enriched" as const,
      nominatedAt: new Date().toISOString(),
    }));
}

export function getMockRecommendations(candidates: Candidate[]): Recommendation[] {
  return candidates.slice(0, 4).map((c, i) => ({
    id: generateId("rec"),
    targetLegislatorId: "",
    targetLegislatorName: c.name,
    targetLegislatorParty: c.party,
    targetLegislatorState: c.state,
    targetLegislatorChamber: c.chamber,
    alignmentScore: c.score,
    summary: `Mock: ${c.name} is a strong potential ally based on voting patterns and shared interests.`,
    reasoningChain: [
      {
        id: generateId("step"),
        agentType: "synthesizer" as const,
        category: "voting",
        title: "Bipartisan voting record",
        evidence: `Mock evidence for ${c.name}`,
        confidence: 0.85,
        sources: [],
      },
    ],
    approachStrategy: `Mock: Approach ${c.name} through their shared interest in the policy area.`,
    sharedInterests: ["Technology policy", "Consumer protection"],
    personalConnections: [
      {
        type: "Alma Mater",
        detail: "Both attended Yale Law School",
        sharedWith: "the requesting legislator",
        source: "Mock data",
        confidence: 0.9,
      },
    ],
  }));
}

/** Simulate agent work with delays */
export async function simulateAgentDelay(): Promise<void> {
  await new Promise((r) => setTimeout(r, 500 + Math.random() * 1000));
}
