/**
 * MCP tools barrel — imports each tool module for its side-effect
 * `registerTools([...])` call, then starts the MCP server.
 *
 * Adding a new tool module: create the file, call `registerTools([...])`
 * at module scope, and append the import here. No central list.
 */
import './core.js';
import './scheduling.js';
import './interactive.js';
import './agents.js';
import './self-mod.js';
// PAT (task #15): send_voice_memo MCP tool — Cartesia Sonic TTS →
// Signal voice note. Host handler in src/modules/voice-memo.ts.
import './voice-memo.js';
// PAT (presenter): MCP tools for driving the pat-web slide iframe
// (start/end_presentation, present_advance/resume/get_slide/inject_slide).
// Auto-loaded for every container; only useful when the agent group has
// a packet/ at /workspace/agent/, but registration is harmless otherwise.
import './present.js';
// PAT (Phase 2): conversation recall — list_conversations / fetch_conversation.
// Host handler in nanoclaw/src/conversations/recall-action.ts.
import './recall.js';
// PAT: publish_file — signed expiring public file URLs. Synchronous via the
// in-container ncl transport; host side in src/modules/file-publish/.
import './publish-file.js';
import { startMcpServer } from './server.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

startMcpServer().catch((err) => {
  log(`MCP server error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
