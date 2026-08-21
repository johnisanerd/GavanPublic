/**
 * Container config types and materialization.
 *
 * Source of truth is the `container_configs` table in the central DB.
 * This module provides:
 *   - Type definitions for the file shape (read by the container runner)
 *   - `materializeContainerJson()` — writes `groups/<folder>/container.json`
 *     from the DB at spawn time
 *   - `configFromDb()` — builds a `ContainerConfig` from a DB row + agent group
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { getContainerConfig } from './db/container-configs.js';
import { getAgentGroup } from './db/agent-groups.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

// PAT: extended for remote (streamable-HTTP) MCP servers — Apify, etc.
// Discriminated on `transport`. Stdio remains the default (transport
// omitted) so existing container.json files don't need migration.
//
// SDK-spelling gotcha: Claude Agent SDK exposes streamable-HTTP via
// `type: 'http'` in `@anthropic-ai/claude-agent-sdk/sdk.d.ts`
// (`McpHttpServerConfig`). There is no separate `'streamable-http'`
// variant in the SDK — `'http'` IS the streamable one. (OpenClaw's
// older validator does distinguish the two and silently drops plain
// `'http'`; that's a different system — see memory note
// `reference_pat_v0_2_integrations.md`.) We keep `transport: 'http'`
// here so the host schema matches the SDK shape one-to-one.
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export interface McpStdioServerConfig {
  /** Defaults to 'stdio' when omitted. */
  transport?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  instructions?: string;
  /** PAT: soft-delete tombstone. Kept in the DB so the staging↔prod promote can
   *  SEE a removal (vs. "never existed") and propagate it; skipped at materialize
   *  so the container never loads it. See plans/mcp-management.md. */
  deleted?: boolean;
}

export interface McpHttpServerConfig {
  transport: 'http';
  url: string;
  headers?: Record<string, string>;
  /** Same auto-fragment behavior as stdio. */
  instructions?: string;
  /** PAT: soft-delete tombstone — see McpStdioServerConfig.deleted. */
  deleted?: boolean;
}

export interface AdditionalMountConfig {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

/** Shape of the materialized `container.json` file read by the container runner. */
export interface ContainerConfig {
  mcpServers: Record<string, McpServerConfig>;
  packages: { apt: string[]; npm: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  skills: string[] | 'all';
  provider?: string;
  groupName?: string;
  assistantName?: string;
  agentGroupId?: string;
  maxMessagesPerPrompt?: number;
  model?: string;
  effort?: string;
}

/** Build a `ContainerConfig` from a DB row + agent group identity. */
export function configFromDb(row: ContainerConfigRow, group: AgentGroup): ContainerConfig {
  // PAT: drop soft-deleted (tombstoned) MCP entries — they persist in the DB for
  // the promote's deletion-detection, but must not be materialized into the container.
  const allMcp = JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
  const mcpServers = Object.fromEntries(Object.entries(allMcp).filter(([, cfg]) => !cfg.deleted));
  return {
    mcpServers,
    packages: {
      apt: JSON.parse(row.packages_apt) as string[],
      npm: JSON.parse(row.packages_npm) as string[],
    },
    imageTag: row.image_tag ?? undefined,
    additionalMounts: JSON.parse(row.additional_mounts) as AdditionalMountConfig[],
    skills: JSON.parse(row.skills) as string[] | 'all',
    provider: row.provider ?? undefined,
    groupName: group.name,
    assistantName: row.assistant_name ?? group.name,
    agentGroupId: group.id,
    maxMessagesPerPrompt: row.max_messages_per_prompt ?? undefined,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
  };
}

/**
 * Materialize `container.json` from the DB. Called at spawn time so the
 * container always sees fresh config. Returns the `ContainerConfig` for
 * use by the caller (buildMounts, buildContainerArgs, etc.).
 */
export function materializeContainerJson(agentGroupId: string): ContainerConfig {
  const group = getAgentGroup(agentGroupId);
  if (!group) throw new Error(`Agent group not found: ${agentGroupId}`);

  const row = getContainerConfig(agentGroupId);
  if (!row) throw new Error(`Container config not found for agent group: ${agentGroupId}`);

  const config = configFromDb(row, group);

  const p = path.join(GROUPS_DIR, group.folder, 'container.json');
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');

  return config;
}
