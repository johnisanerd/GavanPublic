import Anthropic from "@anthropic-ai/sdk";
import { getApiModel, getSynthesisModel, getTopCandidates } from "../config";
import type { Initiative, Legislator } from "../types";
import type {
  Recommendation,
  ReasoningStep,
  AgentType,
  Candidate,
  CandidateEvidence,
  PersonalConnection,
} from "../types/agent";
import { getEventBus } from "./event-bus";
import { createAgentConfig } from "./sandbox";
import { runAgentDirect } from "./sandbox-direct";
import { runConnectionSearch, prefetchSocialMedia, type SocialMediaContext } from "./connection-search";
import { speechAnalyzerPrompt } from "./prompts/speech-analyzer";
import { votingAnalyzerPrompt } from "./prompts/voting-analyzer";
import { constituencyAnalyzerPrompt } from "./prompts/constituency-analyzer";
import { interestAnalyzerPrompt } from "./prompts/interest-analyzer";
import * as researchStore from "../store/research";
import * as initiativeStore from "../store/initiatives";
import * as legislatorStore from "../store/legislators";
import { generateId } from "../utils/ids";

const anthropic = new Anthropic();

// ─────────────────────────────────────────────────────
// Main research pipeline
// ─────────────────────────────────────────────────────

export async function runResearch(researchId: string): Promise<void> {
  const bus = getEventBus(researchId);
  console.log(`[orchestrator] Starting research ${researchId}`);

  const research = await researchStore.getResearch(researchId);
  if (!research) throw new Error(`Research ${researchId} not found`);

  const initiativeOrNull = await initiativeStore.getInitiative(research.initiativeId);
  if (!initiativeOrNull) throw new Error(`Initiative ${research.initiativeId} not found`);
  const initiative = initiativeOrNull;

  const legislatorOrNull = await legislatorStore.getLegislator(research.legislatorId);
  if (!legislatorOrNull) throw new Error(`Legislator ${research.legislatorId} not found`);
  const legislator = legislatorOrNull;

  // Shared candidate map — agents add to this as they complete
  const candidateMap = new Map<string, Candidate>();

  try {
    // ── Phase 1: Launch research agents ──────────────
    console.log(`[orchestrator] Phase 1: agents_starting`);
    bus.emit({ type: "research_status", data: { researchId, status: "agents_starting" } });
    await researchStore.updateResearch(researchId, { status: "agents_starting" });

    const agentConfigs = [
      createAgentConfig(researchId, "speech_analyzer", speechAnalyzerPrompt(initiative, legislator)),
      createAgentConfig(researchId, "voting_analyzer", votingAnalyzerPrompt(initiative, legislator)),
      createAgentConfig(researchId, "constituency_analyzer", constituencyAnalyzerPrompt(initiative, legislator)),
      createAgentConfig(researchId, "interest_analyzer", interestAnalyzerPrompt(initiative, legislator)),
    ];
    // Set chamber filter so inline nominations only include same-chamber candidates
    for (const config of agentConfigs) {
      config.chamberFilter = legislator.chamber;
    }

    await researchStore.updateResearch(researchId, {
      agents: agentConfigs.map((c) => ({
        id: c.id,
        researchId,
        agentType: c.agentType,
        status: "running" as const,
        displayName: c.displayName,
        description: c.description,
        events: [],
        startedAt: new Date().toISOString(),
      })),
    });

    // ── Phase 2: Run agents, extract candidates as each completes ──
    console.log(`[orchestrator] Phase 2: launching 4 agents`);
    bus.emit({ type: "research_status", data: { researchId, status: "agents_running" } });
    await researchStore.updateResearch(researchId, { status: "agents_running" });

    const researchAgentLabels = [
      "Speech Analyzer",
      "Voting Record Analyzer",
      "Constituency Analyzer",
      "Interest & Committee Analyzer",
    ];

    // Pre-fetch requesting legislator's social media (runs in parallel with agents)
    const socialPrefetchPromise = prefetchSocialMedia(legislator.name);
    let legislatorSocial: SocialMediaContext = {};

    // Each agent runs in parallel; candidates arrive via WS → EventBus → candidateMap

    // Eager connection search: start for top candidates once pool stabilizes
    const connectionSearchStarted = new Set<string>();
    const connectionSearchPromises: Promise<void>[] = [];
    let connectionDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    function maybeStartConnectionSearches() {
      // Debounce: wait 5s after last candidate change before starting searches
      // This prevents thrashing as candidates shift around the top 4
      if (connectionDebounceTimer) clearTimeout(connectionDebounceTimer);
      connectionDebounceTimer = setTimeout(() => {
        doStartConnectionSearches();
      }, 5000);
    }

    async function doStartConnectionSearches() {
      if (candidateMap.size < 3) return;
      // Cap at 4 total eager searches
      if (connectionSearchStarted.size >= 4) return;
      // Ensure social prefetch is done before starting
      legislatorSocial = await socialPrefetchPromise;
      const ranked = Array.from(candidateMap.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, 4);
      for (const candidate of ranked) {
        if (connectionSearchStarted.size >= 4) break;
        const key = candidate.name.toLowerCase();
        if (connectionSearchStarted.has(key)) continue;
        connectionSearchStarted.add(key);

      console.log(`[orchestrator] ${candidate.name} has ${candidate.nominatedBy.length} nominations — starting connection search early`);
      candidate.status = "researching_connections";
      bus.emit({ type: "candidate", data: candidate });

      const promise = (async () => {
        try {
          const connections = await runConnectionSearch({
            candidate,
            legislator,
            legislatorSocial,
            onConnection: (conn) => {
              candidate.connections = [...candidate.connections, conn];
              bus.emit({
                type: "candidate_update",
                data: { candidateId: candidate.id, connections: candidate.connections, status: "researching_connections" },
              });
            },
            onToolCall: (toolName, input) => {
              bus.emit({
                type: "connection_search_activity",
                data: { candidateId: candidate.id, toolName, input, timestamp: new Date().toISOString() },
              });
            },
          });
          candidate.connections = connections;
          candidate.status = "enriched";
          bus.emit({
            type: "candidate_update",
            data: { candidateId: candidate.id, connections, status: "enriched" },
          });
          console.log(`[orchestrator] Early connection search: ${connections.length} connections for ${candidate.name}`);

          // Immediately synthesize this candidate (with 30s timeout)
          try {
            const synth = await Promise.race([
              synthesizeCandidate(candidate, legislator, initiative),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Synthesis timeout")), 30_000)),
            ]);
            candidate.approachStrategy = synth.approachStrategy;
            candidate.talkingPoints = synth.talkingPoints;
            candidate.sharedInterests = synth.sharedInterests;
            candidate.status = "synthesized";
            bus.emit({ type: "candidate", data: candidate } as any);
            console.log(`[orchestrator] Early synthesis: ${candidate.name}`);
          } catch (synthErr) {
            console.error(`[orchestrator] Early synthesis failed for ${candidate.name}:`, synthErr);
          }
          // Persist after each connection+synthesis
          await researchStore.updateResearch(researchId, {
            candidates: Array.from(candidateMap.values()),
          });
        } catch (err) {
          console.error(`[orchestrator] Early connection search failed for ${candidate.name}:`, err);
          candidate.status = "enriched";
          bus.emit({
            type: "candidate_update",
            data: { candidateId: candidate.id, connections: candidate.connections, status: "enriched" },
          });
        }
      })();
      connectionSearchPromises.push(promise);
      }
    }

    // Listen for candidate nominations from WS agents and merge into candidateMap
    const unsubCandidates = bus.subscribe((event) => {
      if (event.type === "candidate" && event.data) {
        const c = event.data as Candidate;
        if (c.chamber && c.chamber !== legislator.chamber) return;
        mergeCandidateInto(candidateMap, c);
        maybeStartConnectionSearches();
      }
    }, bus.getEventCount()); // only listen for new events, not replay

    const findings: string[] = new Array(agentConfigs.length).fill("");
    const agentPromises = agentConfigs.map(async (config, i) => {

      console.log(`[orchestrator] Launching ${config.agentType} (${config.id})`);

      const result = await runAgentDirect(config);

      const output = result.success ? result.output : `Agent ${config.agentType} failed: ${result.error}`;
      findings[i] = output;
      console.log(`[orchestrator] ${config.agentType}: ${result.success ? "SUCCESS" : "FAILED"} (${output.length} chars)`);

      // Persist current candidates (V2 agents nominate via WS during run)
      await researchStore.updateResearch(researchId, {
        candidates: Array.from(candidateMap.values()),
      });
      console.log(`[orchestrator] ${config.agentType} done. ${candidateMap.size} total candidates so far.`);

      return result;
    });

    await Promise.allSettled(agentPromises);
    unsubCandidates(); // stop listening for WS candidates
    console.log(`[orchestrator] All agents complete. ${candidateMap.size} unique candidates nominated.`);

    // Breathing gap — let UI render last batch of candidates before phase transition
    await new Promise((r) => setTimeout(r, 1500));

    // ── Phase 3: Find personal connections for remaining top candidates ──
    // Wait for any eager connection searches that started during agent phase
    if (connectionSearchPromises.length > 0) {
      console.log(`[orchestrator] Waiting for ${connectionSearchPromises.length} eager connection searches...`);
      await Promise.allSettled(connectionSearchPromises);
    }

    // Search remaining top candidates that weren't searched eagerly
    const remainingCandidates = Array.from(candidateMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, getTopCandidates())
      .filter((c) => !connectionSearchStarted.has(c.name.toLowerCase()));

    if (remainingCandidates.length > 0) {
      console.log(`[orchestrator] Phase 3: finding connections for ${remainingCandidates.length} remaining candidates (${connectionSearchStarted.size} already searched)`);
      bus.emit({ type: "research_status", data: { researchId, status: "finding_connections" } });
      await researchStore.updateResearch(researchId, { status: "finding_connections" });

      for (const c of remainingCandidates) {
        c.status = "researching_connections";
        bus.emit({ type: "candidate", data: c });
      }

      await Promise.allSettled(
        remainingCandidates.map(async (candidate) => {
          try {
            legislatorSocial = await socialPrefetchPromise;
            const connections = await runConnectionSearch({
              candidate,
              legislator,
              legislatorSocial,
              onConnection: (conn) => {
                // Incremental: append and stream each connection as it's found
                candidate.connections = [...candidate.connections, conn];
                bus.emit({
                  type: "candidate_update",
                  data: { candidateId: candidate.id, connections: candidate.connections, status: "researching_connections" },
                });
              },
              onToolCall: (toolName, input) => {
                bus.emit({
                  type: "connection_search_activity",
                  data: { candidateId: candidate.id, toolName, input, timestamp: new Date().toISOString() },
                });
              },
            });
            candidate.connections = connections;
            candidate.status = "enriched";
            bus.emit({
              type: "candidate_update",
              data: { candidateId: candidate.id, connections, status: "enriched" },
            });
            console.log(`[orchestrator] Found ${connections.length} connections for ${candidate.name}`);
          } catch (err) {
            console.error(`[orchestrator] Connection search failed for ${candidate.name}:`, err);
            candidate.status = "enriched"; // move forward anyway
            bus.emit({
              type: "candidate_update",
              data: { candidateId: candidate.id, connections: candidate.connections, status: "enriched" },
            });
          }
        })
      );
    } else if (connectionSearchStarted.size > 0) {
      console.log(`[orchestrator] All top candidates already searched eagerly (${connectionSearchStarted.size} total)`);
    }

    // Persist enriched candidates
    await researchStore.updateResearch(researchId, {
      candidates: Array.from(candidateMap.values()),
    });

    // ── Phase 4: Per-candidate synthesis for top candidates ──
    const topForSynthesis = Array.from(candidateMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, getTopCandidates())
      .filter((c) => !c.approachStrategy); // skip if already synthesized

    if (topForSynthesis.length > 0) {
      console.log(`[orchestrator] Phase 4: synthesizing top ${topForSynthesis.length} candidates`);
      bus.emit({ type: "research_status", data: { researchId, status: "synthesizing" } });
      await researchStore.updateResearch(researchId, { status: "synthesizing" });

      await Promise.allSettled(
        topForSynthesis.map(async (candidate) => {
          try {
            const result = await Promise.race([
              synthesizeCandidate(candidate, legislator, initiative),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Synthesis timeout")), 30_000)),
            ]);
            candidate.approachStrategy = result.approachStrategy;
            candidate.talkingPoints = result.talkingPoints;
            candidate.sharedInterests = result.sharedInterests;
            candidate.status = "synthesized";
            bus.emit({ type: "candidate", data: candidate } as any);
            console.log(`[orchestrator] Synthesized: ${candidate.name}`);
          } catch (err) {
            console.error(`[orchestrator] Synthesis failed for ${candidate.name}:`, err);
          }
        })
      );
    }

    // Complete
    const finalCandidates = Array.from(candidateMap.values());
    await researchStore.updateResearch(researchId, {
      status: "completed",
      candidates: finalCandidates,
      recommendations: [], // no longer doing full synthesis
      completedAt: new Date().toISOString(),
    });

    bus.emit({ type: "complete", data: { researchId } });
    console.log(`[orchestrator] Research ${researchId} completed with ${finalCandidates.length} candidates (${topForSynthesis.length} synthesized)`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[orchestrator] Research ${researchId} FAILED:`, error);
    await researchStore.updateResearch(researchId, {
      status: "failed",
      error,
      candidates: Array.from(candidateMap.values()),
    });
    bus.emit({ type: "error", data: { researchId, error } });
  }
}

// ─────────────────────────────────────────────────────
// Extract candidate nominations from a single agent's
// output using Haiku tool_use
// ─────────────────────────────────────────────────────

const candidateExtractionTool: Anthropic.Messages.Tool = {
  name: "nominate_candidates",
  description: "Nominate potential cross-party allies found in this agent's research.",
  input_schema: {
    type: "object" as const,
    required: ["candidates"],
    properties: {
      candidates: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "party", "state", "chamber", "score", "evidence"],
          properties: {
            name: { type: "string", description: "Full name of the legislator" },
            party: { type: "string", enum: ["R", "D", "I"] },
            state: { type: "string", description: "Two-letter state code" },
            chamber: { type: "string", enum: ["senate", "house"] },
            score: { type: "number", description: "0-100 preliminary alignment score based on this agent's findings" },
            evidence: { type: "string", description: "Key evidence for why they could be an ally (1-2 sentences)" },
            category: { type: "string", description: "Primary evidence category: voting, speech, constituency, or interest" },
          },
        },
      },
    },
  },
};

async function extractCandidatesFromAgent(
  rawOutput: string,
  agentType: AgentType,
  initiative: Initiative,
  legislator: Legislator
): Promise<Candidate[]> {
  // Extract result text from NDJSON if needed
  let text = rawOutput;
  if (text.trimStart().startsWith('{"type":')) {
    for (const line of text.split("\n")) {
      try {
        const msg = JSON.parse(line.trim());
        if (msg.type === "result" && msg.result) {
          text = msg.result;
          break;
        }
      } catch { /* not JSON */ }
    }
  }

  const response = await anthropic.messages.create({
    model: getApiModel(),
    max_tokens: 2048,
    tool_choice: { type: "tool", name: "nominate_candidates" },
    tools: [candidateExtractionTool],
    messages: [
      {
        role: "user",
        content: `You are extracting potential cross-party ally nominations from research about ${legislator.name} (${legislator.party}-${legislator.state}) and the initiative "${initiative.title}".

Extract ALL legislators mentioned as potential allies from the OPPOSITE party. Include anyone with evidence of alignment, even weak signals. Better to over-nominate than miss someone.

RESEARCH OUTPUT:
${text.slice(0, 30_000)}`,
      },
    ],
  });

  const toolBlock = response.content.find((b) => b.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") return [];

  const input = toolBlock.input as { candidates?: Array<Record<string, unknown>> };
  const raw = input.candidates || [];

  return raw.map((c) => ({
    id: generateId("cand"),
    name: (c.name as string) || "Unknown",
    party: (c.party as "R" | "D" | "I") || "R",
    state: (c.state as string) || "??",
    chamber: (c.chamber as "senate" | "house") || "senate",
    score: (c.score as number) || 50,
    nominatedBy: [agentType],
    evidence: [
      {
        agentType,
        category: (c.category as string) || "general",
        summary: (c.evidence as string) || "",
        confidence: ((c.score as number) || 50) / 100,
      },
    ],
    connections: [],
    status: "nominated" as const,
    nominatedAt: new Date().toISOString(),
  }));
}

// ─────────────────────────────────────────────────────
// Merge a new candidate nomination into the shared map
// If same person already exists, merge evidence + boost score
// ─────────────────────────────────────────────────────

function mergeCandidateInto(map: Map<string, Candidate>, incoming: Candidate): void {
  const key = incoming.name.toLowerCase();
  const existing = map.get(key);

  if (!existing) {
    map.set(key, incoming);
    return;
  }

  // Merge: add new evidence, combine agent nominations, average scores
  existing.nominatedBy = [...new Set([...existing.nominatedBy, ...incoming.nominatedBy])];
  existing.evidence.push(...incoming.evidence);

  // Score boost: more nominations = higher score (capped at 100)
  const avgScore =
    existing.evidence.reduce((sum, e) => sum + e.confidence * 100, 0) / existing.evidence.length;
  const nominationBonus = (existing.nominatedBy.length - 1) * 5;
  existing.score = Math.min(100, Math.round(avgScore + nominationBonus));
}

// ─────────────────────────────────────────────────────
// Per-candidate synthesis — lightweight, runs for top
// candidates eagerly and others on demand
// ─────────────────────────────────────────────────────

const candidateSynthesisTool: Anthropic.Messages.Tool = {
  name: "synthesize_candidate",
  description: "Provide approach strategy and talking points for this candidate.",
  input_schema: {
    type: "object" as const,
    required: ["approachStrategy", "talkingPoints", "sharedInterests"],
    properties: {
      approachStrategy: { type: "string", description: "2-3 sentence strategy for approaching this legislator, incorporating personal connections as icebreakers" },
      talkingPoints: { type: "array", items: { type: "string" }, description: "3-5 specific talking points for the conversation" },
      sharedInterests: { type: "array", items: { type: "string" }, description: "Policy areas or personal interests both legislators share" },
    },
  },
};

export async function synthesizeCandidate(
  candidate: Candidate,
  legislator: Legislator,
  initiative: Initiative
): Promise<{ approachStrategy: string; talkingPoints: string[]; sharedInterests: string[] }> {
  const evidenceText = candidate.evidence
    .map((e) => `[${e.agentType}] ${e.summary}`)
    .join("\n");
  const connectionsText = candidate.connections.length > 0
    ? candidate.connections.map((c) => `${c.type}: ${c.detail} (shared: ${c.sharedWith})`).join("\n")
    : "No personal connections found.";

  const response = await anthropic.messages.create({
    model: getSynthesisModel(),
    max_tokens: 1024,
    tool_choice: { type: "tool", name: "synthesize_candidate" },
    tools: [candidateSynthesisTool],
    messages: [{
      role: "user",
      content: `You are a senior congressional staffer. ${legislator.name} (${legislator.party}-${legislator.state}) wants to approach ${candidate.name} (${candidate.party}-${candidate.state}) about "${initiative.title}".

EVIDENCE:
${evidenceText}

PERSONAL CONNECTIONS:
${connectionsText}

Provide a concrete approach strategy that uses personal connections as icebreakers, plus specific talking points. Be practical and human — these will be read by real staffers.`,
    }],
  });

  const toolBlock = response.content.find((b) => b.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") {
    return { approachStrategy: "", talkingPoints: [], sharedInterests: [] };
  }

  const input = toolBlock.input as {
    approachStrategy?: string;
    talkingPoints?: string[];
    sharedInterests?: string[];
  };

  return {
    approachStrategy: input.approachStrategy || "",
    talkingPoints: input.talkingPoints || [],
    sharedInterests: input.sharedInterests || [],
  };
}

// ─────────────────────────────────────────────────────
// Condense raw agent output to key findings using Haiku
// ─────────────────────────────────────────────────────

const MAX_FINDING_CHARS = 12_000;

async function condenseFinding(rawOutput: string, agentLabel: string): Promise<string> {
  let text = rawOutput;
  if (text.trimStart().startsWith('{"type":')) {
    for (const line of text.split("\n")) {
      try {
        const msg = JSON.parse(line.trim());
        if (msg.type === "result" && msg.result) {
          text = msg.result;
          break;
        }
      } catch { /* not JSON */ }
    }
  }

  if (text.length <= MAX_FINDING_CHARS) return text;

  console.log(`[orchestrator] Condensing ${agentLabel} findings: ${text.length} → ~${MAX_FINDING_CHARS} chars`);

  const response = await anthropic.messages.create({
    model: getApiModel(),
    max_tokens: 3000,
    messages: [
      {
        role: "user",
        content: `Condense these "${agentLabel}" research findings. Preserve ALL legislator names, parties, states, voting data, quotes, scores, and evidence. Drop verbose explanations and repetition.

RAW FINDINGS (${text.length} chars):
${text.slice(0, 50_000)}`,
      },
    ],
  });

  const condensed = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("");

  console.log(`[orchestrator] ${agentLabel} condensed: ${text.length} → ${condensed.length} chars`);
  return condensed;
}

// ─────────────────────────────────────────────────────
// Final synthesis: merge all findings + candidate data
// + personal connections into ranked recommendations
// ─────────────────────────────────────────────────────

const synthesisTool: Anthropic.Messages.Tool = {
  name: "submit_recommendations",
  description: "Submit the final synthesized cross-party ally recommendations.",
  input_schema: {
    type: "object" as const,
    required: ["recommendations", "overallStrategy"],
    properties: {
      recommendations: {
        type: "array",
        description: "Recommended cross-party allies ranked by alignment score. Include only those with genuine evidence — typically 1-5, but let quality decide.",
        items: {
          type: "object",
          required: ["name", "party", "state", "chamber", "alignmentScore", "summary", "approachStrategy"],
          properties: {
            name: { type: "string", description: "Full name" },
            party: { type: "string", enum: ["R", "D", "I"] },
            state: { type: "string", description: "Two-letter state code" },
            chamber: { type: "string", enum: ["senate", "house"] },
            alignmentScore: { type: "number", description: "0-100 composite score" },
            summary: { type: "string", description: "2-3 sentence match summary" },
            approachStrategy: { type: "string", description: "Specific strategy including personal connection icebreakers" },
            sharedInterests: { type: "array", items: { type: "string" } },
            talkingPoints: { type: "array", items: { type: "string" } },
            personalConnections: {
              type: "array",
              description: "Personal icebreakers (hobbies, pets, sports, alma mater, etc.)",
              items: {
                type: "object",
                properties: {
                  type: { type: "string" },
                  detail: { type: "string" },
                  sharedWith: { type: "string" },
                },
              },
            },
            reasoningChain: {
              type: "array",
              items: {
                type: "object",
                required: ["category", "title", "evidence", "confidence"],
                properties: {
                  category: { type: "string" },
                  title: { type: "string" },
                  evidence: { type: "string" },
                  confidence: { type: "number" },
                },
              },
            },
          },
        },
      },
      overallStrategy: { type: "string", description: "High-level outreach campaign strategy" },
    },
  },
};

interface SynthesisResult {
  recommendations: Recommendation[];
  synthesis: string;
}

async function synthesizeAndExtract(
  initiative: Initiative,
  legislator: Legislator,
  condensedFindings: string[],
  agentLabels: string[],
  candidates: Candidate[]
): Promise<SynthesisResult> {
  const findingsText = condensedFindings
    .map((f, i) => `=== ${agentLabels[i]} FINDINGS ===\n${f}`)
    .join("\n\n");

  // Build candidate context including personal connections
  const candidateContext = candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((c) => {
      let text = `- ${c.name} (${c.party}-${c.state}, ${c.chamber}): score=${c.score}, nominated by ${c.nominatedBy.join(", ")}`;
      if (c.connections.length > 0) {
        text += `\n  Personal connections: ${c.connections.map((conn) => `${conn.type}: ${conn.detail} (shared: ${conn.sharedWith})`).join("; ")}`;
      }
      for (const e of c.evidence) {
        text += `\n  [${e.agentType}] ${e.summary}`;
      }
      return text;
    })
    .join("\n");

  const userMessage = `REQUESTING LEGISLATOR:
- ${legislator.name} (${legislator.party}-${legislator.state}, ${legislator.chamber})

INITIATIVE: ${initiative.title}
- ${initiative.description}
- Policy Area: ${initiative.policyArea}
- Goals: ${initiative.goals.join(", ")}

RESEARCH FINDINGS:
${findingsText}

NOMINATED CANDIDATES (with personal connections):
${candidateContext}

Synthesize ALL findings into your best recommendations. Include only legislators with real evidence of alignment — could be 1, could be 5+. Quality over quantity. IMPORTANT: Incorporate personal connections into approach strategies — these are the icebreakers that make introductions work. Use the submit_recommendations tool.`;

  console.log(`[orchestrator] Calling Sonnet for final synthesis (${userMessage.length} chars, ~${Math.round(userMessage.length / 4)} tokens est.)`);

  let response: Anthropic.Messages.Message;
  try {
    response = await anthropic.messages.create({
      model: getSynthesisModel(),
      max_tokens: 16384,
      tool_choice: { type: "tool", name: "submit_recommendations" },
      tools: [synthesisTool],
      system: `You are a senior political strategist creating the final cross-party collaboration recommendations. You have research from 4 specialized agents AND personal connection research for top candidates.

Your approach strategies MUST incorporate personal connections as icebreakers. A recommendation to "approach them about voting records" is useless — but "invite them to the Congressional Golf Caucus outing, where you can discuss your shared interest in rural broadband" is actionable.

Be specific, evidence-based, and human. These recommendations will be read by actual congressional staffers.`,
      messages: [{ role: "user", content: userMessage }],
    });
  } catch (err) {
    console.error("[orchestrator] Synthesis API call failed:", err);
    throw err;
  }

  console.log(`[orchestrator] Synthesis response: stop_reason=${response.stop_reason}, content_blocks=${response.content.length}, types=${response.content.map((b) => b.type).join(",")}`);

  if (response.stop_reason === "max_tokens") {
    console.warn("[orchestrator] Synthesis hit max_tokens — output may be truncated");
  }

  const toolBlock = response.content.find((b) => b.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") {
    console.error("[orchestrator] No tool_use block in synthesis response. Content:", JSON.stringify(response.content).slice(0, 500));
    return { recommendations: [], synthesis: "" };
  }

  const input = toolBlock.input as {
    recommendations?: Array<Record<string, unknown>>;
    overallStrategy?: string;
  };
  const recs = input.recommendations || [];
  const overallStrategy = input.overallStrategy || "";

  console.log(`[orchestrator] Final synthesis: ${recs.length} recommendations`);

  const recommendations: Recommendation[] = recs.map((rec) => ({
    id: generateId("rec"),
    targetLegislatorId: "",
    targetLegislatorName: (rec.name as string) || "Unknown",
    targetLegislatorParty: (rec.party as string) || "?",
    targetLegislatorState: (rec.state as string) || "??",
    targetLegislatorChamber: (rec.chamber as string) || "senate",
    alignmentScore: (rec.alignmentScore as number) || 50,
    summary: (rec.summary as string) || "",
    reasoningChain: ((rec.reasoningChain as Array<Record<string, unknown>>) || []).map(
      (step) => ({
        id: generateId("step"),
        agentType: "synthesizer" as AgentType,
        category: (step.category as string) || "general",
        title: (step.title as string) || "",
        evidence: (step.evidence as string) || "",
        confidence: (step.confidence as number) || 0.5,
        sources: [],
      })
    ),
    approachStrategy: (rec.approachStrategy as string) || "",
    sharedInterests: (rec.sharedInterests as string[]) || [],
    personalConnections: ((rec.personalConnections as Array<Record<string, unknown>>) || []).map(
      (c) => ({
        type: (c.type as string) || "other",
        detail: (c.detail as string) || "",
        sharedWith: (c.sharedWith as string) || "",
        source: (c.source as string) || "",
        confidence: 0.7,
      })
    ),
  }));

  return { recommendations, synthesis: overallStrategy };
}
