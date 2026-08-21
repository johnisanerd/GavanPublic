import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";

// ── Business logic imports ──────────────────────────
import { generateId } from "@/lib/utils/ids";
import {
  createSessionSchema,
  createInitiativeSchema,
  updateInitiativeSchema,
  launchResearchSchema,
  feedbackSchema,
  launchDeepDiveSchema,
} from "@/lib/utils/validation";
import * as sessionStore from "@/lib/store/sessions";
import * as initiativeStore from "@/lib/store/initiatives";
import * as researchStore from "@/lib/store/research";
import * as deepDiveStore from "@/lib/store/deep-dives";
import {
  searchLegislators,
  getLegislator,
  getLegislatorIndex,
  saveLegislatorIndex,
} from "@/lib/store/legislators";
import { SEED_LEGISLATORS } from "@/lib/congress/seed-data";
import { fetchBillsByMember } from "@/lib/congress/api-client";
import { getEventBus } from "@/lib/agents/event-bus";
import { runResearch, synthesizeCandidate } from "@/lib/agents/orchestrator";
import { runDeepDive } from "@/lib/agents/deep-dive-runner";
import type { Chamber, Party } from "@/lib/types";
import type { DeepDive } from "@/lib/types/deep-dive";
import type { DeepDiveStreamEvent } from "@/lib/types/deep-dive";

// ── App ─────────────────────────────────────────────
const app = new Hono();

app.use("*", cors());

// ── Health ──────────────────────────────────────────
app.get("/api/health", (c) =>
  c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    env: {
      e2b: !!process.env.E2B_API_KEY,
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      congress: !!process.env.CONGRESS_API_KEY,
      apify: !!process.env.APIFY_API_KEY,
    },
  })
);

// ── Sessions ────────────────────────────────────────
app.post("/api/sessions", async (c) => {
  const parsed = createSessionSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Invalid input", details: parsed.error.issues }, 400);

  const session = {
    id: generateId("sess"),
    legislatorId: parsed.data.legislatorId,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    initiativeIds: [],
    researchIds: [],
  };
  await sessionStore.createSession(session);
  return c.json(session, 201);
});

app.get("/api/sessions/:sessionId", async (c) => {
  const session = await sessionStore.getSession(c.req.param("sessionId"));
  if (!session) return c.json({ error: "Session not found" }, 404);
  return c.json(session);
});

app.put("/api/sessions/:sessionId", async (c) => {
  const body = await c.req.json();
  const updated = await sessionStore.updateSession(c.req.param("sessionId"), {
    ...body,
    lastActiveAt: new Date().toISOString(),
  });
  if (!updated) return c.json({ error: "Session not found" }, 404);
  return c.json(updated);
});

// ── Legislators ─────────────────────────────────────
async function ensureSeeded() {
  const existing = await getLegislatorIndex();
  if (existing.length === 0) {
    await saveLegislatorIndex(SEED_LEGISLATORS);
  }
}

app.get("/api/legislators", async (c) => {
  await ensureSeeded();
  const results = await searchLegislators({
    q: c.req.query("q") || undefined,
    chamber: (c.req.query("chamber") as Chamber) || undefined,
    party: (c.req.query("party") as Party) || undefined,
    state: c.req.query("state") || undefined,
  });
  return c.json({ legislators: results, count: results.length });
});

app.get("/api/legislators/:legislatorId", async (c) => {
  await ensureSeeded();
  const legislator = await getLegislator(c.req.param("legislatorId"));
  if (!legislator) return c.json({ error: "Legislator not found" }, 404);
  return c.json(legislator);
});

// Bills cache
const billsCache = new Map<string, { data: unknown; timestamp: number }>();
const BILLS_CACHE_TTL = 10 * 60 * 1000;

interface CongressBill {
  congress: number;
  type: string;
  number: number;
  title: string;
  latestAction?: { text: string; actionDate: string };
  policyArea?: { name: string };
  introducedDate?: string;
  url?: string;
}

