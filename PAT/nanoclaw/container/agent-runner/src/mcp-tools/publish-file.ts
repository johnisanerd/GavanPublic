/**
 * PAT: publish_file MCP tool — publish a workspace file to a public,
 * signed, EXPIRING URL the agent can hand to anyone.
 *
 * Wire-up: unlike the fire-and-forget messages_out tools, this needs the
 * minted URL back synchronously, so it shells out to the in-container `ncl`
 * (the session-DB CLI transport — the one synchronous host RPC), calling the
 * host-side `files publish` custom op (nanoclaw/src/cli/resources/files.ts →
 * src/modules/file-publish/). The host resolves the path against THIS
 * session's own mounts (trusted CallerContext, not tool args), copies the
 * file out, and mints the signed URL.
 */
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

interface PublishData {
  name: string;
  url: string;
  expires_at: string;
  size_bytes: number;
}

export const publishFile: McpToolDefinition = {
  tool: {
    name: 'publish_file',
    description:
      'Publish a file from your workspace to a public, signed, EXPIRING URL — ' +
      'use this when you need to share a file with someone and there is no ' +
      'attachment mechanism on the channel (or the file is too big to attach). ' +
      'Returns the URL immediately; send it to the user like any link. ' +
      'The URL needs no login and works for anyone who has it, but it cannot be ' +
      'guessed or forged, and it stops working after the expiry (default 24h, ' +
      'min 1h, max 7 days). The published copy is a snapshot — later edits to ' +
      'the workspace file do NOT update the published version (publish again ' +
      'for a fresh link). Do not publish secrets, credentials, or private data ' +
      'belonging to one person when the link will be shared with another.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_path: {
          type: 'string',
          description:
            'Path of the file to publish — absolute container path ' +
            '(/workspace/agent/report.pdf) or relative to your agent dir ' +
            '(report.pdf). Must be inside your workspace.',
        },
        expires_in: {
          type: 'string',
          description:
            'How long the link stays live: "24h", "3d", "7d", or a number of ' +
            'hours. Default 24h; clamped to [1h, 7d].',
        },
      },
      required: ['file_path'],
    },
  },
  async handler(args) {
    const filePath = args.file_path as string;
    const expiresIn = args.expires_in as string | undefined;
    if (!filePath) return err('file_path is required');

    const cmd = ['ncl', 'files', 'publish', '--path', filePath, '--json'];
    if (expiresIn) cmd.push('--ttl', expiresIn);

    let stdout: string;
    try {
      const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
      const timeout = setTimeout(() => proc.kill(), 35_000);
      stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      clearTimeout(timeout);
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        return err(`publish failed: ${(stderr || stdout).trim().slice(0, 500)}`);
      }
    } catch (e) {
      return err(`publish failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    let frame: { ok: boolean; data?: PublishData; error?: { message: string } };
    try {
      frame = JSON.parse(stdout);
    } catch {
      return err(`publish returned unparseable output: ${stdout.trim().slice(0, 300)}`);
    }
    if (!frame.ok || !frame.data) {
      return err(`publish failed: ${frame.error?.message ?? 'unknown error'}`);
    }

    const { url, expires_at, size_bytes } = frame.data;
    return ok(`Published (${Math.max(1, Math.round(size_bytes / 1024))} KB). Link expires ${expires_at}.\n${url}`);
  },
};

registerTools([publishFile]);
