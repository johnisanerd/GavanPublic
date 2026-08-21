// One-shot: regenerate _packet-bundle.md for every presenter agent
// group on disk after a Phase 6 packet-shape migration.
//
// Reads each `groups/presenter-X/packet/`:
//   - manifest.yaml
//   - slides.html  (Phase 6 canonical)
//   - tone.md (optional)
//   - deep-context.md (optional)
//   - audience-qa.md (optional)
// Writes: `groups/presenter-X/_packet-bundle.md`
//
// Idempotent. Groups missing slides.html are skipped (legacy not yet
// migrated).
import fs from 'node:fs';
import path from 'node:path';

import { extractPresentationSlides, renderPresentationSlide } from '@agentic-toolkit/scenarios/presentation';

import { GROUPS_DIR } from '../src/config.js';

function buildBundle(folder: string): boolean {
  const groupDir = path.resolve(GROUPS_DIR, folder);
  const packetDir = path.join(groupDir, 'packet');
  const slidesHtmlPath = path.join(packetDir, 'slides.html');
  if (!fs.existsSync(slidesHtmlPath)) {
    console.warn(`[rebundle] ${folder}: no slides.html — skipping`);
    return false;
  }
  const slidesHtml = fs.readFileSync(slidesHtmlPath, 'utf8');
  const slides = extractPresentationSlides(slidesHtml);
  if (slides.length === 0) {
    console.warn(`[rebundle] ${folder}: extractor returned 0 slides — skipping`);
    return false;
  }

  const manifestPath = path.join(packetDir, 'manifest.yaml');
  if (!fs.existsSync(manifestPath)) {
    console.warn(`[rebundle] ${folder}: no manifest.yaml — skipping`);
    return false;
  }
  const manifestText = fs.readFileSync(manifestPath, 'utf8').trimEnd();

  const tonePath = path.join(packetDir, 'tone.md');
  const tone = fs.existsSync(tonePath) ? fs.readFileSync(tonePath, 'utf8') : '';
  const deepContextPath = path.join(packetDir, 'deep-context.md');
  const deepContext = fs.existsSync(deepContextPath) ? fs.readFileSync(deepContextPath, 'utf8') : '';
  const audienceQaPath = path.join(packetDir, 'audience-qa.md');
  const audienceQa = fs.existsSync(audienceQaPath) ? fs.readFileSync(audienceQaPath, 'utf8') : '';

  const lines: string[] = [];
  lines.push('# Packet bundle (auto-loaded; no need to call present_get_slide or Read)');
  lines.push('');
  lines.push('Everything below is your packet — manifest, every slide spec,');
  lines.push('tone guide, deep context, audience Q&A. Use directly when');
  lines.push("composing each slide's send_message text. **DO NOT call");
  lines.push('`present_get_slide` or `Read` on packet/ files — the content');
  lines.push('is already in your system prompt.**');
  lines.push('');
  lines.push('## manifest.yaml');
  lines.push('```json');
  lines.push(manifestText);
  lines.push('```');
  lines.push('');
  if (tone) {
    lines.push('## tone.md');
    lines.push('```markdown');
    lines.push(tone.trimEnd());
    lines.push('```');
    lines.push('');
  }
  lines.push('## Slides');
  lines.push('');
  for (const slide of slides) {
    lines.push(`### slide ${slide.n} — ${slide.id}`);
    lines.push('```xml');
    lines.push(renderPresentationSlide(slide));
    lines.push('```');
    lines.push('');
  }
  if (deepContext) {
    lines.push('## deep-context.md');
    lines.push('```markdown');
    lines.push(deepContext.trimEnd());
    lines.push('```');
    lines.push('');
  }
  if (audienceQa) {
    lines.push('## audience-qa.md');
    lines.push('```markdown');
    lines.push(audienceQa.trimEnd());
    lines.push('```');
    lines.push('');
  }
  const bundlePath = path.join(groupDir, '_packet-bundle.md');
  fs.writeFileSync(bundlePath, lines.join('\n'));
  console.log(`[rebundle] ${folder}: wrote ${slides.length} slides → ${bundlePath}`);
  return true;
}

const entries = fs.readdirSync(GROUPS_DIR);
let count = 0;
for (const entry of entries) {
  if (!entry.startsWith('presenter-')) continue;
  const full = path.join(GROUPS_DIR, entry);
  if (!fs.statSync(full).isDirectory()) continue;
  if (buildBundle(entry)) count += 1;
}
console.log(`[rebundle] done: ${count} packet(s) rebundled`);
