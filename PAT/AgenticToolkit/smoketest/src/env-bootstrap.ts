/**
 * Self-load specific secrets from the repo-root `.env.agent` when they
 * aren't already in the environment — so a fresh agent can run the interactive
 * smoke primitives (smoke-chat / smoke-trace) WITHOUT a manual export dance.
 *
 * Only pulls the exact keys asked for (never dumps the whole file, which holds
 * multi-line Fly tokens that break naive sourcing). Env always wins.
 */
import fs from 'node:fs';
import path from 'node:path';

export function ensureEnvFromAgentSecrets(keys: string[]): void {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length === 0) return;
  const candidates = [
    path.resolve(process.cwd(), '../.env.agent'),
    path.resolve(process.cwd(), '.env.agent'),
  ];
  const file = candidates.find((p) => fs.existsSync(p));
  if (!file) return;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1]!;
    const val = m[2] ?? '';
    if (missing.includes(key) && !process.env[key]) process.env[key] = val;
  }
}
