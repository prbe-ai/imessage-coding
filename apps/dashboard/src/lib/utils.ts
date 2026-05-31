import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { formatDistanceToNow } from "date-fns";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Parse a timestamp from the API, ensuring it's treated as UTC when the
 *  offset is missing (Postgres timestamptz serialized without a trailing Z). */
function parseUTC(dateStr: string): Date {
  const s = dateStr.trim();
  if (/Z$/i.test(s) || /[+-]\d{2}:\d{2}$/.test(s)) return new Date(s);
  return new Date(s + "Z");
}

export function formatRelativeTime(dateStr: string): string {
  return formatDistanceToNow(parseUTC(dateStr), { addSuffix: true });
}

/** Extract a human-facing message from a fetch/JSON error. */
export function extractError(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
