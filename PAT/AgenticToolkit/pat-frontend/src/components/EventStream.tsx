import { memo, useEffect, useMemo, useRef } from 'react';
import { fmtTime } from '@/lib/utils';
import { kindClassToken, renderEvent } from '@/lib/event-render';
import type { LogEvent } from '@/types/log-events';
import { ScrollArea } from '@/components/ui/scroll-area';
import { MindStatusBlock } from '@/components/StatePanel';
import { useEventDetails } from '@/components/EventDetailsModal';
import type { DashboardState } from '@/hooks/use-dashboard-state';
import { usePersistedState } from '@/hooks/use-persisted-state';

export interface DisplayRow {
  /** Stable id derived from event content (ts|source|kind|thread_id).
   *  Lets React key rows so the list doesn't fully re-mount on every
   *  buffer change — which would otherwise look like the whole stream
   *  is scrolling/looping. */
  id: string;
  rec: LogEvent;
}

interface EventStreamProps {
  front: DisplayRow[];
  back: DisplayRow[];
  state: DashboardState;
}

export function EventStream({ front, back, state }: EventStreamProps) {
  return (
    <main className="grid min-h-0 flex-1 grid-cols-1 gap-4 px-6 pb-6 lg:grid-cols-2">
      <MindColumn accent="front" state={state} rows={front} />
      <MindColumn accent="back" state={state} rows={back} />
    </main>
  );
}

interface KindFilterAccordionProps {
  accent: 'front' | 'back';
  sortedKinds: Array<[string, number]>;
  hiddenKinds: Set<string>;
  onToggle: (kind: string) => void;
  onShowAll: () => void;
  onHideAll: () => void;
}

/** Per-column collapsible kind filter. Closed by default. The trigger
 *  shows "filters" with a count of currently hidden kinds in that
 *  column so the state is visible without expanding. */
function KindFilterAccordion({
  accent,
  sortedKinds,
  hiddenKinds,
  onToggle,
  onShowAll,
  onHideAll,
}: KindFilterAccordionProps) {
  const [open, setOpen] = usePersistedState<boolean>(
    `pat:filtersOpen:${accent}`,
    false,
  );

  if (sortedKinds.length === 0) return null;
  const hiddenInColumn = sortedKinds.filter(([k]) => hiddenKinds.has(k)).length;
  return (
    <div className="border-x border-border bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-3 py-1.5 text-[12px] uppercase tracking-[0.16em] text-muted-foreground hover:text-foreground"
      >
        <span className="flex items-center gap-2">
          <span aria-hidden className="inline-block w-3 text-center">
            {open ? '▾' : '▸'}
          </span>
          filters
          {hiddenInColumn > 0 && (
            <span className="text-[var(--warning)] normal-case tracking-normal">
              · {hiddenInColumn} hidden
            </span>
          )}
        </span>
        <span className="text-[11px] tabular-nums normal-case tracking-normal text-muted-foreground">
          {sortedKinds.length} kinds
        </span>
      </button>
      {open && (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-3 pt-1">
          {sortedKinds.map(([kind, count]) => {
            const off = hiddenKinds.has(kind);
            return (
              <button
                key={kind}
                type="button"
                onClick={() => onToggle(kind)}
                className={
                  'h-7 px-2.5 rounded-[var(--radius-sm)] border text-[12px] font-mono tracking-tight transition-colors ' +
                  (off
                    ? 'border-border bg-transparent text-muted-foreground hover:text-muted-foreground'
                    : 'border-border bg-accent text-foreground')
                }
                title={off ? `Show ${kind}` : `Hide ${kind}`}
              >
                <span>{kind}</span>
                <span className="ml-2 text-[10px] text-muted-foreground tabular-nums">
                  {count}
                </span>
              </button>
            );
          })}
          <span className="mx-1 h-4 w-px bg-border" />
          <button
            type="button"
            onClick={onShowAll}
            className="text-[12px] uppercase tracking-[0.16em] text-muted-foreground hover:text-foreground"
          >
            all
          </button>
          <button
            type="button"
            onClick={onHideAll}
            className="text-[12px] uppercase tracking-[0.16em] text-muted-foreground hover:text-foreground"
          >
            none
          </button>
        </div>
      )}
    </div>
  );
}

interface MindColumnProps {
  accent: 'front' | 'back';
  state: DashboardState;
  rows: DisplayRow[];
}

/**
 * One side of the Logs view: big mind heading, status block, per-column
 * filter accordion, then the live log scroll. front/back accent is
 * shared across all sub-blocks.
 */
