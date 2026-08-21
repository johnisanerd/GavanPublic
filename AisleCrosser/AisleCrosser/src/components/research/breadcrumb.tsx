"use client";

export interface BreadcrumbSegment {
  label: string;
  onClick?: () => void;
}

interface BreadcrumbProps {
  segments: BreadcrumbSegment[];
}

export function Breadcrumb({ segments }: BreadcrumbProps) {
  return (
    <nav className="flex items-center gap-1.5 text-sm text-ink-muted mb-6" aria-label="Breadcrumb">
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        return (
          <span key={i} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-ink-muted/50">/</span>}
            {isLast ? (
              <span className="text-ink font-semibold">{seg.label}</span>
            ) : (
              <button
                onClick={seg.onClick}
                className="hover:text-navy transition-colors underline underline-offset-2 decoration-ink-muted/30 hover:decoration-navy/50"
              >
                {seg.label}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