app.get("/api/legislators/:legislatorId/bills", async (c) => {
  const legislatorId = c.req.param("legislatorId");
  const cached = billsCache.get(legislatorId);
  if (cached && Date.now() - cached.timestamp < BILLS_CACHE_TTL) {
    return c.json(cached.data as Record<string, unknown>);
  }

  try {
    const raw = await fetchBillsByMember(legislatorId);
    const bills = (raw.sponsoredLegislation || [])
      .filter((bill: CongressBill) => bill.title)
      .map((bill: CongressBill) => ({
        id: `${(bill.type || "BILL").toLowerCase()}${bill.number || 0}-${bill.congress || 118}`,
        congress: bill.congress || 118,
        type: bill.type || "BILL",
        number: bill.number || 0,
        title: bill.title,
        policyArea: bill.policyArea?.name || "General",
        introducedDate: bill.introducedDate || "",
        latestAction: bill.latestAction?.text,
        latestActionDate: bill.latestAction?.actionDate,
        url: bill.number
          ? `https://congress.gov/bill/${bill.congress}th-congress/${(bill.type || "bill").toLowerCase().replace(/\./g, "")}-bill/${bill.number}`
          : "",
      }));

    const result = { legislatorId, bills, total: bills.length };
    billsCache.set(legislatorId, { data: result, timestamp: Date.now() });
    return c.json(result);
  } catch (err) {
    console.error(`[bills] Failed to fetch for ${legislatorId}:`, err);
    return c.json({ legislatorId, bills: [], total: 0, error: "Failed to fetch from Congress.gov" });
  }
});

// ── Initiatives ─────────────────────────────────────
app.get("/api/initiatives", async (c) => {
  const legislatorId = c.req.query("legislatorId");
  if (!legislatorId) return c.json({ error: "legislatorId query param required" }, 400);
  const initiatives = await initiativeStore.listInitiativesByLegislator(legislatorId);
  return c.json({ initiatives, count: initiatives.length });
});

app.post("/api/initiatives", async (c) => {
  const parsed = createInitiativeSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Invalid input", details: parsed.error.issues }, 400);

  const now = new Date().toISOString();
  const initiative = {
    id: generateId("init"),
    ...parsed.data,
    status: "active" as const,
    createdAt: now,
    updatedAt: now,
  };
  await initiativeStore.createInitiative(initiative);
  return c.json(initiative, 201);
});

app.get("/api/initiatives/:initiativeId", async (c) => {
  const initiative = await initiativeStore.getInitiative(c.req.param("initiativeId"));
  if (!initiative) return c.json({ error: "Initiative not found" }, 404);
  return c.json(initiative);
});

app.put("/api/initiatives/:initiativeId", async (c) => {
  const parsed = updateInitiativeSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Invalid input", details: parsed.error.issues }, 400);
  const updated = await initiativeStore.updateInitiative(c.req.param("initiativeId"), parsed.data);
  if (!updated) return c.json({ error: "Initiative not found" }, 404);
  return c.json(updated);
});

app.delete("/api/initiatives/:initiativeId", async (c) => {
  const deleted = await initiativeStore.deleteInitiative(c.req.param("initiativeId"));
  if (!deleted) return c.json({ error: "Initiative not found" }, 404);
  return c.json({ success: true });
});

// ── Research ────────────────────────────────────────
app.post("/api/research", async (c) => {
  const parsed = launchResearchSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Invalid input", details: parsed.error.issues }, 400);

  const data = parsed.data;
  let initiativeId: string;
  let legislatorId: string;
  let initiativeTitle: string;

  if ("initiativeId" in data) {
    const initiative = await initiativeStore.getInitiative(data.initiativeId);
    if (!initiative) return c.json({ error: "Initiative not found" }, 404);
    initiativeId = initiative.id;
    legislatorId = initiative.legislatorId;
    initiativeTitle = initiative.title;
  } else {
    const now = new Date().toISOString();
    const initiative = {
      id: generateId("init"),
      sessionId: "default",
      legislatorId: data.legislatorId,
      title: data.title,
      description: data.description || data.title,
      policyArea: data.policyArea || "Other",
      goals: data.goals || ["Find cross-party allies"],
      existingBillIds: data.existingBillIds,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    };
    await initiativeStore.createInitiative(initiative);
    initiativeId = initiative.id;
    legislatorId = data.legislatorId;
    initiativeTitle = data.title;
  }

  const legislator = await getLegislator(legislatorId);

  const research = {
    id: generateId("res"),
    initiativeId,
    legislatorId,
    initiativeTitle,
    legislatorName: legislator?.name,
    legislatorParty: legislator?.party,
    legislatorState: legislator?.state,
    status: "queued" as const,
    agents: [],
    candidates: [],
    recommendations: [],
    startedAt: new Date().toISOString(),
  };

  await researchStore.createResearch(research);

  // Fire and forget — this process stays alive
  runResearch(research.id).catch((err) => {
    console.error(`Research ${research.id} failed:`, err);
  });

  return c.json(
    {
      researchId: research.id,
      legislatorName: research.legislatorName,
      legislatorParty: research.legislatorParty,
      legislatorState: research.legislatorState,
      initiativeTitle: research.initiativeTitle,
    },
    201
  );
});

