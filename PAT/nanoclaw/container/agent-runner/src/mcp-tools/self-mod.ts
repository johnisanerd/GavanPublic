/**
 * Self-modification MCP tools: install_packages, add_mcp_server.
 *
 * Both are fire-and-forget — the tool writes a system action row and returns
 * immediately. The host processes the request (including admin approval)
 * and notifies the agent via a chat message when complete. Admin approval
 * is approval to apply the change: `install_packages` auto-rebuilds the
 * per-agent image and restarts the container; `add_mcp_server` just
 * updates `container.json` and restarts (bun runs TS directly — no build
 * step needed for a pure MCP wiring change).
 *
 * Package names are sanitized here at the tool boundary AND re-validated on
 * the host side (defense in depth).
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

const APT_RE = /^[a-z0-9][a-z0-9._+-]*$/;
const NPM_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_PACKAGES = 20;

export const installPackages: McpToolDefinition = {
  tool: {
    name: 'install_packages',
    description:
      'Install apt and/or npm packages into YOUR per-agent container image. Requires admin approval; fire-and-forget. On approval, the image is rebuilt and the container is restarted automatically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        apt: {
          type: 'array',
          items: { type: 'string' },
          description: 'apt packages to install (names only, no version specs or flags)',
        },
        npm: {
          type: 'array',
          items: { type: 'string' },
          description: 'npm packages to install globally (names only, no version specs)',
        },
        reason: { type: 'string', description: 'Why these packages are needed' },
      },
    },
  },
  async handler(args) {
    const apt = (args.apt as string[]) || [];
    const npm = (args.npm as string[]) || [];
    if (apt.length === 0 && npm.length === 0) return err('At least one apt or npm package is required');
    if (apt.length + npm.length > MAX_PACKAGES) return err(`Maximum ${MAX_PACKAGES} packages per request`);

    const invalidApt = apt.find((p) => !APT_RE.test(p));
    if (invalidApt)
      return err(`Invalid apt package name: "${invalidApt}". Only lowercase letters, digits, and ._+- allowed.`);
    const invalidNpm = npm.find((p) => !NPM_RE.test(p));
    if (invalidNpm) return err(`Invalid npm package name: "${invalidNpm}". No version specs or shell characters.`);

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'install_packages',
        apt,
        npm,
        reason: (args.reason as string) || '',
      }),
    });

    log(`install_packages: ${requestId} → apt=[${apt.join(',')}] npm=[${npm.join(',')}]`);
    return ok(`Package install request submitted. You will be notified when admin approves or rejects.`);
  },
};

// PAT (S5, security): stdio MCP servers run unpinned `npx` code and can't use
// vault credential routing (secrets go cleartext in env) — a supply-chain
// surface. OFF by default; an operator opts in per-deployment with
// PAT_ALLOW_STDIO_MCP=1 (passed through to the container). Both the prompting
// (this description) and the handler gate on it.
const STDIO_ENABLED = process.env.PAT_ALLOW_STDIO_MCP === '1';

const ADD_MCP_DESCRIPTION =
  'Wire an EXISTING third-party MCP server into YOUR per-agent runtime config. ' +
  (STDIO_ENABLED
    ? 'Two transports: (1) remote/HTTP — the DEFAULT: pass `url` (e.g. https://mcp.example.com/mcp) + optional `headers`. '
    : 'Remote/HTTP only (stdio transport is DISABLED on this deployment): pass `url` (e.g. https://mcp.example.com/mcp) + optional `headers`. ') +
  "Most major MCP vendors offer a hosted endpoint — CHECK the vendor's docs/README (web search if unsure) " +
  'before concluding one does not exist; do not fall back to a remembered npx snippet. ' +
  (STDIO_ENABLED
    ? '(2) stdio (`command` + `args`) — LAST RESORT, only when you have VERIFIED there is no hosted endpoint: ' +
      'runtime `npx` executes unpinned code inside your container (supply-chain surface) and stdio cannot use ' +
      'vault credential routing. '
    : '') +
  'For a remote server that needs an API key, DO NOT put the key in `headers`. Instead pass `secret_name` — ' +
  'the canonical UNPREFIXED key name (e.g. `FOO_API_KEY`, never `AGENT_FOO_API_KEY`; the system derives the ' +
  'operator-facing prefixed name itself). This registers credential routing so the OneCLI vault injects the ' +
  "real key at the server's host at egress. The key value is supplied out-of-band by a human (the tool result " +
  'tells you exactly what to relay) — you never handle it. Requires admin approval; fire-and-forget.';

export const addMcpServer: McpToolDefinition = {
  tool: {
    name: 'add_mcp_server',
    description: ADD_MCP_DESCRIPTION,
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'MCP server name (unique identifier)' },
        url: { type: 'string', description: 'HTTP (streamable) endpoint URL — use this for a remote MCP server' },
        headers: {
          type: 'object',
          description: 'HTTP headers (http only). For auth, prefer `secret_name` over a real key here.',
        },
        secret_name: {
          type: 'string',
          description:
            'Canonical UNPREFIXED key name (e.g. FOO_API_KEY — never add the AGENT_ prefix yourself) for an authed ' +
            "remote server. Registers vault routing so the real key is injected at the server's host. The value is " +
            'added by a human, not you.',
        },
        auth_header: {
          type: 'string',
          description: 'Header the key goes in (default Authorization). Use with secret_name.',
        },
        auth_format: {
          type: 'string',
          description: "Value template (default 'Bearer {value}'). Use with secret_name.",
        },
        command: { type: 'string', description: 'Command to run a local stdio MCP server (stdio transport)' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command arguments (stdio transport)' },
        env: { type: 'object', description: 'Environment variables for the server (stdio transport)' },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    const name = args.name as string;
    const command = args.command as string | undefined;
    const url = args.url as string | undefined;
    const secretName = args.secret_name as string | undefined;
    if (!name) return err('name is required');
    if (!command && !url) return err('either `url` (remote/http) or `command` (stdio) is required');
    if (command && url) return err('provide `url` (http) OR `command` (stdio), not both');
    // PAT (S5, security): stdio disabled by default — reject at the boundary.
    if (command && !STDIO_ENABLED)
      return err(
        'stdio MCP servers are disabled on this deployment (supply-chain surface). Use a remote/http `url`, ' +
          'or ask an operator to enable stdio (PAT_ALLOW_STDIO_MCP=1).',
      );
    if (secretName && !url) return err('`secret_name` is for remote (http) servers — pass it with `url`');
    // PAT: secret_name is the canonical unprefixed key — the AGENT_ operator
    // prefix is derived by the system. AGENT_AGENT_FOO would silently never
    // resolve, so reject at the boundary.
    if (secretName && secretName.startsWith('AGENT_'))
      return err(`pass secret_name WITHOUT the AGENT_ prefix (use "${secretName.slice(6)}")`);

    const requestId = generateId();
    const payload: Record<string, unknown> = { action: 'add_mcp_server', name };
    let host: string | null = null;
    if (url) {
      payload.transport = 'http';
      payload.url = url;
      payload.headers = (args.headers as Record<string, string>) || {};
      if (secretName) {
        payload.secret_name = secretName;
        payload.auth_header = (args.auth_header as string) || 'Authorization';
        payload.auth_format = (args.auth_format as string) || 'Bearer {value}';
        try {
          host = new URL(url).host;
        } catch {
          /* host stays null; apply.ts re-derives/validates */
        }
      }
    } else {
      payload.command = command;
      payload.args = (args.args as string[]) || [];
      payload.env = (args.env as Record<string, string>) || {};
    }
    writeMessageOut({ id: requestId, kind: 'system', content: JSON.stringify(payload) });

    log(
      `add_mcp_server: ${requestId} → "${name}" (${url ? `http ${url}` : command})${secretName ? ` secret=${secretName}` : ''}`,
    );

    // Fire-and-forget: one request is enough. Nudge away from re-submitting /
    // reaching for ncl or a stdio duplicate, but don't be absolutist — a genuine
    // failure should still be surfaced, not assumed away.
    const doneRule =
      `Submitted for admin approval (fire-and-forget) — one request is enough; no need to re-submit ` +
      `or reach for another method (this tool is the whole job). The remaining step is a human adding ` +
      `the credential; surface that and wait for the approval.`;
    if (secretName) {
      // Self-guiding: tell the agent exactly what to relay to the human.
      // (Credential-gated activation: if the key isn't in the vault yet, the
      // approved MCP is PARKED and auto-activates when the credential lands —
      // no re-request, no manual restart.)
      return ok(
        `MCP server "${name}" submitted for admin approval. ${doneRule} ` +
          `If the key isn't in the vault yet, the approved server is parked and activates AUTOMATICALLY ` +
          `once the credential exists${host ? ` (vault injects it at ${host})` : ''}. ` +
          `Relay to the user: add **AGENT_${secretName}** = the API key to the deployment's .env.remote ` +
          `file and ship it with secrets-push (operator procedure) — nothing else is needed; ` +
          `a system message will confirm activation.`,
      );
    }
    return ok(`MCP server "${name}" submitted for admin approval. ${doneRule}`);
  },
};

registerTools([installPackages, addMcpServer]);