function MindColumn({ accent, state, rows }: MindColumnProps) {
  // Our `ScrollArea` is a forwardRef'd plain `<div className="overflow-y-auto">`
  // — the scrollable element IS the ref target.
  const viewportRef = useRef<HTMLDivElement | null>(null);

  // Per-column kind filter. Stored as the list of kinds the user has
  // TURNED OFF (so newly-arriving kinds default visible). Persisted per
  // side so front/back can be filtered independently. We persist as
  // string[] because Set isn't JSON-stringifiable; the Set view is
  // derived for membership checks.
  const [hiddenKindsList, setHiddenKindsList] = usePersistedState<string[]>(
    `pat:hiddenKinds:${accent}`,
    [],
  );
  const hiddenKinds = useMemo(() => new Set(hiddenKindsList), [hiddenKindsList]);

  // Kinds present in this column, with counts. Sort alphabetically for
  // a stable chip order regardless of arrival order.
  const sortedKinds = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.rec.kind, (m.get(r.rec.kind) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }, [rows]);

  const toggleKind = (k: string) => {
    setHiddenKindsList((prev) =>
      prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k],
    );
  };
  const showAll = () => setHiddenKindsList([]);
  const hideAll = () => setHiddenKindsList(sortedKinds.map(([k]) => k));

  const visibleRows = useMemo(
    () => (hiddenKinds.size === 0 ? rows : rows.filter((r) => !hiddenKinds.has(r.rec.kind))),
    [rows, hiddenKinds],
  );

  // Auto-scroll toggle; persists per-side.
  const [autoScroll, setAutoScroll] = usePersistedState<boolean>(
    `pat:autoScroll:${accent}`,
    true,
  );

  useEffect(() => {
    if (!autoScroll) return;
    const el = viewportRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [visibleRows, autoScroll]);

  const titleColor =
    accent === 'front' ? 'text-foreground' : 'text-foreground';

  return (
    <section className="relative flex min-h-0 flex-col">
      {/* Big column header */}
      <div className="flex items-baseline justify-between pb-3">
        <h2
          className={`text-[24px] font-semibold uppercase tracking-[0.18em] ${titleColor}`}
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          {accent === 'front' ? 'front mind' : 'back mind'}
        </h2>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-[12px] uppercase tracking-[0.16em] text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="h-4 w-4 cursor-pointer accent-primary"
            />
            follow
          </label>
          <span className="font-mono text-[12px] text-muted-foreground">
            {visibleRows.length.toString().padStart(4, '0')}
            {hiddenKinds.size > 0 && (
              <span className="text-muted-foreground">
                {' / '}
                {rows.length.toString().padStart(4, '0')}
              </span>
            )}
          </span>
        </div>
      </div>

      {/* Status sub-block — sits inside the column above the log scroll */}
      <div
        className="rounded-t-[var(--radius-lg)] border border-b-0 border-border bg-muted/30 relative overflow-hidden"
      >
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-[1px]"
          style={{
            background: `linear-gradient(to right, transparent, var(--color-${accent}-line) 30%, var(--color-${accent}-line) 70%, transparent)`,
          }}
        />
        <MindStatusBlock accent={accent} state={state} />
      </div>

      {/* Per-column filter accordion */}
      <KindFilterAccordion
        accent={accent}
        sortedKinds={sortedKinds}
        hiddenKinds={hiddenKinds}
        onToggle={toggleKind}
        onShowAll={showAll}
        onHideAll={hideAll}
      />

      {/* Log scroll sub-block — flush with the filter / status above */}
      <div className="relative flex min-h-0 flex-1 flex-col rounded-b-[var(--radius-lg)] border border-t-0 border-border bg-muted/30 shadow-[var(--shadow-card)]">
        <div
          aria-hidden
          className="absolute inset-x-3 top-0 h-px bg-border"
        />
        <ScrollArea ref={viewportRef} className="min-h-0 flex-1 p-3">
          {visibleRows.length === 0 ? (
            <EmptyState accent={accent} />
          ) : (
            <ol className="flex flex-col gap-[2px]">
              {visibleRows.map((r) => (
                <Row key={r.id} rec={r.rec} />
              ))}
            </ol>
          )}
        </ScrollArea>
      </div>
    </section>
  );
}

const Row = memo(function Row({ rec }: { rec: LogEvent }) {
  const rendered = renderEvent(rec);
  const details = useEventDetails();
  if (!rendered) return null;
  const tint = kindClassToken(rendered.kindClass);

  return (
    <li
      role="button"
      tabIndex={0}
      onClick={() => details.open(rec)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          details.open(rec);
        }
      }}
      className="grid grid-cols-[5.75rem_minmax(8rem,12rem)_minmax(0,1fr)] items-baseline gap-3 border-b border-border/40 px-1 py-[4px] last:border-b-0 cursor-pointer hover:bg-accent/50 focus:bg-accent/60 outline-none"
      style={{ fontFamily: 'var(--font-mono)' }}
    >
      <span className="text-[12px] tabular-nums text-muted-foreground">
        {fmtTime(rec.ts)}
      </span>
      <span className={`truncate text-[13px] font-semibold tracking-tight ${tint}`}>
        {rec.kind}
      </span>
      <span className="min-w-0 break-words text-[14px] text-foreground">
        {rendered.body}
      </span>
    </li>
  );
});

function EmptyState({ accent }: { accent: 'front' | 'back' }) {
  return (
    <div className="flex h-full min-h-[12rem] flex-col items-center justify-center gap-3 py-12 text-center">
      <div
        aria-hidden
        className="h-2 w-2 rounded-full"
        style={{
          background: `var(--color-${accent})`,
          opacity: 0.4,
          boxShadow: `0 0 18px var(--color-${accent})`,
          animation: 'pulse-on 3s ease-out infinite',
          color: `var(--color-${accent})`,
        }}
      />
      <p className="text-[12px] uppercase tracking-[0.2em] text-muted-foreground">
        waiting for events…
      </p>
    </div>
  );
}
