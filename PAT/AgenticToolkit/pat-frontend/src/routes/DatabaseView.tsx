import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, HelpCircle } from 'lucide-react';
import Markdown from 'react-markdown';

import { DataTable, type ColumnMeta } from '@/components/DataTable';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useApiData } from '@/lib/api';
import { getTableDoc } from '@/lib/table-reference';
import { cn } from '@/lib/utils';

const PAGE = 50;

interface DbTablesResp {
  available: boolean;
  message?: string;
  tables: { name: string; exists: boolean; count: number }[];
}
interface ForeignKey {
  from: string;
  table: string;
  to: string;
}
interface DbTableResp {
  table: string;
  exists: boolean;
  columns: ColumnMeta[];
  foreignKeys?: ForeignKey[];
  total: number;
  rows: Record<string, unknown>[];
  message?: string;
}
interface PendingDrill {
  table: string;
  column: string;
  value: unknown;
}

export function DatabaseView({ token }: { token: string | null }) {
  const tablesQ = useApiData<DbTablesResp>('/api/db', token);
  const [picked, setPicked] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(0);
  const [drill, setDrill] = useState<Record<string, unknown> | null>(null);
  const [pending, setPending] = useState<PendingDrill | null>(null);
  const [showRef, setShowRef] = useState(false);

  const tables = tablesQ.data?.tables ?? [];
  const selected = picked ?? tables.find((t) => t.count > 0)?.name ?? tables[0]?.name ?? null;
  const doc = selected ? getTableDoc(selected) : undefined;
  const visibleTables = filter
    ? tables.filter((t) => t.name.toLowerCase().includes(filter.toLowerCase()))
    : tables;

  const rowsQ = useApiData<DbTableResp>(
    selected ? `/api/db/${selected}?limit=${PAGE}&offset=${page * PAGE}` : null,
    token,
  );
  const fks = rowsQ.data?.foreignKeys ?? [];
  const fkFor = (col: string): ForeignKey | undefined => fks.find((f) => f.from === col);

  // Reset to page 1 when the table changes.
  useEffect(() => setPage(0), [selected]);

  // After an FK jump, open the referenced row's detail once its table loads.
  useEffect(() => {
    if (!pending) return;
    if (!rowsQ.data || rowsQ.data.table !== pending.table) return;
    const match = rowsQ.data.rows.find((r) => String(r[pending.column]) === String(pending.value));
    setDrill(match ?? null);
    setPending(null);
  }, [pending, rowsQ.data]);

  const drillFk = (fk: ForeignKey, value: unknown) => {
    setDrill(null);
    setFilter('');
    setPicked(fk.table);
    setPending({ table: fk.table, column: fk.to, value });
  };

  const total = rowsQ.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {/* Table rail (Nhost-style). */}
      <aside className="flex w-56 shrink-0 flex-col border-r">
        <div className="border-b p-2">
          <p className="text-muted-foreground mb-1 px-1 font-mono text-[10px] uppercase tracking-wide">
            central v2.db · read-only
          </p>
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter tables…"
            className="h-7 font-mono text-xs"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {tablesQ.isLoading && <Skeleton className="mx-2 h-6" />}
          {visibleTables.map((t) => {
            const td = getTableDoc(t.name);
            const btn = (
              <button
                key={t.name}
                onClick={() => setPicked(t.name)}
                className={cn(
                  'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left font-mono text-xs',
                  selected === t.name
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:bg-muted/50',
                )}
              >
                <span className="truncate">{t.name}</span>
                <span className="text-muted-foreground/60 shrink-0">{t.count}</span>
              </button>
            );
            // Hover a table to see its one-line reference (when documented).
            return td ? (
              <Tooltip key={t.name}>
                <TooltipTrigger asChild>{btn}</TooltipTrigger>
                <TooltipContent side="right" className="max-w-xs">
                  {td.summary}
                </TooltipContent>
              </Tooltip>
            ) : (
              btn
            );
          })}
        </div>
      </aside>

      {/* Main pane. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-4">
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm">{selected ?? '—'}</span>
          {rowsQ.data?.exists && <Badge variant="secondary">{total} rows</Badge>}
          {selected && (
            <Tooltip>
              {/* span wrapper keeps the tooltip hoverable even when the button is
                  disabled (no reference) — disabled buttons swallow pointer events. */}
              <TooltipTrigger asChild>
                <span tabIndex={0}>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    disabled={!doc}
                    onClick={() => doc && setShowRef(true)}
                    aria-label="Table reference"
                  >
                    <HelpCircle className="size-4" />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                {doc ? doc.summary : 'No reference available'}
              </TooltipContent>
            </Tooltip>
          )}
          <div className="flex-1" />
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={page <= 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="text-muted-foreground font-mono text-xs">
              {page + 1} / {pageCount}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={page >= pageCount - 1}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>

        {tablesQ.error && <ErrorBar message={tablesQ.error.message} />}
        {rowsQ.error && <ErrorBar message={rowsQ.error.message} />}

        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {rowsQ.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : rowsQ.data && !rowsQ.data.exists ? (
            <p className="text-muted-foreground text-xs">{rowsQ.data.message ?? 'Table not present.'}</p>
          ) : rowsQ.data ? (
            <DataTable
              columns={rowsQ.data.columns}
              rows={rowsQ.data.rows}
              onRowClick={setDrill}
              columnDocs={doc?.columns}
            />
          ) : null}
        </div>
      </div>

      <Dialog open={drill !== null} onOpenChange={(o) => !o && setDrill(null)}>
        <DialogContent className="max-h-[80vh] overflow-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{selected} · row</DialogTitle>
          </DialogHeader>
          {drill && (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-xs">
              {Object.entries(drill).map(([k, v]) => {
                const fk = fkFor(k);
                return (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground font-mono whitespace-nowrap">{k}</dt>
                    <dd className="font-mono break-all">
                      {fk && v !== null && v !== undefined ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button className="text-primary hover:underline" onClick={() => drillFk(fk, v)}>
                              {String(v)} ↗
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>
                            Foreign key → {fk.table}.{fk.to}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        fmtVal(v)
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          )}
        </DialogContent>
      </Dialog>

      {/* Table reference — markdown long-form + per-column dictionary + links. */}
      <Dialog open={showRef} onOpenChange={setShowRef}>
        <DialogContent className="max-h-[80vh] overflow-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{selected} · reference</DialogTitle>
          </DialogHeader>
          {doc && (
            <div className="space-y-4">
              <Markdown components={MD}>{doc.description}</Markdown>
              <div>
                <p className="text-muted-foreground mb-1 text-xs font-medium uppercase tracking-wide">
                  Columns
                </p>
                <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
                  {Object.entries(doc.columns).map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-foreground font-mono whitespace-nowrap">{k}</dt>
                      <dd className="text-muted-foreground">{v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              {doc.docs && doc.docs.length > 0 && (
                <div>
                  <p className="text-muted-foreground mb-1 text-xs font-medium uppercase tracking-wide">
                    References
                  </p>
                  <ul className="space-y-1 text-xs">
                    {doc.docs.map((d) => (
                      <li key={d.url}>
                        <a
                          href={d.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:underline"
                        >
                          {d.label} ↗
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Minimal markdown element styling for the reference modal (no typography
 *  plugin — map the elements we actually use to shadcn-token classes). */
const MD: import('react-markdown').Components = {
  p: ({ children }) => <p className="text-muted-foreground text-sm leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="text-muted-foreground ml-4 list-disc space-y-1 text-sm">{children}</ul>,
  ol: ({ children }) => <ol className="text-muted-foreground ml-4 list-decimal space-y-1 text-sm">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  code: ({ children }) => (
    <code className="bg-muted text-foreground rounded px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary hover:underline">
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="text-foreground font-medium">{children}</strong>,
  h1: ({ children }) => <h3 className="text-foreground text-sm font-semibold">{children}</h3>,
  h2: ({ children }) => <h3 className="text-foreground text-sm font-semibold">{children}</h3>,
  h3: ({ children }) => <h3 className="text-foreground text-sm font-semibold">{children}</h3>,
};

function ErrorBar({ message }: { message: string }) {
  return (
    <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs">
      {message}
    </div>
  );
}

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }
  return String(v);
}
