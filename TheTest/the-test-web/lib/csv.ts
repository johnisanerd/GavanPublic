// Minimal, dependency-free CSV serialization for the admin export routes.
// Fields containing commas, double-quotes, or newlines are wrapped in double
// quotes with internal quotes doubled (RFC 4180). Transcripts routinely
// contain all three, so every value goes through escapeCsv.

export function escapeCsv(value: unknown): string {
  if (value == null) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Build a CSV body from a header row + data rows. Rows are escaped per-cell;
// lines are CRLF-terminated for spreadsheet compatibility.
export function toCsv(header: string[], rows: unknown[][]): string {
  const lines = [header, ...rows].map((row) => row.map(escapeCsv).join(","));
  // Trailing newline keeps tools like `wc -l` honest.
  return lines.join("\r\n") + "\r\n";
}

// Filenames: slug-safe, lowercased, collapse runs of non-alphanumerics to "-".
export function fileSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "untitled";
}
