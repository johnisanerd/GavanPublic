/**
 * Fuzz packet — deliberately edge-case content to surface visual
 * regressions in the layout components. Reached at `/_dev/fuzz`.
 *
 * Each slide isolates one or two stress dimensions. Validator will
 * reject some specs intentionally to verify the rejection path; those
 * are tagged in the spoken notes.
 */
import type { PacketManifest, SlideSpec } from '../slide-spec.js';

const manifest: PacketManifest = {
  slug: '_fuzz',
  title: 'Layout fuzz test',
  audience: 'developer',
  duration_budget_s: 600,
  slide_count: 26,
};

// Build a long-but-under-cap title — 59 chars (cap is 60)
const NEAR_CAP_TITLE = 'A title that runs right up to the validator limit at sixty';
// Just-at-cap (60)
// const AT_CAP_TITLE = "Sixty characters exactly so the validator should still pass.";
// 200-char paragraph (two-col text cap)
const LONG_PARA =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi.';

const slides: SlideSpec[] = [
  // 1 — short title, no subtitle, no background
  {
    slide: 1,
    layout: 'title',
    title: 'Hi',
    notes: { spoken: 'Two-character title — does r-fit-text scale up?' },
  },
  // 2 — near-cap title + long subtitle
  {
    slide: 2,
    layout: 'title',
    title: NEAR_CAP_TITLE,
    subtitle:
      'A subtitle of moderate length that takes nearly the full 100-character cap to see how the fit-text+regular flow handle competing scale demands',
    notes: { spoken: 'Near-cap title plus long subtitle.' },
  },
  // 3 — title with special chars + em-dash + smart quotes
  {
    slide: 3,
    layout: 'title',
    title: '"It’s 2026 — what now?"',
    subtitle: 'Smart quotes, apostrophe, em-dash, and a question mark',
    notes: { spoken: 'Punctuation soup in title.' },
  },
  // 4 — title with background color
  {
    slide: 4,
    layout: 'title',
    title: 'Dark background',
    subtitle: 'background.color sets the slide bg',
    background: { color: '#0c1726' },
    notes: { spoken: 'Background color set.' },
  },
  // 5 — section divider, short
  {
    slide: 5,
    layout: 'section',
    label: 'Bullets',
    notes: { spoken: 'Section transition.' },
  },
  // 6 — section divider near cap (40 chars)
  {
    slide: 6,
    layout: 'section',
    label: 'A long section label hits forty exactly',
    notes: { spoken: 'Near-cap section label.' },
  },
  // 7 — bullets: 1 bullet only (under-min)
  {
    slide: 7,
    layout: 'bullets',
    title: 'Single bullet',
    items: ['Just one item to make sure the list still renders with grace'],
    notes: { spoken: 'One-bullet edge.' },
  },
  // 8 — bullets: 5 items max, max-length each (80 chars)
  {
    slide: 8,
    layout: 'bullets',
    title: 'Max capacity',
    items: [
      'Bullet one sized to roughly eighty characters to test wrap at the cap-near edge here',
      'Bullet two sized to roughly eighty characters to test wrap at the cap-near edge here',
      'Bullet three sized to roughly eighty characters to test wrap at the cap-near edge h',
      'Bullet four sized to roughly eighty characters to test wrap at the cap-near edge he',
      'Bullet five sized to roughly eighty characters to test wrap at the cap-near edge h',
    ],
    notes: { spoken: 'Five-bullet max-density slide.' },
  },
  // 9 — bullets: bold-leading markdown pattern
  {
    slide: 9,
    layout: 'bullets',
    title: 'Bold leading',
    emphasis: 'large',
    items: [
      '**One.** First headline plus body text under the bold lead',
      '**Two.** Second headline plus body text under the bold lead',
      '**Three.** Third headline plus body text under the bold lead',
    ],
    notes: { spoken: 'Bold-leading markdown variant.' },
  },
  // 10 — bullets with fragment reveal
  {
    slide: 10,
    layout: 'bullets',
    title: 'Fragment reveal',
    fragment: true,
    items: [
      'First fragment',
      'Second fragment',
      'Third fragment',
    ],
    notes: { spoken: 'Fragment-reveal mode.' },
  },
  // 11 — two-col: text + text equal
  {
    slide: 11,
    layout: 'two-col',
    title: 'Text vs text',
    left: { kind: 'text', body: LONG_PARA },
    right: { kind: 'text', body: LONG_PARA },
    notes: { spoken: 'Two text blocks at cap.' },
  },
  // 12 — two-col: list + list
  {
    slide: 12,
    layout: 'two-col',
    title: 'List vs list',
    left: {
      kind: 'list',
      body: ['Alpha one short', 'Beta two', 'Gamma three a bit longer', 'Delta'],
    },
    right: {
      kind: 'list',
      body: ['Echo', 'Foxtrot', 'Golf', 'Hotel'],
    },
    notes: { spoken: 'Two lists side by side.' },
  },
  // 13 — two-col: text + figure, 3fr 2fr ratio
  {
    slide: 13,
    layout: 'two-col',
    title: 'Text + figure (3:2 ratio)',
    ratio: '3fr 2fr',
    left: { kind: 'text', body: LONG_PARA },
    right: {
      kind: 'figure',
      body: '/placeholder-portrait.png',
      caption: 'Caption length is at the eighty-character cap for figure caption slots here',
    },
    notes: { spoken: 'Asymmetric ratio.' },
  },
  // 14 — two-col: figure + figure
  {
    slide: 14,
    layout: 'two-col',
    title: 'Figure + figure',
    left: { kind: 'figure', body: '/placeholder-portrait.png', caption: 'Left' },
    right: { kind: 'figure', body: '/placeholder-portrait.png', caption: 'Right' },
    notes: { spoken: 'Two figures.' },
  },
  // 15 — two-col: code + text
  {
    slide: 15,
    layout: 'two-col',
    title: 'Code + text',
    left: {
      kind: 'code',
      language: 'ts',
      body: 'export function compileVisual(spec: SlideSpec) {\n  switch (spec.layout) {\n    case "title": return <Title spec={spec} />;\n    case "bullets": return <Bullets spec={spec} />;\n  }\n}',
    },
    right: {
      kind: 'text',
      body: 'compileVisual dispatches a typed SlideSpec to its React layout component. The single compile entrypoint pat-web uses.',
    },
    notes: { spoken: 'Code beside prose.' },
  },
  // 16 — two-col: multi-paragraph text
  {
    slide: 16,
    layout: 'two-col',
    title: 'Paragraph breaks',
    left: {
      kind: 'text',
      body: 'First paragraph short.\n\nSecond paragraph a touch longer with some real content in it.\n\nThird.',
    },
    right: {
      kind: 'list',
      body: ['One', 'Two', 'Three'],
    },
    notes: { spoken: 'Multi-paragraph text vs short list.' },
  },
  // 17 — image-full with caption
  {
    slide: 17,
    layout: 'image-full',
    figure: '/placeholder-portrait.png',
    caption: 'Full-bleed image via data-background-image, caption overlay at the bottom',
    notes: { spoken: 'Image-full standard case.' },
  },
  // 18 — image-full without caption
  {
    slide: 18,
    layout: 'image-full',
    figure: '/placeholder-portrait.png',
    notes: { spoken: 'Image-full no caption.' },
  },
  // 19 — image-full pointing at missing image (graceful?)
  {
    slide: 19,
    layout: 'image-full',
    figure: '/missing-figure-that-does-not-exist.png',
    caption: 'Missing figure — does the slide still render the caption?',
    notes: { spoken: 'Broken image path.' },
  },
  // 20 — quote: short
  {
    slide: 20,
    layout: 'quote',
    text: 'Move fast.',
    attribution: 'Anonymous',
    notes: { spoken: 'Two-word quote — does fit-text scale up?' },
  },
  // 21 — quote: max length
  {
    slide: 21,
    layout: 'quote',
    text: 'A quote pushed right up against the two-hundred-character cap to confirm that r-fit-text does the right thing with high-variance content lengths in the canonical quote slot of the deck.',
    attribution: 'A long-form attribution string',
    source: 'Source: A book with a longish title and a publisher',
    notes: { spoken: 'Max-length quote.' },
  },
  // 22 — quote: only text, no attribution
  {
    slide: 22,
    layout: 'quote',
    text: 'No attribution, no source — just a bare quote.',
    notes: { spoken: 'Bare quote.' },
  },
  // 23 — table: small 2x2
  {
    slide: 23,
    layout: 'table',
    title: 'Small table',
    columns: ['Key', 'Value'],
    rows: [
      ['Alpha', '1'],
      ['Beta', '2'],
    ],
    notes: { spoken: 'Small table.' },
  },
  // 24 — table: max cap (6 cols x 8 rows, 40-char cells)
  {
    slide: 24,
    layout: 'table',
    title: 'Big table at cap',
    columns: ['Col A', 'Col B', 'Col C', 'Col D', 'Col E', 'Col F'],
    rows: Array.from({ length: 8 }).map((_, r) =>
      Array.from({ length: 6 }).map((_, c) => `r${r}c${c} fortyish chars of content here`),
    ),
    notes: { spoken: 'Max-density table.' },
  },
  // 25 — auto-animate from previous title slide
  {
    slide: 25,
    layout: 'title',
    title: 'Animated entrance',
    subtitle: 'auto_animate_from links this to the next slide',
    auto_animate_from: 'prev',
    notes: { spoken: 'Auto-animate target.' },
  },
  // ─── 26-35: image aspect ratios ─────────────────────────────────
  // image-full for each test aspect
  {
    slide: 26,
    layout: 'image-full',
    figure: '/fuzz-square.svg',
    caption: 'image-full · square (1:1)',
    notes: { spoken: 'Square in image-full.' },
  },
  {
    slide: 27,
    layout: 'image-full',
    figure: '/fuzz-landscape.svg',
    caption: 'image-full · landscape 16:9',
    notes: { spoken: 'Landscape in image-full.' },
  },
  {
    slide: 28,
    layout: 'image-full',
    figure: '/fuzz-wide.svg',
    caption: 'image-full · ultra-wide 4:1',
    notes: { spoken: 'Ultra-wide in image-full.' },
  },
  {
    slide: 29,
    layout: 'image-full',
    figure: '/fuzz-portrait.svg',
    caption: 'image-full · portrait 3:5',
    notes: { spoken: 'Portrait in image-full.' },
  },
  {
    slide: 30,
    layout: 'image-full',
    figure: '/fuzz-tall.svg',
    caption: 'image-full · very tall 1:4',
    notes: { spoken: 'Very tall in image-full.' },
  },
  // two-col text + figure for each test aspect
  {
    slide: 31,
    layout: 'two-col',
    title: 'Two-col · square figure',
    left: { kind: 'text', body: 'Square image in the right slot. Does the figure dominate or sit cleanly?' },
    right: { kind: 'figure', body: '/fuzz-square.svg', caption: '1:1' },
    notes: { spoken: 'Square in two-col.' },
  },
  {
    slide: 32,
    layout: 'two-col',
    title: 'Two-col · landscape',
    left: { kind: 'text', body: 'Landscape 16:9 in right slot. Common case.' },
    right: { kind: 'figure', body: '/fuzz-landscape.svg', caption: '16:9' },
    notes: { spoken: 'Landscape in two-col.' },
  },
  {
    slide: 33,
    layout: 'two-col',
    title: 'Two-col · ultra-wide figure',
    left: { kind: 'text', body: 'A 4:1 image in a column-shaped slot is a stress test — the height should collapse.' },
    right: { kind: 'figure', body: '/fuzz-wide.svg', caption: '4:1 — should be short' },
    notes: { spoken: 'Ultra-wide in two-col.' },
  },
  {
    slide: 34,
    layout: 'two-col',
    title: 'Two-col · portrait figure',
    left: { kind: 'text', body: 'Portrait image in a column. Should respect the max-height cap.' },
    right: { kind: 'figure', body: '/fuzz-portrait.svg', caption: '3:5' },
    notes: { spoken: 'Portrait in two-col.' },
  },
  {
    slide: 35,
    layout: 'two-col',
    title: 'Two-col · very tall figure',
    left: { kind: 'text', body: 'A 1:4 image stress-tests max-height. Should clamp, not push the slide off-screen.' },
    right: { kind: 'figure', body: '/fuzz-tall.svg', caption: '1:4 — should clamp' },
    notes: { spoken: 'Very tall in two-col.' },
  },
  // end
  {
    slide: 36,
    layout: 'section',
    label: 'Fuzz done',
    notes: { spoken: 'End.' },
  },
];

export const FUZZ_PACKET = { manifest, slides };
