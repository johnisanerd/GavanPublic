// Structured JSON logging. One emit -> one JSON line on stdout.
// Wire format (see global AGENTS.md): ts, source, kind, level, data + context.
// On Vercel the filesystem is ephemeral, so we emit to stdout only here and
// rely on a log drain for durable persistence (a later concern).

const SOURCE = "the-test-web";

type Level = "info" | "warn" | "error" | "fatal";

interface EventInput {
  kind: string; // "<area>.<event>", past-tense verb
  data?: Record<string, unknown>;
  level?: Level;
  // promoted context fields
  token?: string; // typeform submission id
  event_id?: string; // typeform event id
  prolific_session_id?: string;
}

export function event({
  kind,
  data = {},
  level = "info",
  ...context
}: EventInput): void {
  const line = {
    ts: new Date().toISOString(),
    source: SOURCE,
    kind,
    level,
    ...context,
    data,
  };
  const out = JSON.stringify(line);
  if (level === "error" || level === "fatal") console.error(out);
  else console.log(out);
}

export const log = { event };
