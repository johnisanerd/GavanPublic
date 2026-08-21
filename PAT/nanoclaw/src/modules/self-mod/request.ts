/**
 * Delivery-action handlers for agent-initiated self-modification requests.
 *
 * Two actions the container can write into messages_out (via the self-mod
 * MCP tools): install_packages, add_mcp_server. Each one validates input
 * and queues an approval request. The admin's approval triggers the
 * matching approval handler in ./apply.ts, which also performs the
 * required follow-up (rebuild+restart for install_packages, restart-only
 * for add_mcp_server).
 *
 * Host-side sanitization for install_packages is defense-in-depth — the MCP
 * tool validates first. Both layers matter: the DB row carries the payload
 * verbatim through to shell exec on apply.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';
import { hasAdminPrivilege } from '../permissions/db/user-roles.js';
// PAT: admin-bypass flag — when set, the agent's self-mod requests skip the
// approval card and apply directly. The flag is admin-set, so its presence is
// the admin's standing consent for an admin-managed deployment.
import { isAdminBypassEnabled } from '../permissions/command-gate.js';
import { applyAddMcpServer, applyInstallPackages } from './apply.js';
import { preflightMcpUrl } from './url-preflight.js';

// PAT: supply-chain context for the approver — how fresh is each requested npm
// package's latest version? A just-published version is the classic
// compromised-package window; the container-side cooldown (container/Dockerfile,
// one week) refuses it at install time anyway, so the card should say so up
// front. Annotation only — never blocks; a dead registry just skips it.
async function npmPackageAgeNote(pkgs: string[]): Promise<string> {
  const notes: string[] = [];
  for (const p of pkgs.slice(0, 8)) {
    try {
      const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(p)}`, {
        signal: AbortSignal.timeout(4_000),
      });
      if (!res.ok) continue;
      const meta = (await res.json()) as { 'dist-tags'?: { latest?: string }; time?: Record<string, string> };
      const latest = meta['dist-tags']?.latest;
      const published = latest ? meta.time?.[latest] : undefined;
      if (!latest || !published) continue;
      const days = Math.floor((Date.now() - Date.parse(published)) / 86_400_000);
      // Backticks: the card renders with Telegram legacy Markdown — raw @/_ in
      // package names break entity parsing (same bug as the add-mcp card).
      notes.push(
        `\`${p}@${latest}\` published ${days}d ago${days < 7 ? ' — ⚠️ inside the 7d cooldown, install will be refused' : ''}`,
      );
    } catch {
      /* registry unreachable — skip the annotation, never block the card */
    }
  }
  return notes.length > 0 ? `\n${notes.join('\n')}` : '';
}

export async function handleInstallPackages(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'install_packages failed: agent group not found.');
    return;
  }

  const apt = (content.apt as string[]) || [];
  const npm = (content.npm as string[]) || [];
  const reason = (content.reason as string) || '';

  const APT_RE = /^[a-z0-9][a-z0-9._+-]*$/;
  const NPM_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
  const MAX_PACKAGES = 20;
  if (apt.length + npm.length === 0) {
    notifyAgent(session, 'install_packages failed: at least one apt or npm package is required.');
    return;
  }
  if (apt.length + npm.length > MAX_PACKAGES) {
    notifyAgent(session, `install_packages failed: max ${MAX_PACKAGES} packages per request.`);
    return;
  }
  const invalidApt = apt.find((p) => !APT_RE.test(p));
  if (invalidApt) {
    notifyAgent(session, `install_packages failed: invalid apt package name "${invalidApt}".`);
    log.warn('install_packages: invalid apt package rejected', { pkg: invalidApt });
    return;
  }
  const invalidNpm = npm.find((p) => !NPM_RE.test(p));
  if (invalidNpm) {
    notifyAgent(session, `install_packages failed: invalid npm package name "${invalidNpm}".`);
    log.warn('install_packages: invalid npm package rejected', { pkg: invalidNpm });
    return;
  }

  const packageList = [...apt.map((p) => `apt: ${p}`), ...npm.map((p) => `npm: ${p}`)].join(', ');

  // PAT (security): admin-bypass — apply directly ONLY when the flag is set AND
  // the REQUESTER is themselves an admin/owner (session.user_id is the sender
  // bound at session creation). This gated on "an admin exists anywhere"
  // before, so any member could trigger an auto-applied self-mod. Mirrors
  // sender-approval.ts. Fail-closed when user_id is unknown.
  if (isAdminBypassEnabled() && !!session.user_id && hasAdminPrivilege(session.user_id, session.agent_group_id)) {
    log.info('install_packages — admin bypass auto-applying', {
      agentGroupId: session.agent_group_id,
      sessionId: session.id,
      apt,
      npm,
    });
    await applyInstallPackages({
      session,
      payload: { apt, npm, reason },
      userId: 'admin-bypass',
      notify: (text) => notifyAgent(session, text),
    });
    return;
  }

  const ageNote = npm.length > 0 ? await npmPackageAgeNote(npm) : '';
  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'install_packages',
    payload: { apt, npm, reason },
    title: 'Install Packages Request',
    question: `Agent "${agentGroup.name}" is attempting to install a package + rebuild container:\n${packageList}${reason ? `\nReason: ${reason}` : ''}${ageNote}`,
  });
}

