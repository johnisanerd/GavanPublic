/**
 * PAT: `ncl people` — operator CRUD for the people spine.
 *
 * Reads (list/get/identifiers/handles/resolve) are generic SELECTs and `open`.
 * Every WRITE routes through `src/people/` (the single source of truth) via a
 * custom operation, and is `approval`-gated like the `users` resource — so an
 * agent container can't mutate identities without operator sign-off.
 *
 * Not on the group-scope whitelist (see dispatch.ts), so group-scoped agents
 * can't reach it at all; only host callers (operators over the socket) and
 * full-scope agents can.
 */
import {
  addIdentifier,
  backfillFromUsers,
  createPerson,
  deletePerson,
  getHandlesForPerson,
  getIdentifiers,
  getPersonByUser,
  linkHandle,
  removeIdentifier,
  resolvePersonByIdentifier,
  unlinkHandle,
  updatePerson,
} from '../../people/index.js';
import type { IdentifierKind } from '../../people/normalize.js';
import { registerResource } from '../crud.js';

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`--${name.replace(/_/g, '-')} is required`);
  return v;
};

const asKind = (v: unknown): IdentifierKind => {
  const k = str(v, 'kind');
  if (k !== 'email' && k !== 'phone') throw new Error("--kind must be 'email' or 'phone'");
  return k;
};

registerResource({
  name: 'person',
  plural: 'people',
  table: 'people',
  description:
    'Person — one human identity. Handles (users rows) link to a person via person_users; a person is recognized by email/phone in person_identifiers (the auto-enroll door). Pure identity: names + timestamps only.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'Auto-set (person-<uuid>).', generated: true },
    { name: 'first_name', type: 'string', description: 'Given name. Required on create.', required: true },
    { name: 'last_name', type: 'string', description: 'Family name. Required on create.', required: true },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
    { name: 'updated_at', type: 'string', description: 'Auto-set on update.' },
  ],
  // Reads only via the generic handlers; all writes are custom (route through src/people/).
  operations: { list: 'open', get: 'open' },
  customOperations: {
    create: {
      access: 'approval',
      description: 'Create a person. ncl people create --first-name X --last-name Y',
      handler: async (args) =>
        createPerson({ first_name: str(args.first_name, 'first_name'), last_name: str(args.last_name, 'last_name') }),
    },
    update: {
      access: 'approval',
      description: "Update a person's name. ncl people update --id P [--first-name X] [--last-name Y]",
      handler: async (args) =>
        updatePerson(str(args.id, 'id'), {
          first_name: args.first_name as string | undefined,
          last_name: args.last_name as string | undefined,
        }),
    },
    delete: {
      access: 'approval',
      description:
        'Delete a person AND fully deregister every linked handle (cascade): removes membership, roles, DM cache, dedicated 1:1 DM groups + wiring, in-flight approvals, pairing audit, and the users row — reverting each handle to unknown/unapproved. Shared group chats are KEPT (reported). All-or-nothing. ncl people delete --id P',
      handler: async (args) => deletePerson(str(args.id, 'id')),
    },
    'add-identifier': {
      access: 'approval',
      description:
        'Attach an email/phone the person is recognized + auto-enrolled by. ncl people add-identifier --person-id P --kind phone --value +15550100001',
      handler: async (args) =>
        addIdentifier({
          person_id: str(args.person_id, 'person_id'),
          kind: asKind(args.kind),
          value: str(args.value, 'value'),
        }),
    },
    'remove-identifier': {
      access: 'approval',
      description: 'Remove an identifier. ncl people remove-identifier --kind phone --value +15550100001',
      handler: async (args) => removeIdentifier(asKind(args.kind), str(args.value, 'value')),
    },
    identifiers: {
      access: 'open',
      description: "List a person's identifiers. ncl people identifiers --person-id P",
      handler: async (args) => getIdentifiers(str(args.person_id, 'person_id')),
    },
    link: {
      access: 'approval',
      description:
        'Link an existing handle (users row) to a person. ncl people link --user-id signal:+1555 --person-id P',
      handler: async (args) => linkHandle(str(args.user_id, 'user_id'), str(args.person_id, 'person_id'), 'manual'),
    },
    unlink: {
      access: 'approval',
      description: 'Unlink a handle from its person. ncl people unlink --user-id signal:+1555',
      handler: async (args) => unlinkHandle(str(args.user_id, 'user_id')),
    },
    handles: {
      access: 'open',
      description: 'List the handles linked to a person. ncl people handles --person-id P',
      handler: async (args) => getHandlesForPerson(str(args.person_id, 'person_id')),
    },
    resolve: {
      access: 'open',
      description:
        'Resolve a person by identifier or handle. ncl people resolve (--kind phone --value +1555 | --user-id signal:+1555)',
      handler: async (args) => {
        if (args.user_id) return getPersonByUser(str(args.user_id, 'user_id')) ?? null;
        return resolvePersonByIdentifier(asKind(args.kind), str(args.value, 'value')) ?? null;
      },
    },
    backfill: {
      access: 'approval',
      description: 'Retroactively link existing handles to seeded people (idempotent). ncl people backfill',
      handler: async () => backfillFromUsers(),
    },
  },
});
