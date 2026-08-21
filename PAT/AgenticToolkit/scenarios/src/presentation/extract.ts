/**
 * Reveal-HTML → PresentationSlide extractor (Phase 6).
 *
 * Authors write presentations as reveal.js HTML — one `<section>` per
 * slide, with optional `<aside class="notes">` carrying speaker notes.
 * For PAT, the speaker notes are structured: a `<timeline>` block (the
 * authored action sequence) and a `<context>` block (free-form prose
 * the back-mind reads for off-script Q&A).
 *
 * This module pulls the three things apart so downstream consumers see
 * a clean shape:
 *
 *   - `content` — visible slide HTML (everything except the aside)
 *   - `timeline` — raw `<timeline>...</timeline>` text from the notes
 *   - `context` — free-form prose from `<context>...</context>`
 *
 * The output drops into the agent's system prompt as `<presentation_slide
 * id n><content/><timeline/><context/></presentation_slide>`. The
 * extractor stays read-only on the source HTML — it does NOT mutate or
 * re-emit slide content. Fragment indices, alt-text, layout all
 * round-trip exactly as authored.
 *
 * Parser approach: small purpose-built state machine over the constrained
 * input shape. No external HTML library. The shape we accept:
 *
 *   <section> ... <aside class="notes"> ... </aside> ... </section>
 *
 * Edge cases handled:
 *   - Multiple aside blocks: we take only `class="notes"`
 *   - Section with no aside: timeline/context empty
 *   - Self-closing `<section/>`: skipped (empty slide)
 *   - Vertical sub-sections (reveal.js nested `<section>` for v-stacks):
 *     treated as a single slide group — we extract from the OUTER section
 *     only; the inner sections come through as part of `content`. Phase
 *     6 doesn't differentiate v-stacks yet; future work.
 *
 * Anything that doesn't fit the shape is preserved verbatim in `content`
 * with a warning emitted via the optional `onWarning` callback.
 */

export interface PresentationSlide {
  /** `data-id` attribute on the `<section>` element, or a slug generated
   *  from the first heading / `<h1-3>` text. Falls back to `slide-{n}`
   *  when nothing matches. */
  id: string;
  /** 1-indexed slide ordinal. */
  n: number;
  /** Visible slide HTML — everything inside `<section>` except the
   *  `<aside class="notes">` block. Preserved verbatim (no rewrites). */
  content: string;
  /** Raw `<timeline>...</timeline>` text from the notes, INCLUDING the
   *  wrapper tags so consumers can parse it with the same TagStreamParser
   *  that handles agent emissions. Empty string when the slide has no
   *  authored timeline. */
  timeline: string;
  /** Free-form prose from `<context>...</context>`. Markdown / plain
   *  text — no parsing. Empty string when absent. */
  context: string;
}

export interface ExtractOptions {
  /** Called when the extractor encounters input that doesn't fit the
   *  expected shape (e.g. unclosed aside, multiple `<timeline>` blocks).
   *  Optional — silent by default. Forensic-only; extraction continues. */
  onWarning?: (msg: string, ctx?: { slideIndex?: number }) => void;
}

/** Extract one presentation_slide per top-level `<section>` in the
 *  reveal HTML input. Returns slides in document order with 1-indexed
 *  `n`. Empty input or no `<section>` blocks → empty array. */
export function extractPresentationSlides(
  html: string,
  opts?: ExtractOptions,
): PresentationSlide[] {
  const sections = splitTopLevelSections(html, opts);
  const out: PresentationSlide[] = [];
  for (let i = 0; i < sections.length; i++) {
    const raw = sections[i]!;
    const slide = extractOne(raw, i + 1, opts);
    if (slide) out.push(slide);
  }
  return out;
}

/** Single-slide extractor — exposed for unit-testing the inner logic. */
export function extractOne(
  sectionHtml: string,
  n: number,
  opts?: ExtractOptions,
): PresentationSlide | null {
  // Strip the outer <section ...>...</section> wrapper, keeping the
  // section's attributes for id resolution.
  const sectionMatch = /^<section([^>]*)>([\s\S]*)<\/section>$/i.exec(sectionHtml.trim());
  if (!sectionMatch) {
    opts?.onWarning?.('section did not match expected shape', { slideIndex: n });
    return null;
  }
  const sectionAttrs = sectionMatch[1] ?? '';
  const inner = sectionMatch[2] ?? '';

  // Find the <aside class="notes">...</aside> block. There may be other
  // asides (e.g. class="footnote") which we leave in `content`.
  const aside = findNotesAside(inner, opts, n);

  // `content` = inner with the notes-aside removed; otherwise inner.
  const content = aside ? inner.replace(aside.raw, '').trim() : inner.trim();

  // Pull timeline + context out of the aside body.
  const timeline = aside ? extractBlock(aside.body, 'timeline', opts, n, true) : '';
  const context = aside ? extractBlock(aside.body, 'context', opts, n, false).trim() : '';

  const id = resolveId(sectionAttrs, content, n);
  return { id, n, content, timeline, context };
}

/* ────────────────────────── helpers ────────────────────────── */

/** Split a reveal HTML string into top-level <section>...</section>
 *  chunks. Handles nested sections (reveal.js vertical groups) by
 *  bracket-balancing — only outer sections become slides. HTML
 *  comments (`<!-- ... -->`) are stripped first so example tags inside
 *  comments (e.g. `<!-- <section> ... -->`) don't confuse the depth
 *  counter. */
