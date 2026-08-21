import { HTMLAttributes } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padding?: "sm" | "md" | "lg";
  elevated?: boolean;
}

const paddings = {
  sm: "py-4 pl-7 pr-5",
  md: "py-6 pl-11 pr-6",
  lg: "py-8 pl-11 pr-6",
};

export function Card({ padding = "md", elevated = false, className = "", children, ...props }: CardProps) {
  return (
    <div
      className={`bg-surface-bright ${elevated ? "shadow-ambient" : "ghost-border"} ${paddings[padding]} ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}
