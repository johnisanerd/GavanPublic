interface CaptionOverlayProps {
  user: string;
  persona: string;
}

/**
 * Bottom-third caption strip. We show:
 *   - persona partials prominently (the avatar's voice — what the user
 *     is hearing as it's spoken).
 *   - user partials in a muted pill below, so the speaker can sanity-
 *     check that Anam's STT is hearing them.
 */
export function CaptionOverlay({ user, persona }: CaptionOverlayProps) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex flex-col items-center gap-2 px-6 pb-10">
      {user && (
        <div className="rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-bg-glass)] px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-[var(--color-ink-3)] backdrop-blur">
          {user}
        </div>
      )}
      {persona && (
        <div
          className="max-w-3xl text-balance text-center text-[24px] leading-snug text-[var(--color-ink-1)]"
          style={{
            fontFamily: 'var(--font-serif)',
            fontStyle: 'italic',
            textShadow: '0 2px 12px oklch(0 0 0 / 0.65)',
          }}
        >
          {persona}
        </div>
      )}
    </div>
  );
}