export async function handleAddMcpServer(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'add_mcp_server failed: agent group not found.');
    return;
  }
  const serverName = content.name as string;
  const command = content.command as string | undefined;
  const url = content.url as string | undefined;
  if (!serverName || (!command && !url)) {
    notifyAgent(session, 'add_mcp_server failed: name and either url (remote/http) or command (stdio) are required.');
    return;
  }
  // PAT: preflight the endpoint BEFORE spending an approval card on it. A
  // definite 404/405 means the path isn't an MCP endpoint (the apify /mcp-vs-
  // root incident); anything else — incl. 401, which just means "needs the
  // key the vault will inject" — proceeds. See url-preflight.ts (SSRF guard).
  if (url) {
    const pf = await preflightMcpUrl(url);
    if (pf.verdict === 'wrong-path') {
      notifyAgent(
        session,
        `add_mcp_server failed: an MCP initialize probe of ${url} returned HTTP ${pf.status} — ` +
          `that path is likely wrong (vendors differ: some serve MCP at the root, some at /mcp). ` +
          `Check the vendor's docs for the exact endpoint and resubmit.`,
      );
      log.warn('add_mcp_server: url failed preflight', { name: serverName, url, status: pf.status });
      return;
    }
  }
  // PAT: forward http (remote) fields through to the approval payload so
  // applyAddMcpServer sees them — was stdio-only, which silently dropped url/
  // secret_name/auth_* and made the remote path impossible.
  const payload: Record<string, unknown> = url
    ? {
        name: serverName,
        transport: 'http',
        url,
        ...(content.secret_name ? { secret_name: content.secret_name } : {}),
        ...(content.auth_header ? { auth_header: content.auth_header } : {}),
        ...(content.auth_format ? { auth_format: content.auth_format } : {}),
        ...(content.headers ? { headers: content.headers } : {}),
      }
    : {
        name: serverName,
        command,
        args: (content.args as string[]) || [],
        env: (content.env as Record<string, string>) || {},
      };

  // PAT: admin-bypass — see install_packages above for rationale.
  if (isAdminBypassEnabled() && !!session.user_id && hasAdminPrivilege(session.user_id, session.agent_group_id)) {
    log.info('add_mcp_server — admin bypass auto-applying', {
      agentGroupId: session.agent_group_id,
      sessionId: session.id,
      name: serverName,
    });
    await applyAddMcpServer({
      session,
      payload,
      userId: 'admin-bypass',
      notify: (text) => notifyAgent(session, text),
    });
    return;
  }

  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'add_mcp_server',
    payload,
    title: 'Add MCP Request',
    // NOTE: this text is rendered by the Telegram approval card with legacy
    // Markdown, so unescaped `_`/`*` (e.g. AGENT_FOO_API_KEY) break entity parsing
    // and the send throws ValidationError. Wrap dynamic values in backticks (code
    // spans render literally). Root fix (sanitize card questions per-channel) is
    // backlogged. See sprint/backlog.md.
    question:
      `Agent "${agentGroup.name}" is attempting to add a new MCP server:\n` +
      `${serverName} (${url ? `remote: \`${url}\`` : command})` +
      `${content.secret_name ? ` — key \`AGENT_${content.secret_name as string}\`` : ''}`,
  });
}
