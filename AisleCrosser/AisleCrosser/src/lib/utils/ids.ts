import { nanoid } from "nanoid";

export function generateId(prefix?: string): string {
  const id = nanoid(12);
  return prefix ? `${prefix}_${id}` : id;
}
