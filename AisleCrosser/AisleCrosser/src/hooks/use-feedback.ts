"use client";

import { useState, useCallback } from "react";

export function useFeedback(researchId: string) {
  const [submitting, setSubmitting] = useState(false);

  const submitFeedback = useCallback(
    async (
      targetType: "recommendation" | "reasoning_step",
      targetId: string,
      value: "up" | "down" | null,
      comment?: string
    ) => {
      setSubmitting(true);
      try {
        const res = await fetch(`/api/research/${researchId}/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetType, targetId, value, comment }),
        });
        return res.ok;
      } finally {
        setSubmitting(false);
      }
    },
    [researchId]
  );

  return { submitFeedback, submitting };
}
