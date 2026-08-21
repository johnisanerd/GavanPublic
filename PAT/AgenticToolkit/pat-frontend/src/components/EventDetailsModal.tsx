import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { LogEvent } from '@/types/log-events';
import { vendorOf } from '@/types/log-events';
import { fmtTime } from '@/lib/utils';

interface DetailsContextValue {
  open: (rec: LogEvent) => void;
}

const DetailsContext = createContext<DetailsContextValue | null>(null);

export function useEventDetails(): DetailsContextValue {
  const v = useContext(DetailsContext);
  if (!v) {
    // Fallback no-op so consumers can call it unconditionally even if
    // they're rendered outside a provider (e.g. in a test).
    return { open: () => {} };
  }
  return v;
}

interface ProviderProps {
  children: React.ReactNode;
}

/**
 * Provider + modal renderer in one component. Wrap the app once at the
 * root and consumers anywhere below can call `useEventDetails().open(rec)`
 * to surface the full event payload in a modal.
 */
export function EventDetailsProvider({ children }: ProviderProps) {
  const [active, setActive] = useState<LogEvent | null>(null);
  const open = useCallback((rec: LogEvent) => setActive(rec), []);
  const close = useCallback(() => setActive(null), []);

  // ESC closes the modal.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, close]);

  return (
    <DetailsContext.Provider value={{ open }}>
      {children}
      {active && <Modal rec={active} onClose={close} />}
    </DetailsContext.Provider>
  );
}

function Modal({ rec, onClose }: { rec: LogEvent; onClose: () => void }) {
  const accent = rec.kind.startsWith('chat.') || rec.kind.startsWith('container.') ||
    rec.kind.startsWith('session.') || rec.kind.startsWith('routing.')
    ? 'back'
    : 'front';

  const dataJson = (() => {
    try {
      return JSON.stringify(rec.data, null, 2);
    } catch {
      return String(rec.data);
    }
  })();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Event details"
      className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh] pb-[8vh] px-4 bg-black/55 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative flex max-h-full w-full max-w-[820px] flex-col rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-card)] overflow-hidden">
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-[1px]"
          style={{
            background: `linear-gradient(to right, transparent, var(--color-${accent}-line) 30%, var(--color-${accent}-line) 70%, transparent)`,
          }}
        />
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-5 py-3 border-b border-[var(--color-border-subtle)]">
          <div className="flex flex-col leading-tight min-w-0">
            <div className="flex items-baseline gap-3">
              <span
                className={`text-[15px] font-mono font-semibold tracking-tight truncate ${
                  accent === 'front' ? 'text-[var(--color-front)]' : 'text-[var(--color-back)]'
                }`}
              >
                {rec.kind}
              </span>
              {rec.level && rec.level !== 'info' && (
                <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-warn)]">
                  {rec.level}
                </span>
              )}
            </div>
            <div className="text-[12px] text-[var(--color-ink-4)] font-mono mt-0.5">
              {fmtTime(rec.ts)} · {rec.source ?? '—'}
              {rec.id && <span className="ml-2 text-[var(--color-ink-5)]">id={rec.id}</span>}
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="text-[16px] text-[var(--color-ink-4)] hover:text-[var(--color-ink-1)] px-2 py-0.5 leading-none"
          >
            ✕
          </button>
        </div>

        {/* Metadata grid */}
        <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-5 py-3 text-[13px] border-b border-[var(--color-border-subtle)]">
          <Field label="thread" value={rec.thread_id} />
          <Field label="session" value={rec.session_id} />
          <Field label="vendor" value={vendorOf(rec.kind) ?? null} />
          <Field label="ts (utc)" value={rec.ts} />
        </dl>

        {/* Raw data block — scrollable. */}
        <div className="flex min-h-0 flex-1 flex-col px-5 py-3">
          <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-4)] mb-1">
            data
          </div>
          <pre
            className="min-h-0 flex-1 overflow-auto thin-scroll text-[12px] leading-[1.5] font-mono p-3 rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-sunken)] text-[var(--color-ink-1)] whitespace-pre"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            {dataJson}
          </pre>
        </div>

        <div className="px-5 py-2 text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-5)] border-t border-[var(--color-border-subtle)]">
          press esc or click outside to close
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | undefined | null }) {
  return (
    <>
      <dt className="self-center text-[10px] uppercase tracking-[0.16em] text-[var(--color-ink-4)]">
        {label}
      </dt>
      <dd className="min-w-0 break-all font-mono text-[12px] text-[var(--color-ink-1)]">
        {value || <span className="text-[var(--color-ink-5)]">—</span>}
      </dd>
    </>
  );
}
