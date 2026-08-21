/**
 * Smoketest REPL — interactive harness.
 *
 *   tsx src/repl.ts
 *
 * Each typed line is POSTed to /inbound. SSE events stream to stdout in
 * colour. Special commands:
 *   /scenario <name>    run a pre-canned scenario inline
 *   /sim <persona>      hand the wheel to a goal-directed sim user (one turn)
 *   /list               list available scenarios
 *   /quit               exit
 */
import readline from 'node:readline';

import { RealtimeClient } from './client.js';
import { Transcript } from './transcript.js';
import { SimulatedUser } from './simulated-user.js';
import { runScenario } from './scenarios/index.js';
import { allScenarios, getScenario } from './scenarios/registry.js';

const baseUrl = process.env.REALTIME_BASE_URL ?? 'http://127.0.0.1:8765';

async function main() {
  const transcript = new Transcript();
  const client = new RealtimeClient({
    baseUrl,
    onEvent: (e) => {
      const colour =
        e.kind === 'realtime-utterance'
          ? '\x1b[33m'   // yellow filler/narration
          : e.kind === 'chat'
            ? '\x1b[32m' // green back-mind reply
            : '\x1b[90m'; // grey other
      process.stdout.write(`${colour}[${e.kind}]\x1b[0m ${e.text}\n`);
      const source =
        e.kind === 'realtime-utterance' ? 'agent-utterance' : e.kind === 'chat' ? 'agent-chat' : 'agent-other';
      transcript.add(source, e.text, { kind: e.kind, sender: e.sender });
      // Re-prompt after agent output so the prompt isn't stranded mid-line.
      rl.prompt(true);
    },
  });

  console.log(`[smoketest-repl] connecting to ${baseUrl}…`);
  await client.connect();
  console.log('[smoketest-repl] connected. Type your message, or /list to see scenarios. /quit to exit.');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\x1b[1myou>\x1b[0m ',
  });
  rl.prompt();

  rl.on('line', async (raw) => {
    const line = raw.trim();
    if (!line) {
      rl.prompt();
      return;
    }
    if (line === '/quit') {
      rl.close();
      return;
    }
    if (line === '/list') {
      console.log('available scenarios: ' + allScenarios().map((s) => s.name).join(', '));
      rl.prompt();
      return;
    }
    if (line.startsWith('/scenario ')) {
      const name = line.slice('/scenario '.length).trim();
      const s = getScenario(name);
      if (!s) {
        console.log(`[smoketest-repl] unknown scenario: ${name}`);
        rl.prompt();
        return;
      }
      console.log(`[smoketest-repl] running scenario: ${name}`);
      const user = s.user ? new SimulatedUser({ ...s.user }) : null;
      const r = await runScenario(s, { client, transcript, user });
      console.log(`[smoketest-repl] scenario ${r.passed ? 'PASS' : 'FAIL'} in ${r.durationMs}ms`);
      rl.prompt();
      return;
    }
    if (line.startsWith('/sim ')) {
      const persona = line.slice('/sim '.length).trim();
      const user = new SimulatedUser({ persona, goal: 'continue the conversation as this persona', maxTurns: 1 });
      const resp = await user.respondTo(transcript.all());
      if (resp.type === 'end') {
        console.log(`[smoketest-repl] sim ended: ${resp.reason}`);
      } else {
        console.log(`\x1b[36m[sim user]\x1b[0m ${resp.text}`);
        transcript.add('user', resp.text, { source: 'sim-user' });
        await client.postTurn(resp.text, 'smoke-test-sim').catch((err: Error) => {
          console.error('[smoketest-repl] post failed:', err.message);
        });
      }
      rl.prompt();
      return;
    }
    // Plain user turn.
    transcript.add('user', line, { source: 'repl' });
    try {
      const r = await client.postTurn(line, 'smoke-test-repl');
      if (r.classification) {
        console.log(`\x1b[90m[classified=${r.classification}, spoke=${r.spoke}]\x1b[0m`);
      }
    } catch (err) {
      console.error('[smoketest-repl] post failed:', (err as Error).message);
    }
    rl.prompt();
  });

  rl.on('close', () => {
    client.close();
    console.log('\n[smoketest-repl] bye');
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
