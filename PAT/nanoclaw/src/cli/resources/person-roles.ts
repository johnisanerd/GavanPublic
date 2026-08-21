// PAT: person_roles resource — dashboard data-visibility authority, keyed on
// PERSON. Distinct from the `roles` resource (user_roles = agent-runtime
// authority, handle-keyed). Role names map to capabilities in pat-frontend
// (ROLE_CAPS), not here. See plans/dashboard-permissions.md.
import { getDb } from '../../db/connection.js';
import { registerResource } from '../crud.js';

const ROLES = ['admin', 'employee'] as const;

registerResource({
  name: 'person-role',
  plural: 'person-roles',
  table: 'person_roles',
  description:
    'Dashboard access role for a person (data-visibility authority). "admin" sees/does everything in the dashboard; "employee" is read-only and scoped to their own data. One role per person. Distinct from `roles` (user_roles), which is agent-runtime authority. Names map to capabilities in pat-frontend code.',
  idColumn: 'person_id',
  columns: [
    { name: 'person_id', type: 'string', description: 'Person receiving the role. Must exist in people table.' },
    {
      name: 'role',
      type: 'string',
      description: '"admin" = full dashboard access. "employee" = read-only, own-scoped.',
      enum: [...ROLES],
    },
    { name: 'granted_by', type: 'string', description: 'person_id of the granting admin. Informational.' },
    { name: 'granted_at', type: 'string', description: 'Auto-set.' },
  ],
  operations: { list: 'open' },
  customOperations: {
    grant: {
      access: 'approval',
      description:
        "Set a person's dashboard role. Use --person and --role (admin|employee). Replaces any existing role.",
      handler: async (args) => {
        const personId = args.person as string;
        const role = args.role as string;
        const grantedBy = (args.granted_by as string) ?? null;
        if (!personId) throw new Error('--person is required');
        if (!role || !ROLES.includes(role as (typeof ROLES)[number])) {
          throw new Error(`--role must be one of: ${ROLES.join(', ')}`);
        }
        const exists = getDb().prepare('SELECT id FROM people WHERE id = ?').get(personId);
        if (!exists) throw new Error(`person not found: ${personId}`);
        // One role per person (PK person_id) — REPLACE upserts the role.
        getDb()
          .prepare(
            `INSERT OR REPLACE INTO person_roles (person_id, role, granted_by, granted_at)
             VALUES (?, ?, ?, datetime('now'))`,
          )
          .run(personId, role, grantedBy);
        return { person_id: personId, role, granted_by: grantedBy };
      },
    },
    revoke: {
      access: 'approval',
      description: "Remove a person's dashboard role entirely (revokes all access). Use --person.",
      handler: async (args) => {
        const personId = args.person as string;
        if (!personId) throw new Error('--person is required');
        const result = getDb().prepare('DELETE FROM person_roles WHERE person_id = ?').run(personId);
        if (result.changes === 0) throw new Error('no role to revoke for that person');
        return { revoked: { person_id: personId } };
      },
    },
  },
});
