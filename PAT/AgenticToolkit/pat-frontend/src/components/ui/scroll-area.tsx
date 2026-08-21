import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Lightweight scroll container — we deliberately don't use Radix
 * ScrollArea because its virtualizing behavior plays poorly with
 * append-and-stick-to-bottom log streams. A native overflow div
 * with our themed scrollbar is simpler, faster, and matches the
 * monospace-log aesthetic.
 */
export const ScrollArea = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, children, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('thin-scroll relative overflow-y-auto overflow-x-hidden', className)}
      {...props}
    >
      {children}
    </div>
  ),
);
ScrollArea.displayName = 'ScrollArea';
