import { describe, it, expect } from 'vitest';
import {
  extractPresentationSlides,
  extractOne,
  renderPresentationSlide,
  type PresentationSlide,
} from './extract.js';

describe('extractPresentationSlides — Phase 6 reveal-HTML extractor', () => {
  it('returns empty array for empty input', () => {
    expect(extractPresentationSlides('')).toEqual([]);
    expect(extractPresentationSlides('<!doctype html><html></html>')).toEqual([]);
  });

  it('extracts a single minimal slide with no notes', () => {
    const html = '<section><h2>Hello</h2></section>';
    const out = extractPresentationSlides(html);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('hello');
    expect(out[0]!.n).toBe(1);
    expect(out[0]!.content).toBe('<h2>Hello</h2>');
    expect(out[0]!.timeline).toBe('');
    expect(out[0]!.context).toBe('');
  });

  it('extracts the speaker-notes timeline + context blocks', () => {
    const html = `<section data-id="intro">
  <h2>One Prompt. Four Machines.</h2>
  <aside class="notes">
    <timeline>
      <next_fragment/>
      <say>A single AI agent.</say>
      <next_slide/>
    </timeline>
    <context>
      Cold-open slide. Audience may interrupt about how the agent found targets.
    </context>
  </aside>
</section>`;
    const out = extractPresentationSlides(html);
    expect(out).toHaveLength(1);
    const s = out[0]!;
    expect(s.id).toBe('intro');
    expect(s.n).toBe(1);
    expect(s.content).toContain('<h2>One Prompt. Four Machines.</h2>');
    expect(s.content).not.toContain('aside');
    // Timeline retains its wrapper so consumers can parse it with
    // TagStreamParser.
    expect(s.timeline).toMatch(/^<timeline>/);
    expect(s.timeline).toMatch(/<\/timeline>$/);
    expect(s.timeline).toContain('<next_fragment/>');
    expect(s.timeline).toContain('<say>A single AI agent.</say>');
    expect(s.context).toContain('Cold-open slide');
  });

  it('extracts multiple top-level sections in document order', () => {
    const html = `
<section><h2>One</h2></section>
<section><h2>Two</h2></section>
<section><h2>Three</h2></section>`;
    const out = extractPresentationSlides(html);
    expect(out.map((s) => s.id)).toEqual(['one', 'two', 'three']);
    expect(out.map((s) => s.n)).toEqual([1, 2, 3]);
  });

  it('falls back to slide-{n} when no data-id, id, or heading exists', () => {
    const html = '<section><p>just prose, no heading</p></section>';
    const out = extractPresentationSlides(html);
    expect(out[0]!.id).toBe('slide-1');
  });

  it('prefers data-id over id over heading-slug', () => {
    expect(
      extractOne('<section data-id="dat" id="aid"><h2>Heading</h2></section>', 1)!.id,
    ).toBe('dat');
    expect(extractOne('<section id="aid"><h2>Heading</h2></section>', 1)!.id).toBe('aid');
    expect(extractOne('<section><h2>Heading</h2></section>', 1)!.id).toBe('heading');
  });

  it('ignores non-notes aside blocks', () => {
    const html = `<section>
  <h2>Main</h2>
  <aside class="footnote">a footnote</aside>
  <aside class="notes"><timeline><next_slide/></timeline></aside>
</section>`;
    const s = extractPresentationSlides(html)[0]!;
    expect(s.content).toContain('<aside class="footnote">a footnote</aside>');
    expect(s.content).not.toContain('class="notes"');
    expect(s.timeline).toContain('<next_slide/>');
  });

  it('matches class="notes" within a multi-class list', () => {
    const html = `<section>
  <aside class="notes important"><timeline><next_slide/></timeline></aside>
</section>`;
    const s = extractPresentationSlides(html)[0]!;
    expect(s.timeline).toContain('<next_slide/>');
  });

  it('handles nested (vertical) sections — outer is one slide', () => {
    const html = `
<section>
  <section><h2>v1</h2></section>
  <section><h2>v2</h2></section>
</section>`;
    const out = extractPresentationSlides(html);
    expect(out).toHaveLength(1);
    // Outer section's content includes the inner ones verbatim
    expect(out[0]!.content).toContain('<h2>v1</h2>');
    expect(out[0]!.content).toContain('<h2>v2</h2>');
  });

  it('emits warning on multiple <timeline> blocks; uses the first', () => {
    const warnings: string[] = [];
    const html = `<section>
  <aside class="notes">
    <timeline><say>first</say></timeline>
    <timeline><say>second</say></timeline>
  </aside>
</section>`;
    const s = extractPresentationSlides(html, {
      onWarning: (m) => warnings.push(m),
    })[0]!;
    expect(s.timeline).toContain('first');
    expect(s.timeline).not.toContain('second');
    expect(warnings.some((w) => w.includes('multiple <timeline>'))).toBe(true);
  });

  it('emits warning on multiple <aside class="notes"> blocks; uses the first', () => {
    const warnings: { msg: string; ctx?: { slideIndex?: number } }[] = [];
    const html = `<section>
  <aside class="notes"><timeline><say>A</say></timeline></aside>
  <aside class="notes"><timeline><say>B</say></timeline></aside>
</section>`;
    const s = extractPresentationSlides(html, {
      onWarning: (msg, ctx) => warnings.push({ msg, ctx }),
    })[0]!;
    expect(s.timeline).toContain('<say>A</say>');
    expect(warnings.some((w) => w.msg.includes('multiple <aside class="notes">'))).toBe(true);
  });

  it('skips empty self-closing <section/> with a warning', () => {
    const warnings: string[] = [];
    const html = '<section/><section><h2>real</h2></section>';
    const out = extractPresentationSlides(html, { onWarning: (m) => warnings.push(m) });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('real');
    expect(warnings.some((w) => w.includes('self-closing'))).toBe(true);
  });

  it('preserves fragment data attrs verbatim in content', () => {
    const html = `<section>
  <ul>
    <li class="fragment" data-fragment-index="0">first</li>
    <li class="fragment" data-fragment-index="1">second</li>
  </ul>
</section>`;
    const s = extractPresentationSlides(html)[0]!;
    expect(s.content).toContain('class="fragment"');
    expect(s.content).toContain('data-fragment-index="0"');
    expect(s.content).toContain('data-fragment-index="1"');
  });
});

describe('renderPresentationSlide — XML serialization for system prompt', () => {
  it('emits the full envelope when all three blocks are present', () => {
    const slide: PresentationSlide = {
      id: 'intro',
      n: 1,
      content: '<h2>Hello</h2>',
      timeline: '<timeline><next_slide/></timeline>',
      context: 'Cold open.',
    };
    const out = renderPresentationSlide(slide);
    expect(out).toContain('<presentation_slide id="intro" n="1">');
    expect(out).toContain('<content>');
    expect(out).toContain('<h2>Hello</h2>');
    expect(out).toContain('<timeline>');
    expect(out).toContain('<next_slide/>');
    expect(out).toContain('<context>');
    expect(out).toContain('Cold open.');
    expect(out).toContain('</presentation_slide>');
  });

  it('omits timeline + context blocks when empty', () => {
    const slide: PresentationSlide = {
      id: 'minimal',
      n: 2,
      content: '<p>text</p>',
      timeline: '',
      context: '',
    };
    const out = renderPresentationSlide(slide);
    expect(out).not.toContain('<timeline>');
    expect(out).not.toContain('<context>');
    expect(out).toContain('<content>');
  });
});
