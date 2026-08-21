/**
 * Build-time renderer coverage check (NON-FATAL).
 *
 * The event renderer (src/lib/event-render.ts) is deliberately fail-soft: an
 * event kind with no `case` renders generically rather than breaking the build.
 * The cost of that is silence — you wouldn't notice a kind has no bespoke
 * renderer. This script restores the signal WITHOUT the cost: it diffs the
 * canonical kind list against the renderer's handled cases and prints a warning
 * in the build output for any kind that lacks a renderer. It ALWAYS exits 0, so
 * it never blocks a build/deploy — it just nudges.
 *
 * Runs as the first step of `build` (see package.json), so the warning shows in
 * local builds AND in the Fly/Docker deploy log.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

// Canonical kinds = the `kind: '<x>';` discriminator on every event interface.
// This is exactly what `renderEvent(rec: LogEvent)` switches on, so it's the
// faithful source. (We deliberately do NOT use the LOG_EVENT_KINDS array — it can
// drift from the union; today it's missing people.* and lists kinds with no
// interface, which would make this check flag the wrong set.) The anchor `^\s*`
// keeps us to top-of-interface discriminators, never a `kind:` field inside data.
const schema = read('src/types/log-events.ts');
const kinds = [...new Set([...schema.matchAll(/^\s*kind:\s*'([^']+)'/gm)].map((m) => m[1]))];
if (kinds.length === 0) {
  console.warn('[check-renderers] found no event-kind discriminators — skipping coverage check');
  process.exit(0);
}

// Handled: every `case '<x>'` in the renderer. The kindClass-category switch uses
// non-kind tokens (e.g. 'container', 'chat'), which simply don't intersect the
// canonical kind list — so they're harmlessly ignored by the diff.
const renderer = read('src/lib/event-render.ts');
const handled = new Set([...renderer.matchAll(/case\s*'([^']+)'/g)].map((m) => m[1]));

const missing = kinds.filter((k) => !handled.has(k));

if (missing.length) {
  console.warn(
    `\n⚠️  [check-renderers] ${missing.length}/${kinds.length} event kinds have NO bespoke renderer in event-render.ts.`,
  );
  console.warn('   They render generically (kind + JSON). Non-fatal — add a case in renderEvent() for a nicer line:');
  console.warn('   ' + missing.join(', ') + '\n');
} else {
  console.log(`[check-renderers] ✓ all ${kinds.length} event kinds have a bespoke renderer`);
}

process.exit(0);