app.get("/api/research/:researchId", async (c) => {
  const research = await researchStore.getResearch(c.req.param("researchId"));
  if (!research) return c.json({ error: "Research not found" }, 404);
  return c.json(research);
});

app.post("/api/research/:researchId/feedback", async (c) => {
  const researchId = c.req.param("researchId");
  const body = await c.req.json();
  const parsed = feedbackSchema.safeParse({ ...body, researchId });
  if (!parsed.success) return c.json({ error: "Invalid input", details: parsed.error.issues }, 400);

  const success = await researchStore.submitFeedback(
    researchId,
    parsed.data.targetType,
    parsed.data.targetId,
    {
      value: parsed.data.value,
      comment: parsed.data.comment,
      submittedAt: new Date().toISOString(),
    }
  );
  if (!success) return c.json({ error: "Research or target not found" }, 404);
  return c.json({ success: true });
});

// ── On-demand candidate synthesis ────────────────────
app.post("/api/research/:researchId/synthesize", async (c) => {
  const researchId = c.req.param("researchId");
  const { candidateName } = await c.req.json();
  if (!candidateName) return c.json({ error: "candidateName required" }, 400);

  const research = await researchStore.getResearch(researchId);
  if (!research) return c.json({ error: "Research not found" }, 404);

  const candidate = research.candidates?.find(
    (ca: { name: string }) => ca.name.toLowerCase() === candidateName.toLowerCase()
  );
  if (!candidate) return c.json({ error: "Candidate not found" }, 404);

  // Already synthesized?
  if (candidate.approachStrategy) {
    return c.json({
      approachStrategy: candidate.approachStrategy,
      talkingPoints: candidate.talkingPoints || [],
      sharedInterests: candidate.sharedInterests || [],
    });
  }

  await ensureSeeded();
  const legislator = await getLegislator(research.legislatorId);
  if (!legislator) return c.json({ error: "Legislator not found" }, 404);

  const initiative = await initiativeStore.getInitiative(research.initiativeId);
  if (!initiative) return c.json({ error: "Initiative not found" }, 404);

  try {
    const result = await synthesizeCandidate(candidate, legislator, initiative);

    // Persist back to the research record
    candidate.approachStrategy = result.approachStrategy;
    candidate.talkingPoints = result.talkingPoints;
    candidate.sharedInterests = result.sharedInterests;
    candidate.status = "synthesized";
    await researchStore.updateResearch(researchId, {
      candidates: research.candidates,
    });

    return c.json(result);
  } catch (err) {
    console.error(`[synthesize] Failed for ${candidateName}:`, err);
    return c.json({ error: "Synthesis failed" }, 500);
  }
});

// ── Research SSE Stream ─────────────────────────────
app.get("/api/research/stream/:researchId", async (c) => {
  const researchId = c.req.param("researchId");
  const research = await researchStore.getResearch(researchId);

  // Completed research: replay stored data then close
  if (research && (research.status === "completed" || research.status === "failed")) {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "research_status", data: JSON.stringify({ researchId, status: research.status }) });

      for (const agent of research.agents || []) {
        await stream.writeSSE({
          event: "agent_event",
          data: JSON.stringify({
            type: "status",
            agentId: agent.id,
            agentType: agent.agentType,
            status: "completed",
            message: `${agent.displayName} completed`,
            timestamp: agent.completedAt || research.completedAt || new Date().toISOString(),
          }),
        });
      }

      for (const cand of research.candidates || []) {
        await stream.writeSSE({ event: "candidate", data: JSON.stringify(cand) });
      }

      for (const rec of research.recommendations || []) {
        await stream.writeSSE({ event: "recommendation", data: JSON.stringify(rec) });
      }

      await stream.writeSSE({
        event: research.status === "completed" ? "complete" : "error",
        data: JSON.stringify(
          research.status === "completed" ? { researchId } : { researchId, error: research.error }
        ),
      });
    });
  }

  // Live research: subscribe to EventBus
  const lastEventId = c.req.header("Last-Event-ID");
  const startFrom = lastEventId ? parseInt(lastEventId, 10) + 1 : 0;

  return streamSSE(c, async (stream) => {
    const bus = getEventBus(researchId);
    let eventIndex = 0;
    let done = false;

    const unsubscribe = bus.subscribe((event) => {
      if (done) return;
      const currentIndex = eventIndex++;
      if (currentIndex < startFrom) return;

      stream
        .writeSSE({
          id: String(currentIndex),
          event: event.type,
          data: JSON.stringify(event.data),
        })
        .catch(() => {
          done = true;
          unsubscribe();
        });

      if (event.type === "complete" || event.type === "error") {
        done = true;
        unsubscribe();
      }
    }, startFrom);

    // Heartbeat
    const heartbeat = setInterval(() => {
      if (done) {
        clearInterval(heartbeat);
        return;
      }
      stream.write(": heartbeat\n\n").catch(() => {
        clearInterval(heartbeat);
        done = true;
        unsubscribe();
      });
    }, 15_000);

    // Wait until stream closes
    while (!done) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    clearInterval(heartbeat);
  });
});

