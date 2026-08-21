import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format an ISO timestamp as local HH:MM:SS. */
export function fmtTime(iso: string | undefined | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString([], { hour12: false });
  } catch {
    return iso.slice(11, 19);
  }
}

/** Truncate a long string with an ellipsis. */
export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
