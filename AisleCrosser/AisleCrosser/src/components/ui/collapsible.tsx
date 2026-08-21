"use client";

import { useState } from "react";

interface CollapsibleProps {
  title: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function Collapsible({ title, defaultOpen = false, children, className = "" }: CollapsibleProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={className}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(!open); } }}
        className="flex items-center gap-2 w-full text-left py-3 px-1 hover:bg-surface-low transition-tonal cursor-pointer"
      >
        <svg
          className={`h-4 w-4 text-gold transition-transform duration-200 ${open ? "rotate-90" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span className="flex-1">{title}</span>
      </div>
      {open && <div className="pl-6 pt-1 pb-3">{children}</div>}
    </div>
  );
}
