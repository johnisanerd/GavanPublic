/**
 * Scenarios index — JSON file on disk that lists provisioned
 * scenarios. Read-mostly for operator UIs; written by the upload
 * flow. Authoritative knowledge lives in NanoClaw's central DB
 * (agent_groups, messaging_groups); this index is a denormalized
 * convenience for fast listing without round-tripping the DB.
 *
 * Node-only — uses fs. Browsers consume scenarios via HTTP.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ScenarioRow, ScenariosIndex } from './types.js';

export function loadIndex(path: string): ScenariosIndex {
  if (!existsSync(path)) return { scenarios: [] };
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ScenariosIndex;
  } catch {
    return { scenarios: [] };
  }
}

export function saveIndex(path: string, idx: ScenariosIndex): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(idx, null, 2));
}

/** Insert or update a scenario by slug. Returns the updated index
 *  (in-place mutation OK — caller usually calls saveIndex next). */
export function upsertScenario(idx: ScenariosIndex, row: ScenarioRow): ScenariosIndex {
  const existing = idx.scenarios.findIndex((s) => s.slug === row.slug);
  if (existing >= 0) idx.scenarios[existing] = row;
  else idx.scenarios.push(row);
  return idx;
}

export function findScenario(idx: ScenariosIndex, slug: string): ScenarioRow | undefined {
  return idx.scenarios.find((s) => s.slug === slug);
}
