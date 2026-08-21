import { Outlet } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { EventBuffer } from '@/hooks/use-event-buffer';

const STATUS_LABEL: Record<string, string> = {
  connecting: 'connecting',
  connected: 'live',
  disconnected: 'offline',
};

/**
 * The Session section's shared chrome: the ONE consistent session selector +
 * connection status + clear, above the Timeline/Logs views (via <Outlet>).
 * Replaces the old scattered ?thread= picker.
 */
export function SessionLayout({ eb }: { eb: EventBuffer }) {
  const { status, displayedThread, threadsByRecency, onPickThread, onClear, isFollowingLatest } = eb;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 px-4 py-2">
        <span
          className={`dot ${status === 'connected' ? 'on' : status === 'disconnected' ? 'bad' : 'warn'}`}
          title={status}
        />
        <span className="text-muted-foreground font-mono text-xs uppercase tracking-wide">
          {STATUS_LABEL[status] ?? status}
        </span>

        <Select value={displayedThread ?? ''} onValueChange={onPickThread}>
          <SelectTrigger className="w-[280px] font-mono text-xs">
            <SelectValue placeholder="No sessions yet" />
          </SelectTrigger>
          <SelectContent>
            {threadsByRecency.map((t) => (
              <SelectItem key={t.tid} value={t.tid} className="font-mono text-xs">
                {t.tid}
                {t.isTest ? '  · test' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {isFollowingLatest && (
          <span className="text-muted-foreground font-mono text-[10px] uppercase tracking-wide">
            following latest
          </span>
        )}

        <div className="flex-1" />
        <Button variant="ghost" size="sm" className="text-xs" onClick={onClear}>
          Clear
        </Button>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Outlet />
      </div>
    </div>
  );
}
