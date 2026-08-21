"use client";

import { useState } from "react";

interface FeedbackButtonsProps {
  initialValue?: "up" | "down" | null;
  onFeedback: (value: "up" | "down" | null) => void;
  size?: "sm" | "md";
}

export function FeedbackButtons({ initialValue = null, onFeedback, size = "md" }: FeedbackButtonsProps) {
  const [value, setValue] = useState(initialValue);

  const handleClick = (newValue: "up" | "down") => {
    const next = value === newValue ? null : newValue;
    setValue(next);
    onFeedback(next);
  };

  const iconSize = size === "sm" ? "h-4 w-4" : "h-5 w-5";
  const buttonSize = size === "sm" ? "p-1.5" : "p-2";

  return (
    <div className="inline-flex items-center gap-1">
      <button
        onClick={() => handleClick("up")}
        className={`${buttonSize} transition-tonal ${
          value === "up"
            ? "bg-emerald-50 text-emerald-700"
            : "text-ink-muted hover:text-emerald-600 hover:bg-emerald-50"
        }`}
        title="This is accurate"
      >
        <svg className={iconSize} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5" />
        </svg>
      </button>
      <button
        onClick={() => handleClick("down")}
        className={`${buttonSize} transition-tonal ${
          value === "down"
            ? "bg-rep-bg text-rep-red"
            : "text-ink-muted hover:text-rep-red hover:bg-rep-bg"
        }`}
        title="This is inaccurate"
      >
        <svg className={iconSize} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M10 14H5.236a2 2 0 01-1.789-2.894l3.5-7A2 2 0 018.736 3h4.018a2 2 0 01.485.06l3.76.94m-7 10v5a2 2 0 002 2h.096c.5 0 .905-.405.905-.904 0-.715.211-1.413.608-2.008L17 13V4m-7 10h2m5-10h2a2 2 0 012 2v6a2 2 0 01-2 2h-2.5" />
        </svg>
      </button>
    </div>
  );
}
