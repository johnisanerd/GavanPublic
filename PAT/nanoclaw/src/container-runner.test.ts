import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// PAT: mock the structured logger so we can assert the host re-emit shape without
// a real log sink.
vi.mock('./log.js', () => ({
  log: { event: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
import { log } from './log.js';
import { resolveProviderName, reEmitContainerStderrEvent } from './container-runner.js';

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

describe('buildContainerArgs ordering invariant (structural)', () => {
  // The OneCLI gateway apply (SDK applyContainerConfig) appends credential-stub
  // mounts — e.g. the codex auth.json sentinel nested INSIDE our RW
  // /home/node/.codex mount. Docker applies binds in argument order, so the
  // stub must land AFTER its parent mount or the parent shadows it and the
  // agent silently degrades to loginless auth. Driving the real
  // buildContainerArgs needs a live gateway + container runtime, so this
  // guards the invariant structurally: the gateway apply must appear after
  // the volume-mounts loop in the source.
  it('applies the OneCLI gateway after the volume mounts', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const mountsLoop = src.indexOf('for (const mount of mounts)');
    const gatewayApply = src.indexOf('onecli.applyContainerConfig');
    expect(mountsLoop).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(mountsLoop);
  });
});

describe('container boot-failure tripwire (structural)', () => {
  // A container that dies at boot (unknown provider, missing CLI binary, bad
  // config) explains itself only on stderr — which logs at debug, below the
  // default level. The spawn handler must keep a stderr tail and surface it
  // at warn on a non-zero exit, or the operator sees only "exited code 1" on
  // repeat. Driving a real failing spawn needs a container runtime, so this
  // guards the wiring structurally, matching the invariant test above.
  it('surfaces the stderr tail when the container exits non-zero', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('stderrTail.push(line)');
    expect(src).toMatch(/Container exited non-zero.*stderrTail/s);
  });
});

// PAT: behavioral test for the back-mind tool-call observability re-emit — the
// load-bearing parse-and-forward seam (agent.tool_use / agent.tool_result).
describe('reEmitContainerStderrEvent', () => {
  const SENTINEL = '@@PATEVENT@@';
  const session = { id: 'sess-1', thread_id: 'thr-1' } as never;
  const agentGroup = { id: 'ag-1' } as never;

  beforeEach(() => vi.clearAllMocks());

  it('re-emits a well-formed sentinel as a host event with authoritative ids', () => {
    const line = `${SENTINEL} ${JSON.stringify({
      kind: 'agent.tool_use',
      data: { tool: 'WebSearch', input_summary: 'q' },
    })}`;
    expect(reEmitContainerStderrEvent(line, session, agentGroup)).toBe(true);
    expect(log.event).toHaveBeenCalledTimes(1);
    expect(log.event).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'agent.tool_use',
        source: 'agent-runner',
        session_id: 'sess-1',
        thread_id: 'thr-1',
        data: expect.objectContaining({ tool: 'WebSearch', input_summary: 'q', agent_group_id: 'ag-1' }),
      }),
    );
  });

  it('passes any kind through generically (e.g. agent.tool_result with output)', () => {
    const line = `${SENTINEL} ${JSON.stringify({
      kind: 'agent.tool_result',
      data: { tool: 'WebSearch', ok: true, output_summary: 'r' },
    })}`;
    expect(reEmitContainerStderrEvent(line, session, agentGroup)).toBe(true);
    expect(log.event).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent.tool_result', data: expect.objectContaining({ ok: true }) }),
    );
  });

  it('ignores malformed JSON without throwing (best-effort)', () => {
    expect(reEmitContainerStderrEvent(`${SENTINEL} {not json`, session, agentGroup)).toBe(false);
    expect(log.event).not.toHaveBeenCalled();
  });

  it('ignores a sentinel payload with no kind', () => {
    expect(reEmitContainerStderrEvent(`${SENTINEL} ${JSON.stringify({ data: { x: 1 } })}`, session, agentGroup)).toBe(
      false,
    );
    expect(log.event).not.toHaveBeenCalled();
  });
});
