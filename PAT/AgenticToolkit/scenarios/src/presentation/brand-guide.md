# Palisade Research — Brand Guide Summary

Distilled from two source PDFs:

- **`resources/PalisadesResearch-BrandGuide-feb18.pdf`** — the
  authoritative Feb 2026 35-page guide. Covers the brand at its most
  current; introduces Foundation Blue covers and codifies the
  "vertical distorted lines" treatment (page 30 is the source of
  truth — "derived from the Palisade logomark, evoking a sense of
  protection, structure, and control").
- **`resources/Palisade-Brandguide/Slide 16_9 - *.pdf`** — older
  16:9 slide collection used to seed v1 of this file. Compatible
  but less complete; the feb18 PDF wins on conflicts.

Logo assets live alongside this file at `brand-assets/`:

| File | Use |
|---|---|
| `palisade-logo-horizontal-black.png` | Primary lockup on light bg |
| `palisade-logo-horizontal-white.png`  | Primary lockup on dark bg (Foundation Blue, Steel Grey) |
| `palisade-logomark-black.png`         | Mark-only on light bg |
| `palisade-logomark-white.png`         | Mark-only on dark bg |

## 1. Color palette

### Primary
| Token | Hex | Use |
|---|---|---|
| **Steel Grey** | `#29303E` | Default text on light bg; secondary dark bg (statement/quote slides) |
| **Foundation Blue** | `#173164` | **Primary cover + mission color in the feb18 guide.** Three of three Layout-Example covers (p. 31) use it. Earlier guides treated it as "rare" — it is no longer rare. |
| **Soft Blue** | `#3F598C` | Mid-blue support; mix in editorial graphics |
| **Science Green** | `#C7E09C` | Hero accent (signature) — used in "vertical distorted lines" treatment |
| **Stone Green** | `#F2F3F0` | Default light background (NOT pure white) |

### Functional (status-only, never large fills or backgrounds)
| Token | Hex | Role |
|---|---|---|
| Signal Yellow | `#EBC932` | UI warning |
| Critical Red | `#C64B2A` | UI error |
| Clarity Blue | `#78C3C6` | UI info |
| Verified Green | `#1D925E` | UI success |

### Text-on-background rules
- On **Foundation Blue** (covers): Stone Green or white (preferred). Science Green for accent within editorial graphics.
- On **Steel Grey**: Stone Green or white (preferred). Science Green/Soft Blue/Signal Yellow/Verified Green/Critical Red/Clarity Blue for emphasis.
- On **Stone Green**: Steel Grey (preferred), Foundation Blue, Soft Blue, Verified Green. (Black allowed only at small sizes.)
- On **white**: Steel Grey (preferred), Foundation Blue, Soft Blue, Verified Green, Critical Red.
- **Steel Grey is the preferred text color over pure black.**

### Secondary palette is not just decoration
The feb18 guide (p. 33-34: Additional Treatments + Mockup Examples) shows the
secondary palette — Critical Red / Signal Yellow — being used as **full-bleed cover ground** on real-world book covers and Instagram posts. So while the rule "no secondary as background" applies to editorial slide chrome, brand-correct cover artwork CAN be Critical Red or yellow with distorted lines overlay. Treat these as deliberate one-shot statement covers, not a default.

## 2. Typography

- **DM Sans** — display + body (every text element except the metadata strip).
- **DM Mono** — metadata strip ONLY (date / section / page header / slide number).
- No serif, no third typeface.
- Hierarchy via **color and scale**, not weight. Bold is rare.
- DM Sans weights: Regular for body; Regular/Medium for big display.
- Hierarchy (in deck-relative units, expressed as ratios of body):
  - Hero display: ~160-200pt, line-height ≈ 0.95-1.0
  - Section number ("2.0"): ~80pt, light weight, top-left
  - Sub-display ("Logo Mark", etc.): ~64pt; often two-tone — first word dark Steel Grey, second word mid-grey for hierarchy
  - Body: ~14-16pt single-column block, ~280-340px wide
  - Metadata strip: ~10pt DM Mono, ALL CAPS, letter-spaced
- Body line-height ≈ 1.4.
- Paragraph blocks live in a narrow gutter — never full-width.

## 3. Spacing & grid

- 16:9 canvas (brand-native; we adapt to 4:3).
- Outer margin ≈ 2.5% of width.
- Top rule (1px) sits ~32px from top edge; metadata strip lives in the band above it.
- **Two-zone composition** dominant: left ~25% label column, right ~75% content. Recurring template.
- Display headlines hug bottom-left corner with body caption stacked nearby.
- Baseline gutter between display title and body block ≈ 24-32px.

## 4. Logo / mark

Three lockups:
- **Logomark** — five upward-pointing "palisade peaks" (5 tapered shapes), solid color, never gradient or outline.
- **Horizontal stack** (mark + wordmark side-by-side) — the **primary** lockup.
- **Vertical / centered** (mark above wordmark) — for video title cards.

Rules:
- Minimum size 16×16 px (mark only).
- Clear space ≥ 1 peg-width.
- Steel Grey on light bg; white on dark bg; black/white only when not Steel Grey.
- No other colors for the wordmark.
- Wordmark in DM Sans.

## 5. Slide-level conventions

Every interior slide:
- **Background:** Stone Green (light) or Steel Grey (statement slides).
- **Top metadata strip** (10pt DM Mono, ALL CAPS, letter-spaced):
  - Left: date `FEBRUARY 1, 2026  |  <SECTION NAME>`
  - Center: `BRAND IDENTITY GUIDELINE`
  - Right: zero-padded slide number (`01`, `12`, `28`)
- **Hairline rule** (1px, Steel Grey at low opacity) under the metadata strip, full width.
- No footer. No accent stripe at bottom. No persistent logo on every slide.

## 6. Iconography / illustration

- **Technical/blueprint style only.** Exploded axonometric line drawings — laptops, chips, GPIO headers, schematics.
- Thin uniform Steel Grey strokes on light background.
- ALL-CAPS callouts with leader lines.
- No flat illustrations, no mascots, no gradients, no isometric color blocks.

## 7. Photography

- "Real over conceptual. Clarity over aesthetic."
- Subject: data centers, server rooms, hands-on hardware, code on screens, researchers at workstations.
- Mood: documentary, grounded, slightly grim/cool lighting.
- Avoid stylized, abstract, cinematic, emotionally exaggerated.
- Secondary photography: macro shots of fiber optics, GPU pins, molecular renders — texture/atmosphere only.

## 8. Signature graphic: "Vertical Distorted Lines"

**Source of truth: feb18 PDF page 30.** Page-30 explanatory text:

> The vertical line treatment is derived from the Palisade logomark,
> evoking a sense of protection, structure, and control. The repeated
> lines create a visual framework that can stand on its own or be used
> to frame content.
>
> When photography is unavailable, the treatment can be used as a
> graphic fill to establish presence and consistency. When paired with
> photography, it introduces moments of reveal, allowing imagery and
> information to emerge through the structure.

### Geometry

- Vertical bars only — never rotated, never fragmented, never animated.
- **Bar widths vary.** ~12-36px on a 1440px-wide canvas.
- **Gaps between bars are consistent** (~28-32px at the brand spec).
  Older summaries claimed gaps were also irregular — they are not.
  Watch the corrected gap-vs-width invariant.
- Bars cycle through a varying-width pattern; the repeating-linear-
  gradient in `deck-styles.css` encodes the cycle.

### Color modes

- Science Green (`#C7E09C`) bars on Stone Green ground — the canonical
  pairing.
- Steel Grey bars on Stone Green — alt for sober content.
- Foundation Blue bars on Stone Green — covers + section openers.
- Bars OVER photography — Science Green or Steel Grey; overlay
  opacity ~78%, image still legible through gaps.

### Anchoring variants (page 31 Layout Examples)

- **Full-bleed** half-width on the right — default section opener.
- **Top-anchored** — bars hang from the top edge, content sits below.
- **Floor-anchored** — bars rise from the bottom edge, hero above.
- **Photo-overlay** — bars float over a B&W documentary photo;
  Science Green reveals the photo through the gaps.

`deck-styles.css` exposes these as `.ps-distorted-lines.is-top`,
`.is-floor`, `.is-full-bleed`, `.is-overlay`.

## 9. Layout templates (worked examples)

- **Cover/title (feb18 p. 31)**: **Foundation Blue** full-bleed (not Steel Grey — earlier guides were wrong on this). Display title bottom-left in Stone Green/white, two lines, second line in mid-Stone-Green for hierarchy. Logomark bottom-right (white). Optional top-anchored distorted lines in Science Green or Stone Green.
- **Contents/TOC**: Stone Green. Two-column list `01 Introduction`, `02 Logo`, … index in light grey, label in Steel Grey, both ~64pt.
- **Section opener**: Stone Green. Section number top-left, distorted-lines on right ~50% in Science Green, body bottom-left.
- **Quote/mission**: Foundation Blue or Steel Grey full-bleed. Small DM Mono label top-left ("OUR MISSION"). Massive DM Sans quote bottom-left, ~120pt, 3-4 lines, line-height ~1.05. **NO quote marks.**
- **Logo lockup display**: 25/75 split — left white panel with two-tone title + caption, right Stone Green with logo centered.
- **Color palette grid**: Left title column, right split into 5 vertical color bars labeled name (DM Mono caps) + CMYK + RGB + hex in white DM Mono on swatch.
- **Charting**: Stone Green. Multiple chart specimens with caption block to right of each. Charts use primary + secondary palette (only sanctioned mass use of secondary colors).
- **Stat (hero number)**: Stone Green. DM Mono eyebrow top-left, hero number ~6em center-left, sentence-case label below. Variant: Steel Grey full-bleed for closing pivot stats.
- **Close slide (feb18 p. 35 "Thanks!")**: Stone Green. Single word or short phrase at ~12em DM Sans Regular, bottom-left. Nothing else.

## 10. Anti-patterns

- Don't stretch/distort the logo.
- Don't place logo on busy or low-contrast photo background.
- Don't recolor the logo (no secondary-palette fills, no gradients).
- Don't rotate or remix the logo.
- No effects on logo: no shadows, outlines, gradients, glows.
- Don't pluralize: "Palisades" is wrong — "Palisade" or "Palisade Research."
- Don't use pure black for primary text — use Steel Grey `#29303E`.
- Don't use secondary palette colors as large fills or backgrounds.
- Charts: no decorative treatments, no gradients.
- Distorted lines: keep vertical + floor-to-ceiling; don't rotate or fragment.

## CSS variable seed

```css
--ps-steel:        #29303E;   /* default text on light, dark bg */
--ps-stone:        #F2F3F0;   /* default light bg               */
--ps-soft-blue:    #3F598C;
--ps-foundation:   #173164;
--ps-science:      #C7E09C;   /* hero accent                    */
--ps-yellow:       #EBC932;
--ps-red:          #C64B2A;
--ps-clarity:      #78C3C6;
--ps-verified:     #1D925E;
--ps-font-sans:    "DM Sans", system-ui, sans-serif;
--ps-font-mono:    "DM Mono", ui-monospace, monospace;
--ps-rule:         1px solid #29303E33;
--ps-margin:       2.5%;
```

## Reveal.js layout mapping (the 8 in our library)

- **title:** **Foundation Blue** bg (Steel Grey is a fallback variant), hero display DM Sans bottom-left in Stone Green or white, second line in mid-tone for hierarchy, logomark bottom-right.
- **section:** Stone Green bg, small section number top-left, distorted-lines fill on right ~50% in Science Green, body bottom-left.
- **bullets:** Stone Green bg, title top-left, bullets in DM Sans regular with section-number-style markers (`01`, `02`) in light grey acting as bullet glyph. `emphasis: 'large'` for the callout register (now actually large — boosted to ~1.45em).
- **two-col:** Stone Green bg, left 25-35% label/caption column, right 65-75% content. Strongest brand template — use as default for anything non-hero.
- **image-full:** Steel Grey or Stone Green bg with image filling right ~75%, metadata strip and caption preserved on left.
- **quote:** Foundation Blue or Steel Grey full-bleed, massive DM Sans bottom-left at ~120pt, NO quote marks, small label in DM Mono caps above.
- **stat:** Stone Green bg (or Steel Grey full-bleed via `background: 'steel'`). DM Mono eyebrow → hero number at ~6em → sentence-case label. Persuasive-briefing primitive — use whenever a single quantitative beat would otherwise get buried in prose or a table cell.
- **table:** Stone Green bg, DM Sans body, hairline Steel Grey rules at 20% opacity, headers in DM Mono caps, no zebra stripes — use whitespace for separation.

## Content-density rules (calibrated against Duarte / Tufte / Takahashi)

- **6×6**: max 6 bullets per slide, ≤6 *content* words each. We allow
  "**Lead.** body sentence." up to 90 chars (~12-14 words) to encode
  headline-detail, but pure-word-list bullets stay tight.
- **Title typography is the unit**: if a phrase deserves the slide, it
  deserves Hero scale. Don't dilute with prose.
- **Stat over table**: if one cell in a table is the actual point,
  promote it to a `stat` layout. Tables are for cross-cuts, not for
  hero numbers.
- **One visual every 3 slides**: at minimum, every third slide should
  carry a visual element — image-full, two-col with a figure, distorted-
  lines section opener, stat, or quote. Pure-bullets runs are the
  fastest way to bore an audience.
- **Section breaks reset rhythm**: a `section` divider between content
  runs gives the audience a moment to catch up; it isn't filler.
