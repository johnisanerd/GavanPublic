"use client";

import { useState, useEffect, useRef } from "react";
import type { DeepDive, DeepDiveResult, DeepDiveToolCall } from "@/lib/types/deep-dive";

export interface DeepDiveStreamState {
  status: DeepDive["status"];
  results: DeepDiveResult[];
  toolCalls: DeepDiveToolCall[];
  error: string | null;
}

export function useDeepDiveStream(deepDiveId: string | null): DeepDiveStreamState {
  const [status, setStatus] = useState<DeepDive["status"]>("queued");
  const [results, setResults] = useState<DeepDiveResult[]>([]);
  const [toolCalls, setToolCalls] = useState<DeepDiveToolCall[]>([]);
  const [error, setError] = useState<string | null>(null);
  const lastProcessedId = useRef(-1);

  useEffect(() => {
    lastProcessedId.current = -1;
  }, [deepDiveId]);

  useEffect(() => {
    if (!deepDiveId) return;

    // Hydrate from REST first
    fetch(`/api/deep-dive/${deepDiveId}`)
      .then((res) => res.json())
      .then((data: DeepDive) => {
        if (data.status) setStatus(data.status);
        if (data.results?.length) setResults(data.results);
        if (data.toolCalls?.length) setToolCalls(data.toolCalls);
        if (data.error) setError(data.error);
      })
      .catch(() => { /* SSE will handle it */ });

    // Connect SSE
    const eventSource = new EventSource(`/api/deep-dive/stream/${deepDiveId}`);

    const isDuplicate = (e: MessageEvent): boolean => {
      const id = parseInt(e.lastEventId, 10);
      if (isNaN(id)) return false;
      if (id <= lastProcessedId.current) return true;
      lastProcessedId.current = id;
      return false;
    };

    eventSource.addEventListener("status", (e) => {
      if (isDuplicate(e)) return;
      const data = JSON.parse(e.data);
      setStatus(data.status);
    });

    eventSource.addEventListener("tool_call", (e) => {
      if (isDuplicate(e)) return;
      const tc: DeepDiveToolCall = JSON.parse(e.data);
      setToolCalls((prev) => [...prev, tc]);
    });

    eventSource.addEventListener("results", (e) => {
      if (isDuplicate(e)) return;
      const data = JSON.parse(e.data) as { results: DeepDiveResult[] };
      setResults(data.results);
    });

    eventSource.addEventListener("complete", () => {
      setStatus("completed");
      eventSource.close();
    });

    eventSource.addEventListener("error", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        setError(data.error);
        setStatus("failed");
      } catch {
        if (eventSource.readyState === EventSource.CLOSED) {
          setError("Connection closed");
        }
      }
      eventSource.close();
    });

    return () => eventSource.close();
  }, [deepDiveId]);

  return { status, results, toolCalls, error };
}
