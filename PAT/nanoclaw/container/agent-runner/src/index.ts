/**
 * NanoClaw Agent Runner v2
 *
 * Runs inside a container. All IO goes through the session DB.
 * No stdin, no stdout markers, no IPC files.
 *
 * Config is read from /workspace/agent/container.json (mounted RO).
 * Only TZ and OneCLI networking vars come from env.
 *
 * Mount structure:
 *   /workspace/
 *     inbound.db        ← host-owned session DB (container reads only)
 *     outbound.db       ← container-owned session DB
 *     .heartbeat        ← container touches for liveness detection
 *     outbox/           ← outbound files
 *     agent/            ← agent group folder (CLAUDE.md, container.json, working files)
 *       container.json  ← per-group config (RO nested mount)
 *     global/           ← shared global memory (RO)
 *   /app/src/           ← shared agent-runner source (RO)
 *   /app/skills/        ← shared skills (RO)
 *   /home/node/.claude/ ← Claude SDK state + skill symlinks (RW)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig } from './config.js';
import { buildSystemPromptAddendum } from './destinations.js';
import { ensureMemoryScaffold } from './memory-scaffold.js';
// Providers barrel — each enabled provider self-registers on import.
// Provider skills append imports to providers/index.ts.
import './providers/index.js';
import { createProvider, type ProviderName } from './providers/factory.js';
import { runPollLoop } from './poll-loop.js';

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

const CWD = '/workspace/agent';

async function main(): Promise<void> {
  const config = loadConfig();
  const providerName = config.provider.toLowerCase() as ProviderName;

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  // Runtime-generated system-prompt addendum: agent identity (name) plus
  // the live destinations map. Everything else (capabilities, per-module
  // instructions, per-channel formatting) is loaded by Claude Code from
  // /workspace/agent/CLAUDE.md — the composed entry imports the shared
  // base (/app/CLAUDE.md) and each enabled module's fragment. Per-group
  // memory lives in /workspace/agent/CLAUDE.local.md (auto-loaded).
  const instructions = buildSystemPromptAddendum(config.assistantName || undefined);

  // Discover additional directories mounted at /workspace/extra/*
  const additionalDirectories: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        additionalDirectories.push(fullPath);
      }
    }
    if (additionalDirectories.length > 0) {
      log(`Additional directories: ${additionalDirectories.join(', ')}`);
    }
  }

  // MCP server path — bun runs TS directly; no tsc build step in-image.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'mcp-tools', 'index.ts');

  // PAT: discriminated union — entries either carry stdio
  // command/args/env or http url/headers. The provider layer
  // (providers/claude.ts) translates this into the SDK shape.
  type McpServerEntry =
    | { transport?: 'stdio'; command: string; args: string[]; env: Record<string, string> }
    | { transport: 'http'; url: string; headers?: Record<string, string> };

  // Build MCP servers config: nanoclaw built-in (stdio) + always-on
  // remote servers (apify) + any from container.json.
  const mcpServers: Record<string, McpServerEntry> = {
    nanoclaw: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: {},
    },
    // PAT: Apify MCP disabled 2026-05-26 — sequential HTTPS round-trip
    // to mcp.apify.com during SDK cold start adds seconds of latency
    // for tools the voice agent rarely uses. Re-enable with a ?actors=
    // filter when needed (see sprint/backlog.md).
    // apify: {
    //   transport: 'http',
    //   url: 'https://mcp.apify.com',
    // },
    // PAT: Firecrawl MCP — web scraping, search, crawl, extract.
    // stdio transport (local subprocess, no network round-trip on init).
    //
    // Auth: we do NOT have a real FIRECRAWL_API_KEY in container env — keys are
    // OneCLI-vault-only by policy. firecrawl-mcp refuses to start on an empty
    // key, so we hand it a non-empty PLACEHOLDER. It then sends
    // `Authorization: Bearer <placeholder>` to api.firecrawl.dev, and the
    // OneCLI gateway (HTTPS_PROXY) OVERWRITES that header with the real vault
    // key by host-match before the request leaves the machine. Verified on
    // staging 2026-06-19: a bogus bearer through the agent proxy succeeds where
    // the same bogus bearer sent direct returns "Unauthorized: Invalid token".
    // A real key in env (if ever set) still wins via ??.
    firecrawl: {
      command: 'firecrawl-mcp',
      args: [],
      env: {
        FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY || 'fc-onecli-gateway-managed',
      },
    },
  };

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    if ('transport' in serverConfig && serverConfig.transport === 'http') {
      mcpServers[name] = {
        transport: 'http',
        url: serverConfig.url,
        headers: serverConfig.headers,
      };
      log(`Additional MCP server: ${name} (http → ${serverConfig.url})`);
    } else {
      mcpServers[name] = {
        command: serverConfig.command,
        args: serverConfig.args ?? [],
        env: serverConfig.env ?? {},
      };
      log(`Additional MCP server: ${name} (${serverConfig.command})`);
    }
  }

  const provider = createProvider(providerName, {
    assistantName: config.assistantName || undefined,
    mcpServers,
    env: { ...process.env },
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
    model: config.model,
    effort: config.effort,
  });

  // Providers that lack native memory opt in via `usesMemoryScaffold`; for them
  // the runner creates a persistent memory/ tree in its host-backed workspace at
  // boot (idempotent). Default off — the trunk default (Claude) omits the flag
  // and keeps its native memory untouched.
  if (provider.usesMemoryScaffold) ensureMemoryScaffold();

  await runPollLoop({
    provider,
    providerName,
    cwd: CWD,
    systemContext: { instructions },
  });
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
