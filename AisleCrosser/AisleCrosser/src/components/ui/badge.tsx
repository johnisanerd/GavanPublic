interface BadgeProps {
  variant?: "default" | "blue" | "red" | "green" | "gold" | "purple" | "navy";
  size?: "sm" | "md";
  children: React.ReactNode;
  className?: string;
}

const variants = {
  default: "bg-surface-mid text-ink-muted",
  blue: "bg-dem-bg text-dem-blue",
  red: "bg-rep-bg text-rep-red",
  green: "bg-emerald-50 text-emerald-800",
  gold: "bg-gold/10 text-gold-dim",
  purple: "bg-ind-bg text-ind-purple",
  navy: "bg-navy/10 text-navy",
};

const sizes = {
  sm: "px-2.5 py-0.5 text-xs",
  md: "px-3 py-1 text-sm",
};

export function Badge({ variant = "default", size = "sm", children, className = "" }: BadgeProps) {
  return (
    <span className={`inline-flex items-center font-semibold tracking-wide ${variants[variant]} ${sizes[size]} ${className}`}>
      {children}
    </span>
  );
}
