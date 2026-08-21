import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-sm)] text-[12px] font-medium tracking-[0.01em] transition-all disabled:pointer-events-none disabled:opacity-40 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-line)] focus-visible:ring-offset-0',
  {
    variants: {
      variant: {
        default:
          'bg-[var(--color-bg-elevated)] text-[var(--color-ink-1)] border border-[var(--color-border)] hover:bg-[var(--color-bg-glass)] hover:border-[var(--color-border-strong)] active:translate-y-[0.5px]',
        ghost:
          'text-[var(--color-ink-3)] hover:text-[var(--color-ink-1)] hover:bg-[var(--color-bg-elevated)]',
        outline:
          'bg-transparent text-[var(--color-ink-2)] border border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-ink-1)] hover:border-[var(--color-border)]',
        accent:
          'bg-[var(--color-accent)] text-[oklch(0.12_0.02_50)] border border-[var(--color-accent)] hover:brightness-110 active:translate-y-[0.5px]',
        danger:
          'bg-transparent text-[var(--color-bad)] border border-[var(--color-bad)] hover:bg-[oklch(0.72_0.20_25_/_0.12)]',
      },
      size: {
        default: 'h-8 px-3',
        sm: 'h-7 px-2 text-[11px]',
        icon: 'h-8 w-8',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />
    );
  },
);
Button.displayName = 'Button';

export { buttonVariants };