function splitTopLevelSections(html: string, opts?: ExtractOptions): string[] {
  const sections: string[] = [];
  // Strip HTML comments first. They can legitimately contain literal
  // section/aside/timeline tags as documentation; counting them would
  // unbalance the depth tracker.
  const stripped = html.replace(/<!--[\s\S]*?-->/g, '');
  // Token-level scan: walk the string, track <section> open/close depth.
  // We treat self-closing <section/> as an empty open+close pair.
  const re = /<section\b[^>]*\/?>|<\/section\s*>/gi;
  let m: RegExpExecArray | null;
  let depth = 0;
  let startIdx = -1;
  while ((m = re.exec(stripped))) {
    const tok = m[0];
    if (tok.endsWith('/>')) {
      // Self-closing: skip as empty section.
      if (depth === 0) {
        opts?.onWarning?.('self-closing <section/> skipped');
      }
      continue;
    }
    if (!tok.startsWith('</')) {
      if (depth === 0) startIdx = m.index;
      depth += 1;
    } else {
      depth -= 1;
      if (depth === 0 && startIdx >= 0) {
        const end = m.index + tok.length;
        sections.push(stripped.slice(startIdx, end));
        startIdx = -1;
      } else if (depth < 0) {
        opts?.onWarning?.('unbalanced </section> in input');
        depth = 0;
      }
    }
  }
  if (depth > 0) opts?.onWarning?.('unclosed <section> at end of input');
  return sections;
}

/** Find a `<aside class="notes">...</aside>` block at the top level of
 *  a section's inner HTML. Returns the matched raw text + body. Null
 *  if no notes-aside exists. */
function findNotesAside(
  inner: string,
  opts: ExtractOptions | undefined,
  slideIndex: number,
): { raw: string; body: string } | null {
  // Look for any <aside ...>; check its attributes for class="notes".
  const re = /<aside\b([^>]*)>([\s\S]*?)<\/aside\s*>/gi;
  let m: RegExpExecArray | null;
  let found: { raw: string; body: string } | null = null;
  while ((m = re.exec(inner))) {
    const attrs = m[1] ?? '';
    if (/class\s*=\s*(?:"|')notes(?:"|')/i.test(attrs) || /class\s*=\s*(?:"|')[^"']*\bnotes\b[^"']*(?:"|')/i.test(attrs)) {
      if (found) {
        opts?.onWarning?.('multiple <aside class="notes"> blocks; using the first', {
          slideIndex,
        });
        break;
      }
      found = { raw: m[0], body: m[2] ?? '' };
    }
  }
  return found;
}

/** Extract a tagged block (`<timeline>` or `<context>`) from an aside
 *  body. When `keepWrapper=true`, returns the FULL `<tag>...</tag>`
 *  text (used for `timeline` — consumers parse it with TagStreamParser).
 *  When false, returns just the inner content (used for `context`). */
function extractBlock(
  asideBody: string,
  tag: 'timeline' | 'context',
  opts: ExtractOptions | undefined,
  slideIndex: number,
  keepWrapper: boolean,
): string {
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}\\s*>`, 'i');
  const m = re.exec(asideBody);
  if (!m) return '';
  // Duplicate-block warning — pick the first.
  const second = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi');
  let count = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  while (second.exec(asideBody)) count += 1;
  if (count > 1) {
    opts?.onWarning?.(`multiple <${tag}> blocks; using the first`, { slideIndex });
  }
  return keepWrapper ? m[0] : m[2]!;
}

/** Resolve a slide's id. Preference order:
 *   1. `data-id="..."` on the <section> attrs
 *   2. `id="..."` on the <section> attrs
 *   3. slugified text of the first <h1|h2|h3> in content
 *   4. `slide-{n}` fallback */
function resolveId(sectionAttrs: string, content: string, n: number): string {
  const dataIdMatch = /data-id\s*=\s*("|')([^"']+)\1/i.exec(sectionAttrs);
  if (dataIdMatch) return dataIdMatch[2]!.trim();
  const idMatch = /\bid\s*=\s*("|')([^"']+)\1/i.exec(sectionAttrs);
  if (idMatch) return idMatch[2]!.trim();
  const headingMatch = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]\s*>/i.exec(content);
  if (headingMatch) {
    const text = headingMatch[1]!.replace(/<[^>]*>/g, '').trim();
    if (text.length > 0) return slugify(text);
  }
  return `slide-${n}`;
}

/** Lowercase + non-alphanumerics → '-'. Trims leading/trailing dashes. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Render a `PresentationSlide` as the `<presentation_slide>` XML that
 *  rides in the agent's system prompt. Pure formatting — no escaping
 *  of `content` (assumed to already be valid HTML/XML the model can
 *  read as-is). */
export function renderPresentationSlide(slide: PresentationSlide): string {
  const parts = [`<presentation_slide id="${slide.id}" n="${slide.n}">`];
  parts.push(`  <content>\n${indent(slide.content, 4)}\n  </content>`);
  if (slide.timeline) parts.push(`  ${slide.timeline.split('\n').join('\n  ')}`);
  if (slide.context) parts.push(`  <context>\n${indent(slide.context, 4)}\n  </context>`);
  parts.push(`</presentation_slide>`);
  return parts.join('\n');
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? pad + line : line))
    .join('\n');
}
