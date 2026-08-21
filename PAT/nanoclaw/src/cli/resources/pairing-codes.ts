// PAT: pairing-codes resource — self-service handle linking by proof-of-
// possession. The dashboard creates a code for the logged-in operator's person
// (over the /admin/ncl bridge), shows it with a countdown, then polls the
// person's codes to flip to "paired" when a handle consumes one. The inbound
// path (src/modules/permissions/pairing.ts) does the actual linking when a
// message from an unlinked handle contains the code. See
// plans/pairing-handle-linking.md.
//
// All writes route through src/people/pairing.ts (the single source of truth)
// and are `approval`-gated like the other identity resources — an agent
// container can't mint pairing codes without operator sign-off; the host
// (operator over the socket / the bridge) runs them inline.
import { createPairingCode, getPairingCode, listPairingCodesForPerson } from '../../people/pairing.js';
import { registerResource } from '../crud.js';

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`--${name.replace(/_/g, '-')} is required`);
  return v;
};

registerResource({
  name: 'pairing-code',
  plural: 'pairing-codes',
  table: 'pairing_codes',
  description:
    "Pairing code — a short numeric code an operator generates for a person, then sends FROM a new handle to link it (proof of possession). 6-digit, 5-min TTL, single-use. While active, any message from an UNLINKED handle containing the code links that handle to the code's person.",
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'Auto-set (pair-<uuid>).', generated: true },
    { name: 'code', type: 'string', description: '6-digit numeric code (substring-matched against inbound text).' },
    { name: 'person_id', type: 'string', description: 'Person the code pairs a handle to.' },
    { name: 'created_at', type: 'string', description: 'Auto-set.' },
    { name: 'expires_at', type: 'string', description: 'Absolute ISO; active = now < this AND not consumed.' },
    { name: 'consumed_at', type: 'string', description: 'When a handle consumed it (NULL = unused; single-use).' },
    {
      name: 'linked_user_id',
      type: 'string',
      description: 'The handle that consumed the code (success view + audit).',
    },
  ],
  // Reads via the generic list/get; writes are custom (route through src/people/pairing.ts).
  operations: { list: 'open', get: 'open' },
  customOperations: {
    create: {
      access: 'approval',
      description:
        'Mint a pairing code for a person. ncl pairing-codes create --person-id P. Returns { id, code, person_id, expires_at }.',
      handler: async (args) => {
        const code = createPairingCode(str(args.person_id, 'person_id'));
        return {
          id: code.id,
          code: code.code,
          person_id: code.person_id,
          created_at: code.created_at,
          expires_at: code.expires_at,
        };
      },
    },
    'for-person': {
      access: 'open',
      description:
        "List a person's pairing codes, newest first (the dashboard's poll source). ncl pairing-codes for-person --person-id P.",
      handler: async (args) => listPairingCodesForPerson(str(args.person_id, 'person_id')),
    },
    status: {
      access: 'open',
      description:
        'Get one pairing code by id (poll a specific code to detect when it pairs). ncl pairing-codes status --id pair-...',
      handler: async (args) => getPairingCode(str(args.id, 'id')) ?? null,
    },
  },
});
