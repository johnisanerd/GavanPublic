"use client";

import { ButtonHTMLAttributes, forwardRef } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "tertiary" | "danger";
  size?: "sm" | "md" | "lg";
}

const variants = {
  primary: "bg-navy text-white hover:bg-navy-light active:bg-navy transition-tonal",
  secondary: "text-gold hover:bg-gold/10 active:bg-gold/15 transition-tonal",
  tertiary: "text-ink-light underline underline-offset-4 decoration-gold/40 hover:text-ink hover:decoration-gold transition-tonal",
  danger: "bg-crimson text-white hover:bg-crimson/90 active:bg-crimson/80 transition-tonal",
};

const sizes = {
  sm: "px-4 py-2 text-sm min-h-[36px]",
  md: "px-6 py-3 text-base min-h-[48px]",
  lg: "px-8 py-4 text-lg min-h-[56px]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", className = "", disabled, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={`
          inline-flex items-center justify-center font-semibold
          focus:outline-none focus:ring-2 focus:ring-gold/50 focus:ring-offset-2 focus:ring-offset-surface
          disabled:opacity-40 disabled:cursor-not-allowed
          ${variants[variant]} ${sizes[size]} ${className}
        `}
        disabled={disabled}
        {...props}
      />
    );
  }
);

Button.displayName = "Button";
