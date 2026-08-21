import { useId } from 'react';
import { cn } from '@/lib/utils';

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Override value display (e.g. for percentage). */
  format?: (v: number) => string;
  onChange: (v: number) => void;
  className?: string;
}

export function Slider({ label, value, min, max, step = 0.01, format, onChange, className }: SliderProps) {
  const id = useId();
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-4)]">
          {label}
        </label>
        <span className="font-mono text-[10px] text-[var(--color-ink-3)]">
          {format ? format(value) : value.toFixed(2)}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
