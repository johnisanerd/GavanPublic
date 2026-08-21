import { cn } from '@/lib/utils';

interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  className?: string;
}

export function Toggle({ label, checked, onChange, className }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'flex items-center justify-between gap-3 rounded-[var(--radius-sm)] px-2 py-1.5 text-left',
        'border border-transparent hover:bg-[var(--color-bg-elevated)]',
        className,
      )}
    >
      <span className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-ink-3)]">
        {label}
      </span>
      <span
        className={cn(
          'relative inline-flex h-4 w-7 items-center rounded-full transition-colors',
          checked ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]',
        )}
      >
        <span
          className={cn(
            'inline-block h-3 w-3 rounded-full bg-[var(--color-ink-1)] transition-transform',
            checked ? 'translate-x-3.5' : 'translate-x-0.5',
          )}
        />
      </span>
    </button>
  );
}
