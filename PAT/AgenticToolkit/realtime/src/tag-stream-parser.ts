/**
 * PAT: hand-rolled streaming XML tag parser for the presenter
 * tag-stream architecture (`plans/presenter-tag-stream.md`).
 *
 * Vocabulary (~14 tags) is small enough that a custom state machine is
 * simpler than wrapping htmlparser2. Default contract: anything outside
 * a tag is spoken prose. Unknown tags are passed through verbatim as
 * prose with a warning event so we don't silently drop content.
 *
 * Streaming contract:
 *   - `push(chunk)` accepts a substring of the back-mind's output and
 *     emits zero or more events. Chunks may split in the middle of a
 *     tag — the parser buffers across boundaries.
 *   - `end()` flushes any trailing text or unclosed-tag warning.
 *
 * Events emitted:
 *   - `text` — prose between tags. Multiple `text` events may
 *     accumulate; consumers decide whether to coalesce.
 *   - `open` — open tag with attributes (e.g. `<emotion value="calm">`).
 *   - `close` — close tag (`</emotion>`).
 *   - `selfClose` — self-closing tag (e.g. `<slide_next/>` or
 *     `<verbatim a="opening"/>`).
 *   - `warning` — malformed or unknown tag with diagnostic info.
 *
 * Not exhaustively spec-compliant XML — this is a domain parser. It
 * accepts attribute values quoted single, double, or unquoted up to a
 * space or `/`. Attribute names match `[A-Za-z_][A-Za-z0-9_-]*`.
 */

export type TagEvent =
  | { kind: 'text'; text: string }
  | { kind: 'open'; tag: string; attrs: Record<string, string | number | boolean> }
  | { kind: 'close'; tag: string }
  | { kind: 'selfClose'; tag: string; attrs: Record<string, string | number | boolean> }
  | { kind: 'warning'; reason: string; partial: string };

type Mode = 'TEXT' | 'IN_TAG';

const ATTR_NUMERIC_RE = /^-?\d+(\.\d+)?$/;

/** Coerce an attribute string into number / bool / string per the
 *  plan's rule: numeric → number, `true|false` → bool, else string. */
function coerceAttrValue(raw: string): string | number | boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (ATTR_NUMERIC_RE.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return raw;
}

/** Parse the inside of a tag (everything between `<` and `>`,
 *  exclusive). Returns the tag name, attrs, and whether it's
 *  self-closing or a close tag. Returns null on malformed input —
 *  caller emits a warning. */
function parseTagBody(body: string): {
  tag: string;
  attrs: Record<string, string | number | boolean>;
  closing: boolean;
  selfClosing: boolean;
} | null {
  let s = body.trim();
  if (s.length === 0) return null;
  let closing = false;
  let selfClosing = false;
  if (s.startsWith('/')) {
    closing = true;
    s = s.slice(1).trim();
  }
  if (s.endsWith('/')) {
    selfClosing = true;
    s = s.slice(0, -1).trim();
  }
  // Tag name — first chunk up to whitespace.
  const nameMatch = /^([A-Za-z_][A-Za-z0-9_:.-]*)/.exec(s);
  if (!nameMatch) return null;
  const tag = nameMatch[1]!;
  let rest = s.slice(tag.length).trim();
  const attrs: Record<string, string | number | boolean> = {};
  while (rest.length > 0) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s/>]+)))?/.exec(rest);
    if (!m) break;
    const key = m[1]!;
    const value = m[3] ?? m[4] ?? m[5] ?? 'true';
    attrs[key] = coerceAttrValue(value);
    rest = rest.slice(m[0].length).trim();
  }
  return { tag, attrs, closing, selfClosing };
}

export class TagStreamParser {
  private mode: Mode = 'TEXT';
  /** Buffer of the current text run (TEXT mode) or in-flight tag body
   *  excluding the leading `<` (IN_TAG mode). */
  private buf = '';
  private out: TagEvent[] = [];
  /** Stack for paired tag tracking — emits warning on unclosed at end(). */
  private openStack: string[] = [];

  /** Append a chunk and return any events produced. Buffers any text
   *  not yet flushed (the parser eagerly emits text once it sees a
   *  `<` boundary, but a trailing text run waits until end() or the
   *  next tag). */
  push(chunk: string): TagEvent[] {
    const drained: TagEvent[] = [];
    let i = 0;
    while (i < chunk.length) {
      const ch = chunk[i]!;
      if (this.mode === 'TEXT') {
        if (ch === '<') {
          if (this.buf.length > 0) {
            drained.push({ kind: 'text', text: this.buf });
            this.buf = '';
          }
          this.mode = 'IN_TAG';
        } else {
          this.buf += ch;
        }
      } else {
        if (ch === '>') {
          const body = this.buf;
          this.buf = '';
          this.mode = 'TEXT';
          const parsed = parseTagBody(body);
          if (!parsed) {
            drained.push({
              kind: 'warning',
              reason: 'malformed-tag',
              partial: `<${body}>`,
            });
            // Treat the raw text as prose so we don't drop content.
            drained.push({ kind: 'text', text: `<${body}>` });
          } else if (parsed.selfClosing) {
            drained.push({ kind: 'selfClose', tag: parsed.tag, attrs: parsed.attrs });
          } else if (parsed.closing) {
            drained.push({ kind: 'close', tag: parsed.tag });
            const top = this.openStack[this.openStack.length - 1];
            if (top === parsed.tag) this.openStack.pop();
          } else {
            drained.push({ kind: 'open', tag: parsed.tag, attrs: parsed.attrs });
            this.openStack.push(parsed.tag);
          }
        } else {
          this.buf += ch;
        }
      }
      i++;
    }
    // Flush any complete text run that's safe to emit. We hold the
    // text buffer until a `<` arrives or end() runs so consumers see
    // contiguous prose; finer-grained streaming is the consumer's job.
    if (this.mode === 'TEXT' && this.buf.length > 0 && drained.length > 0) {
      // If we already emitted some events this push (a tag boundary
      // ran), drain the text accumulated since the boundary so the
      // consumer can interleave.
      drained.push({ kind: 'text', text: this.buf });
      this.buf = '';
    }
    this.out.push(...drained);
    return drained;
  }

  /** Flush any trailing text and emit warnings for unclosed tags.
   *  Returns the final events. After end(), the parser is consumed. */
  end(): TagEvent[] {
    const tail: TagEvent[] = [];
    if (this.mode === 'IN_TAG' && this.buf.length > 0) {
      tail.push({
        kind: 'warning',
        reason: 'unclosed-tag',
        partial: `<${this.buf}`,
      });
      // Treat the unclosed text as prose.
      tail.push({ kind: 'text', text: `<${this.buf}` });
      this.buf = '';
      this.mode = 'TEXT';
    } else if (this.buf.length > 0) {
      tail.push({ kind: 'text', text: this.buf });
      this.buf = '';
    }
    if (this.openStack.length > 0) {
      tail.push({
        kind: 'warning',
        reason: 'unclosed-open-tags',
        partial: this.openStack.join(','),
      });
      this.openStack = [];
    }
    this.out.push(...tail);
    return tail;
  }

  /** All events emitted so far. */
  events(): TagEvent[] {
    return this.out.slice();
  }
}

/** Convenience: parse a complete string in one shot. */
export function parseTagStream(text: string): TagEvent[] {
  const p = new TagStreamParser();
  p.push(text);
  p.end();
  return p.events();
}
