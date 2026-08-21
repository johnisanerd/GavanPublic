import type { ReactNode } from 'react';
import type { DashboardState } from '@/hooks/use-dashboard-state';

/** Status rows for one side of the dashboard, no surrounding card —
 *  the parent column owns the heading and chrome. */
export function MindStatusBlock({
  accent,
  state,
}: {
  accent: 'front' | 'back';
  state: DashboardState;
}) {
  const rows: Row[] = accent === 'front' ? frontRows(state) : backRows(state);
  return (
    <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-2 px-4 py-4">
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt className="self-center text-[12px] uppercase tracking-[0.16em] text-muted-foreground">
            {r.label}
          </dt>
          <dd className="min-w-0 text-[14px] text-foreground">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

interface Row {
  label: string;
  value: ReactNode;
}

function frontRows(state: DashboardState): Row[] {
  return [
    // The displayed thread id is already shown in the header dropdown;
    // restating it here is clutter.
    { label: 'caller', value: <Mono>{state.caller ?? '—'}</Mono> },
    {
      label: 'narration',
      value: (
        <DotLabel on={state.isProcessingNarration} onLabel="processing" offLabel="idle" />
      ),
    },
    {
      label: 'tts',
      value: <DotLabel on={state.isTtsBusy} onLabel="busy" offLabel="quiet" />,
    },
    { label: 'banter buf', value: <Mono>{state.banterBufferCount}</Mono> },
    { label: 'sse clients', value: <Mono>{state.sseClients}</Mono> },
  ];
}

function backRows(state: DashboardState): Row[] {
  return [
    { label: 'session', value: <Mono>{state.sessionId ?? '—'}</Mono> },
    {
      label: 'container',
      value: (
        <DotLabel
          on={state.containerRunning}
          onLabel="running"
          offLabel={
            state.containerExitCode == null ? 'idle' : `exit ${state.containerExitCode}`
          }
          offTone={
            state.containerExitCode != null && state.containerExitCode !== 0 ? 'bad' : 'off'
          }
        />
      ),
    },
    { label: 'chat seq', value: <Mono>{state.lastChatSeq ?? '—'}</Mono> },
    {
      label: 'last chat',
      value: (
        <span className="block max-w-full truncate font-mono text-[13px] text-foreground">
          {state.lastChatPreview ?? '—'}
        </span>
      ),
    },
  ];
}



function Mono({ children }: { children: ReactNode }) {
  return (
    <span
      className="font-mono text-[13px] text-foreground"
      style={{ fontFamily: 'var(--font-mono)' }}
    >
      {children}
    </span>
  );
}

function DotLabel({
  on,
  onLabel,
  offLabel,
  offTone = 'off',
}: {
  on: boolean;
  onLabel: string;
  offLabel: string;
  offTone?: 'off' | 'bad';
}) {
  const dotClass = on ? 'on' : offTone === 'bad' ? 'bad' : '';
  const label = on ? onLabel : offLabel;
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`dot ${dotClass}`} />
      <span className="text-[13px] text-foreground">{label}</span>
    </span>
  );
}
