import { getEventBus } from "@/lib/agents/event-bus";
import { getResearch } from "@/lib/store/research";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ researchId: string }> }
) {
  const { researchId } = await params;

  const research = await getResearch(researchId);
  if (!research) {
    return new Response(JSON.stringify({ error: "Research not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // If already completed, replay stored recommendations then close
  if (research.status === "completed" || research.status === "failed") {
    const encoder = new TextEncoder();
    const parts: string[] = [];

    // Send research status
    parts.push(`event: research_status\ndata: ${JSON.stringify({ researchId, status: research.status })}\n\n`);

    // Replay stored agent info as agent_event status events
    for (const agent of research.agents || []) {
      parts.push(
        `event: agent_event\ndata: ${JSON.stringify({
          type: "status",
          agentId: agent.id,
          agentType: agent.agentType,
          status: "completed",
          message: `${agent.displayName} completed`,
          timestamp: agent.completedAt || research.completedAt || new Date().toISOString(),
        })}\n\n`
      );
    }

    // Replay stored candidates
    for (const cand of research.candidates || []) {
      parts.push(`event: candidate\ndata: ${JSON.stringify(cand)}\n\n`);
    }

    // Replay stored recommendations
    for (const rec of research.recommendations || []) {
      parts.push(`event: recommendation\ndata: ${JSON.stringify(rec)}\n\n`);
    }

    // Send completion
    parts.push(
      `event: ${research.status === "completed" ? "complete" : "error"}\ndata: ${JSON.stringify(
        research.status === "completed"
          ? { researchId }
          : { researchId, error: research.error }
      )}\n\n`
    );

    return new Response(encoder.encode(parts.join("")), {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-store",
        Connection: "keep-alive",
      },
    });
  }

  const lastEventId = request.headers.get("Last-Event-ID");
  const startFrom = lastEventId ? parseInt(lastEventId, 10) + 1 : 0;
  const encoder = new TextEncoder();
  let eventIndex = 0;

  const stream = new ReadableStream({
    start(controller) {
      const bus = getEventBus(researchId);

      const unsubscribe = bus.subscribe((event) => {
        const currentIndex = eventIndex++;
        if (currentIndex < startFrom) return;

        const sseMessage =
          `id: ${currentIndex}\n` +
          `event: ${event.type}\n` +
          `data: ${JSON.stringify(event.data)}\n\n`;

        try {
          controller.enqueue(encoder.encode(sseMessage));
        } catch {
          // Stream was closed
          unsubscribe();
        }

        if (event.type === "complete" || event.type === "error") {
          unsubscribe();
          try { controller.close(); } catch { /* already closed */ }
        }
      }, startFrom);

      // Heartbeat
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          clearInterval(heartbeat);
          unsubscribe();
        }
      }, 15_000);

      request.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
