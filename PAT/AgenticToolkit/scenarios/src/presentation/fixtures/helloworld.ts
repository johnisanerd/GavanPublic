/**
 * Hello-world packet — covers every layout in the v0 library at
 * least once, so the dev preview at `/_dev/deck` exercises the full
 * compileVisual surface. Used as a smoke test, not a real demo.
 *
 * Add a slide here whenever you add a layout — the dev preview
 * doubles as a coverage check.
 */
import type { PacketManifest, SlideSpec } from '../slide-spec.js';

const manifest: PacketManifest = {
  slug: '_helloworld',
  title: 'Hello world (dev)',
  audience: 'developer',
  duration_budget_s: 60,
  slide_count: 9,
};

const slides: SlideSpec[] = [
  {
    slide: 1,
    layout: 'title',
    title: 'PAT presenter — hello world',
    subtitle: 'Smoke-test packet covering every layout in the v0 library',
    duration_s: 6,
    notes: {
      spoken:
        'Welcome to the presenter smoke test. Each of the next few slides exercises one layout primitive.',
    },
  },
  {
    slide: 2,
    layout: 'section',
    label: 'Layouts',
    duration_s: 3,
    notes: { spoken: 'First, the layouts.' },
  },
  {
    slide: 3,
    layout: 'bullets',
    title: 'Bullets — default style',
    items: [
      'Markdown **bold leading** is supported for headline-style bullets',
      'Each bullet is a plain string in the YAML spec',
      'The validator caps to five items',
      'Fragment reveal is opt-in via fragment: true',
    ],
    duration_s: 12,
    notes: {
      spoken:
        "Bullets is the simplest workhorse. The validator caps items so the slide can't overflow vertically.",
    },
  },
  {
    slide: 4,
    layout: 'bullets',
    title: 'Bullets — large emphasis (callout style)',
    emphasis: 'large',
    items: [
      '**Open-weight models catching up.** Match commercial frontier on this task.',
      '**Safety training removable.** A few hours of fine-tuning is enough.',
      '**Speed mismatch.** 30-60 min/hop vs 10-day median detection.',
    ],
    duration_s: 14,
    notes: {
      spoken:
        'Large emphasis turns the bullets layout into a callouts-style slide. Same primitive, bigger type.',
    },
  },
  {
    slide: 5,
    layout: 'two-col',
    title: 'Two-col — text + figure',
    left: {
      kind: 'text',
      body: 'Two-col is the workhorse. CSS Grid, not flexbox. Replaces the v2 image-text, code-text, and callouts-N layouts with one primitive that takes typed slots.',
    },
    right: {
      kind: 'figure',
      body: '/placeholder-portrait.png',
      caption: 'pat-web placeholder asset',
    },
    duration_s: 10,
    notes: {
      spoken: 'Two-col mixes text and figure with a configurable ratio.',
    },
  },
  {
    slide: 6,
    layout: 'table',
    title: 'Table — small data',
    columns: ['Model', 'Released', 'Score'],
    rows: [
      ['Claude Opus 4', 'May 2025', '6%'],
      ['Claude Opus 4.5', 'Nov 2025', '16%'],
      ['Claude Opus 4.6', 'Feb 2026', '81%'],
      ['GPT-5', 'Aug 2025', '0%'],
      ['GPT-5.4', 'Mar 2026', '33%'],
    ],
    duration_s: 12,
    notes: {
      spoken:
        'Table renders structured data with column-cell-budget validation.',
    },
  },
  {
    slide: 7,
    layout: 'image-full',
    figure: '/placeholder-portrait.png',
    caption: 'image-full uses data-background-image, not r-stretch (which conflicts with grid layouts)',
    duration_s: 6,
    notes: {
      spoken:
        'Image-full uses data-background-image with size contain so the figure scales cleanly.',
    },
  },
  {
    slide: 8,
    layout: 'quote',
    text: 'Autonomous self-replication is no longer hypothetical.',
    attribution: 'Palisade Research',
    source: 'Language Models Can Autonomously Hack and Self-Replicate, May 2026',
    duration_s: 6,
    notes: {
      spoken:
        "Quote uses r-fit-text so high-variance quote lengths auto-scale. The paper closes with: autonomous self-replication is no longer hypothetical.",
      stage_directions: [
        {
          after: 'no longer hypothetical.',
          action: 'demo_stage_marker',
        },
      ],
    },
  },
  {
    slide: 9,
    layout: 'section',
    label: 'End',
    duration_s: 3,
    notes: { spoken: 'End of the smoke test.' },
  },
];

export const HELLOWORLD_PACKET = { manifest, slides };
