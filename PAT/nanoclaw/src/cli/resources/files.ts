/**
 * PAT: `ncl files publish` — the host-side half of the publish_file MCP tool.
 *
 * The container agent calls this over the session-DB CLI transport (the only
 * synchronous host RPC available to it), which gives the handler a trusted
 * CallerContext (agent group + session from the delivery action, NOT from
 * tool args) — the container can only ever publish out of its own mounts.
 *
 * `files` is whitelisted for cli_scope=group agents in dispatch.ts. Access is
 * 'open' (no approval card) by operator decision; see the backlog note about
 * possibly gating publishes behind approval later.
 */
import { publishFile, DEFAULT_TTL_HOURS, MAX_TTL_HOURS } from '../../modules/file-publish/index.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'file',
  plural: 'files',
  table: '',
  description:
    'Published files — agent-shared files served at a public, signed, expiring URL ' +
    '(https://<public-base>/files/pub/<name>?exp=..&sig=..).',
  idColumn: 'id',
  columns: [],
  operations: {},
  customOperations: {
    publish: {
      access: 'open',
      description:
        `Publish a workspace file to a public signed URL. --path (required, container path ` +
        `e.g. /workspace/agent/report.pdf or relative to the agent dir), --ttl (optional: ` +
        `"24h", "3d", or hours; default ${DEFAULT_TTL_HOURS}h, min 1h, max ${MAX_TTL_HOURS / 24}d).`,
      handler: async (args, ctx) => {
        const containerPath = args.path as string;
        if (!containerPath) throw new Error('--path is required');
        if (ctx.caller === 'agent') {
          return publishFile(containerPath, args.ttl as string | undefined, {
            agentGroupId: ctx.agentGroupId,
            sessionId: ctx.sessionId,
          });
        }
        // Host caller (operator via `ncl` / smoke harness): must name the
        // session whose mounts anchor the path.
        const agentGroupId = args.agent_group_id as string;
        const sessionId = args.session_id as string;
        if (!agentGroupId || !sessionId) {
          throw new Error('host callers must pass --agent-group-id and --session-id');
        }
        return publishFile(containerPath, args.ttl as string | undefined, { agentGroupId, sessionId });
      },
    },
  },
});
