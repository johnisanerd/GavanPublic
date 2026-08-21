/**
 * PAT: per-person + shared memory mounts (Phase 3) — fixes the live
 * shared-memory leak.
 *
 * Today an agent group's memory (CLAUDE.local.md + memory/) lives in the group
 * dir, mounted RW at /workspace/agent and therefore shared across EVERY person
 * the group talks to — a personal fact recorded about one person is in-context
 * for everyone else. PAT runs as a single group (palisade-internal), so this is
 * a real cross-user leak.
 *
 * Fix (scope, don't disable): mount two extra spaces, keyed by identity:
 *   - /shared   → per-(agent_group): operational / about-PAT facts that are
 *                 fine to share. Always mounted.
 *   - /personal → per-(person, agent_group): facts about the specific person.
 *                 Mounted ONLY for 1:1 sessions (a group chat has no single
 *                 "personal" owner). Resolved via the people spine.
 *
 * nanoclaw hand-rolls memory as plain files (Read/Edit, not the Anthropic Memory
 * tool), so this is purely a mount + doctrine change — the agent reads/writes
 * these dirs explicitly, guided by the Memory section of the container CLAUDE.md.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { getPersonByUser } from './people/index.js';
import type { VolumeMount } from './providers/provider-container-registry.js';
import type { Session } from './types.js';

const SHARED_README = `# Shared memory (this agent group)

Operational facts and notes about PAT itself that are fine for EVERYONE this
agent talks to — how things work, group conventions, non-personal context.

Do NOT put facts about a specific person here (those go in /personal). Plain
markdown; create topic files and link them from this index.
`;

// Seeded as /personal/CLAUDE.local.md — deliberately the same filename the
// agent already treats as "my memory", so it's far more likely to actually
// write personal facts here instead of the shared group file.
const PERSONAL_SEED = `# Personal memory

Private memory about the ONE person in this conversation — their preferences,
projects, details they've shared. Mounted only in 1:1 sessions with this person
and visible only to them, never anyone else.

Person-specific facts belong HERE. Do not put them in the group's shared
CLAUDE.local.md. Plain markdown; create topic files and link them from this one.
`;

function ensureMemoryDir(dir: string, filename: string, content: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const seed = path.join(dir, filename);
  if (!fs.existsSync(seed)) fs.writeFileSync(seed, content);
}

// Defense-in-depth: personId / agentGroupId are interpolated into a host path
// that becomes a container mount. They're server-generated today (person-<uuid>,
// operator slug) but createPerson accepts a caller-set id, so reject anything
// that could traverse (`..`, `/`, etc.) before it ever reaches a `-v` mount.
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
function safeSegment(s: string): boolean {
  return SAFE_SEGMENT.test(s) && s !== '.' && s !== '..';
}

/**
 * Resolve the single person for a session, or null (→ /shared only).
 *
 * Trivial by design: the resolving sender is bound to a person on the inbound
 * path (autoEnroll, every inbound) and recorded on the session as `user_id` at
 * creation, so the person is just getPersonByUser(session.user_id). This works
 * uniformly across channels — including venue-style ones like phone-call, where
 * the routing mg is `phone-call:<number>` but the person handle is
 * `pstn:<number>` — because we use the bound identity, not the routing ids.
 *
 * Group chats get no /personal (a shared session has no single person). Legacy
 * sessions created before user_id existed, anonymous channels (anam-web's
 * per-visitor uuid → no person), and unregistered callers all resolve to null.
 *
 * NOTE (spoofing): on caller-ID-spoofable channels (pstn) the bound handle is
 * not proof-of-possession. Acceptable for trusted-internal use; the hardening if
 * the trust boundary widens is proof-of-possession enrollment (link_method=
 * 'pairing') — see an internal security review. (The dead `verified` flag was
 * removed 2026-07-07 — it was written but never read.)
 */
export function resolveSessionPerson(session: Session): string | null {
  if (!session.user_id) return null;
  if (session.messaging_group_id) {
    const mg = getMessagingGroup(session.messaging_group_id);
    if (mg?.is_group) return null; // shared/group session → no single person
  }
  return getPersonByUser(session.user_id)?.id ?? null;
}

/**
 * Build the /shared (always) and /personal (1:1 + resolved person only) memory
 * mounts for a session. Seeds each dir on first use (/shared → MEMORY.md,
 * /personal → CLAUDE.local.md). Both RW.
 */
export function personalMemoryMounts(agentGroupId: string, session: Session): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  if (!safeSegment(agentGroupId)) return mounts; // never build a mount from an unsafe segment

  const sharedDir = path.join(DATA_DIR, 'memory', 'shared', agentGroupId);
  ensureMemoryDir(sharedDir, 'MEMORY.md', SHARED_README);
  mounts.push({ hostPath: sharedDir, containerPath: '/shared', readonly: false });

  const personId = resolveSessionPerson(session);
  if (personId && safeSegment(personId)) {
    const personalDir = path.join(DATA_DIR, 'memory', 'people', personId, agentGroupId);
    ensureMemoryDir(personalDir, 'CLAUDE.local.md', PERSONAL_SEED);
    mounts.push({ hostPath: personalDir, containerPath: '/personal', readonly: false });
  }

  return mounts;
}