// ── Deep Dive ───────────────────────────────────────
app.post("/api/deep-dive", async (c) => {
  try {
    const parsed = launchDeepDiveSchema.parse(await c.req.json());

    const research = await researchStore.getResearch(parsed.researchId);
    if (!research) return c.json({ error: "Research not found" }, 404);

    const rec = research.recommendations.find((r) => r.id === parsed.recommendationId);
    if (!rec) return c.json({ error: "Recommendation not found" }, 404);

    const connections = rec.personalConnections || [];
    if (parsed.connectionIndex >= connections.length) {
      return c.json({ error: "Connection index out of range" }, 400);
    }

    const conn = connections[parsed.connectionIndex];
    const initiative = await initiativeStore.getInitiative(research.initiativeId);

    const deepDiveId = generateId("dive");
    const dive: DeepDive = {
      id: deepDiveId,
      researchId: parsed.researchId,
      recommendationId: parsed.recommendationId,
      connectionIndex: parsed.connectionIndex,
      connectionType: conn.type,
      connectionDetail: conn.detail,
      targetLegislatorName: rec.targetLegislatorName,
      initiativeTitle: initiative?.title || "Unknown Initiative",
      status: "queued",
      results: [],
      toolCalls: [],
      startedAt: new Date().toISOString(),
    };

    await deepDiveStore.createDeepDive(dive);

    // Fire and forget
    runDeepDive(deepDiveId).catch((err) => {
      console.error(`[deep-dive] Failed for ${deepDiveId}:`, err);
    });

    return c.json({ deepDiveId });
  } catch (err) {
    console.error("[deep-dive] Error:", err);
    return c.json({ error: err instanceof Error ? err.message : "Invalid request" }, 400);
  }
});

app.get("/api/deep-dive/:deepDiveId", async (c) => {
  const dive = await deepDiveStore.getDeepDive(c.req.param("deepDiveId"));
  if (!dive) return c.json({ error: "Deep dive not found" }, 404);
  return c.json(dive);
});

// ── Deep Dive SSE Stream ────────────────────────────
app.get("/api/deep-dive/stream/:deepDiveId", async (c) => {
  const deepDiveId = c.req.param("deepDiveId");
  const dive = await deepDiveStore.getDeepDive(deepDiveId);

  if (dive && (dive.status === "completed" || dive.status === "failed")) {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "status", data: JSON.stringify({ deepDiveId, status: dive.status }) });
      if (dive.results.length > 0) {
        await stream.writeSSE({ event: "results", data: JSON.stringify({ deepDiveId, results: dive.results }) });
      }
      await stream.writeSSE({
        event: dive.status === "completed" ? "complete" : "error",
        data: JSON.stringify(
          dive.status === "completed" ? { deepDiveId } : { deepDiveId, error: dive.error }
        ),
      });
    });
  }

  return streamSSE(c, async (stream) => {
    const bus = getEventBus(deepDiveId);
    let eventIndex = 0;
    let done = false;

    const unsubscribe = bus.subscribe((event) => {
      if (done) return;
      const e = event as unknown as DeepDiveStreamEvent;
      const currentIndex = eventIndex++;

      stream
        .writeSSE({ id: String(currentIndex), event: e.type, data: JSON.stringify(e.data) })
        .catch(() => {
          done = true;
          unsubscribe();
        });

      if (e.type === "complete" || e.type === "error") {
        done = true;
        unsubscribe();
      }
    });

    const heartbeat = setInterval(() => {
      if (done) { clearInterval(heartbeat); return; }
      stream.write(": heartbeat\n\n").catch(() => {
        clearInterval(heartbeat);
        done = true;
        unsubscribe();
      });
    }, 15_000);

    while (!done) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    clearInterval(heartbeat);
  });
});

// ── Start ───────────────────────────────────────────
const port = parseInt(process.env.PORT || "3001", 10);
console.log(`[server] Starting Hono API server on port ${port}...`);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[server] Listening on http://localhost:${info.port}`);
});

// Start WebSocket server for agent communication
import { startAgentWsServer } from "@/lib/agents/agent-ws";
startAgentWsServer(server as unknown as import("http").Server);
