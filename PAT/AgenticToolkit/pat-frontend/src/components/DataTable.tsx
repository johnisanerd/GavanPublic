import { ChevronDown, ChevronUp, KeyRound } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export interface ColumnMeta {
  name: string;
  type?: string;
  pk?: number;
}

type Row = Record<string, unknown>;

const ISO_TS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** Cell renderer — muted `null`, stacked date/time for ISO timestamps (Nhost
 *  style), JSON for objects, raw otherwise. */
function Cell({ value }: { value: unknown }): ReactNode {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground/50 italic">null</span>;
  }
  if (typeof value === 'object') {
    return <span>{safeJson(value)}</span>;
  }
  const s = String(value);
  if (ISO_TS.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      return (
        <span className="flex flex-col leading-tight">
          <span>{d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</span>
          <span className="text-muted-foreground text-[10px]">{d.toLocaleTimeString('en-GB')}</span>
        </span>
      );
    }
  }
  return <span>{s}</span>;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Read-only table modeled on Nhost's data browser: each header shows the column
 * name + its type, with a key icon on the primary key. Built on
 * @tanstack/react-table for the column model + client-side sorting.
 *
 * SORT SCOPE: sorting runs client-side over the currently-loaded page only. The
 * API paginates server-side (limit/offset), so clicking a header reorders just
 * the ~50 visible rows, not the whole table. Fine for v1.
 *
 * RENDER-LOOP SAFETY: the old Users page locked the tab on an unstable
 * react-table + manual-fetch combo (new columns/data refs every render →
 * infinite re-render). Guards here: `columns` is memoized on `[columns]` (the
 * ColumnMeta array, stable per react-query fetch); `rows` is passed straight
 * through as `data` (also stable per fetch — never remapped/cloned inline); and
 * no setState happens during render.
 */
export function DataTable({
  columns,
  rows,
  onRowClick,
  columnDocs,
}: {
  columns: ColumnMeta[];
  rows: Row[];
  onRowClick?: (row: Row) => void;
  /** Per-column one-line descriptions (from the table reference). When a column
   *  has one, its header name gets a dotted underline + a hover tooltip. Stable
   *  ref (a constant module object), so it's safe in the columns useMemo deps. */
  columnDocs?: Record<string, string>;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);

  const tableColumns = useMemo<ColumnDef<Row>[]>(
    () =>
      columns.map((c) => ({
        id: c.name,
        accessorFn: (row) => row[c.name],
        // Sort nullish values last regardless of direction; otherwise lexical.
        sortingFn: (a, b, colId) => {
          const av = a.getValue(colId);
          const bv = b.getValue(colId);
          if (av == null && bv == null) return 0;
          if (av == null) return 1;
          if (bv == null) return -1;
          if (typeof av === 'number' && typeof bv === 'number') return av - bv;
          return String(av).localeCompare(String(bv));
        },
        header: () => (
          <>
            <span className="text-foreground flex items-center gap-1 text-xs font-medium normal-case">
              {c.pk ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <KeyRound className="text-primary size-3" />
                  </TooltipTrigger>
                  <TooltipContent>Primary key</TooltipContent>
                </Tooltip>
              ) : null}
              {columnDocs?.[c.name] ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="decoration-muted-foreground/40 cursor-help underline decoration-dotted underline-offset-2">
                      {c.name}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">{columnDocs[c.name]}</TooltipContent>
                </Tooltip>
              ) : (
                c.name
              )}
            </span>
            {c.type ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-muted-foreground block w-fit font-mono text-[10px] normal-case">
                    {c.type}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{c.type}</TooltipContent>
              </Tooltip>
            ) : (
              <span className="text-muted-foreground block font-mono text-[10px] normal-case">text</span>
            )}
          </>
        ),
        cell: (ctx) => <Cell value={ctx.getValue()} />,
      })),
    [columns, columnDocs],
  );

  const table = useReactTable({
    data: rows,
    columns: tableColumns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="min-w-0 overflow-auto rounded-md border">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((hg) => (
            <TableRow key={hg.id}>
              {hg.headers.map((header) => {
                const sorted = header.column.getIsSorted();
                return (
                  <TableHead
                    key={header.id}
                    onClick={header.column.getToggleSortingHandler()}
                    className="bg-muted/30 hover:bg-muted/50 h-auto cursor-pointer select-none whitespace-nowrap py-2 align-top"
                  >
                    <div className="flex items-start gap-1">
                      <div className="min-w-0">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </div>
                      <span className="text-muted-foreground mt-0.5 shrink-0">
                        {sorted === 'asc' ? (
                          <ChevronUp className="size-3" />
                        ) : sorted === 'desc' ? (
                          <ChevronDown className="size-3" />
                        ) : null}
                      </span>
                    </div>
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={tableColumns.length} className="text-muted-foreground text-center text-xs">
                No rows
              </TableCell>
            </TableRow>
          ) : (
            table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                className={onRowClick ? 'cursor-pointer' : undefined}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} className="font-mono text-xs whitespace-nowrap">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
