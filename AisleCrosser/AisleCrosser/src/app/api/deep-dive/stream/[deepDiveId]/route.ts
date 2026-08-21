import { getEventBus } from "@/lib/agents/event-bus";
import { getDeepDive } from "@/lib/store/deep-dives";
import type { DeepDiveStreamEvent } from "@/lib/types/deep-dive";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ deepDiveId: string }> }
) {
  const { deepDiveId } = await params;

  const dive = await getDeepDive(deepDiveId);
  if (!dive) {
    return new Response(JSON.stringify({ error: "Deep dive not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // If already completed, replay results then close
  if (dive.status === "completed" || dive.status === "failed") {
    const encoder = new TextEncoder();
    const parts: string[] = [];

    parts.push(`event: status\ndata: ${JSON.stringify({ deepDiveId, status: dive.status })}\n\n`);

    if (dive.results.length > 0) {
      parts.push(`event: results\ndata: ${JSON.stringify({ deepDiveId, results: dive.results })}\n\n`);
    }

    parts.push(
      `event: ${dive.status === "completed" ? "complete" : "error"}\ndata: ${JSON.stringify(
        dive.status === "completed"
          ? { deepDiveId }
          : { deepDiveId, error: dive.error }
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

  const encoder = new TextEncoder();
  let eventIndex = 0;

  const stream = new ReadableStream({
    start(controller) {
      const bus = getEventBus(deepDiveId);

      const unsubscribe = bus.subscribe((event) => {
        const e = event as unknown as DeepDiveStreamEvent;
        const currentIndex = eventIndex++;
        const sseMessage = `id: ${currentIndex}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`;

        try {
          controller.enqueue(encoder.encode(sseMessage));
        } catch {
          unsubscribe();
        }

        if (e.type === "complete" || e.type === "error") {
          unsubscribe();
          try { controller.close(); } catch { /* already closed */ }
        }
      });

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
