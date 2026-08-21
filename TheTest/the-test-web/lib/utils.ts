import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// shadcn class merge helper: conditional classNames (clsx) deduped against
// Tailwind conflicts (tailwind-merge). Used by every shadcn/ui component.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
