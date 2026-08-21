/**
 * Smoketest CLI — the agentic smoke runner.
 *
 * Select what to run by CHANNEL and LEVEL, or by explicit test IDs/names.
 * Built to be trivially kicked off by a sub-agent shipping features: run it,
 * read machine-readable results, and for any failure follow the emitted
 * `patobs` log query straight to the evidence.
 *
 *   # by named suite (carries the transport; --call implicit for call suites)
 *   pnpm run smoke --suite=rest-thorough
 *   pnpm run smoke --suite=quick                    # rest+call+signal quick
 *
 *   # by channel + level
 *   pnpm run smoke --channel signal --level quick
 *   pnpm run smoke --channel rest,call --level thorough
 *   pnpm run smoke --level thorough                 # all channels, thorough
 *
 *   # by explicit test id (SID) or name — overrides channel/level
 *   pnpm run smoke R1 C1 S4
 *   pnpm run smoke publish-file
 *
 *   # discovery + machine output
 *   pnpm run smoke --list                           # the coverage matrix
 *   pnpm run smoke --channel signal --level thorough --json
 *
 * Flags: --suite=<name> --channel=<rest,call,signal> --level=<quick|thorough>
 *        --env=<staging|prod> (scopes the emitted log query; default staging)
 *        --json (machine-readable result summary) --list --stream
 *        --channel-probe=<name> (legacy dispatch-probe scenarios)
 *
 * Exits non-zero if any selected scenario fails.
 */
import { runOne, runAll } from './runner.js';
import type { ScenarioResult, SmokeChannel, SmokeTier } from './scenarios/index.js';
import { allScenarios, selectScenarios, selectSuite, suiteNames } from './scenarios/registry.js';
import { patobsQueryForResult, resultPointerLine } from './log-pointer.js';

// Value flags use the `--name=value` form ONLY. (Space form would make the
// value indistinguishable from a positional test-ID, e.g. `--channel rest S4`
// → is `rest` the channel value or a test id? The `=` form removes the
// ambiguity so every bare arg is unambiguously a test id/name.)
function flagValue(args: string[], name: string): string | undefined {
  const withEq = args.find((a) => a.startsWith(`--${name}=`));
  return withEq ? withEq.slice(name.length + 3) : undefined;
}

function printList(): void {
  const rows = allScenarios()
    .map((s) => ({ sid: s.sid ?? '—', channel: s.channel ?? 'rest', tiers: (s.tiers ?? []).join('+') || '—', name: s.name }))
    .sort((a, b) => (a.channel + a.sid).localeCompare(b.channel + b.sid));
  console.log('SID    CHANNEL  TIERS            NAME');
  for (const r of rows) {
    console.log(`${r.sid.padEnd(6)} ${r.channel.padEnd(8)} ${r.tiers.padEnd(16)} ${r.name}`);
  }
  console.log(`\nSUITES (--suite=<name>): ${suiteNames().join(', ')}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    printList();
    process.exit(0);
  }

  const stream = args.includes('--stream');
  const json = args.includes('--json');
  const channelProbe = flagValue(args, 'channel-probe');
  const env = (flagValue(args, 'env') as 'staging' | 'prod') ?? 'staging';

  const channels = (flagValue(args, 'channel')?.split(',').map((c) => c.trim()).filter(Boolean) ?? []) as SmokeChannel[];
  const level = flagValue(args, 'level') as SmokeTier | undefined;
  const suite = flagValue(args, 'suite');
  const ids = args.filter((a) => !a.startsWith('--'));

  let scenarios;
  try {
    // Precedence: explicit ids > --suite > channel/level.
    scenarios =
      ids.length > 0
        ? selectScenarios({ ids })
        : suite
          ? selectSuite(suite)
          : selectScenarios({ channels, tier: level });
  } catch (err) {
    console.error(`[smoke] ${(err as Error).message}`);
    if (suite) console.error(`[smoke] suites: ${suiteNames().join(', ')}`);
    console.error(`[smoke] run \`pnpm run smoke --list\` to see available tests.`);
    process.exit(2);
  }
  if (scenarios.length === 0) {
    const how = suite ? `suite=${suite}` : `channels=${channels.join(',') || 'all'} level=${level ?? 'quick'}`;
    console.error(`[smoke] no scenarios matched (${how}).`);
    if (suite?.startsWith('signal')) console.error(`[smoke] note: signal-* suites are empty while the rig transport is parked (see KNOWN_ISSUES).`);
    console.error(`[smoke] run \`pnpm run smoke --list\` to see the matrix + suites.`);
    process.exit(2);
  }

  // A scenario's channel decides its transport: `call` scenarios need the
  // Cartesia WS. rest/signal don't (signal drives the rig inside customRun).
  const anyCall = scenarios.some((s) => s.channel === 'call');
  const sel = suite
    ? `suite=${suite}`
    : `channels=${channels.join(',') || 'all'} level=${level ?? (ids.length ? 'explicit' : 'quick')}`;
  if (!json) console.log(`[smoke] ${sel} → ${scenarios.length} test(s): ${scenarios.map((s) => s.sid ?? s.name).join(', ')}`);

  const results: ScenarioResult[] =
    scenarios.length === 1
      ? [await runOne(scenarios[0]!, { streamToStdout: stream, call: scenarios[0]!.channel === 'call', channelProbe })]
      : (await runAll(scenarios, { streamToStdout: stream, call: anyCall, channelProbe })).results;

  const failed = results.filter((r) => !r.passed).length;

  if (json) {
    console.log(
      JSON.stringify(
        {
          selection: { channels, level: level ?? null, ids, env },
          passed: results.length - failed,
          failed,
          results: results.map((r) => ({
            sid: r.scenario.sid ?? null,
            name: r.scenario.name,
            channel: r.scenario.channel ?? 'rest',
            passed: r.passed,
            durationMs: r.durationMs,
            failures: r.outcomes
              .filter((o) => !o.ok)
              .map((o) => ({ step: o.step.kind, details: o.details ?? null, error: o.error ?? null })),
            inspect: patobsQueryForResult(r, { env }),
          })),
        },
        null,
        2,
      ),
    );
  } else {
    for (const r of results) {
      printOutcome(r);
      // Emit the exact log pointer for any failure (and once for the whole
      // run so a passing run is still inspectable if you want the trace).
      if (!r.passed) console.log(resultPointerLine(r, { env }));
    }
    console.log(`\n[smoke] ${results.length - failed} passed, ${failed} failed`);
    if (failed > 0) console.log(`[smoke] inspect a failure with the \`↳ inspect:\` query above (see /pat-logs skill).`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

function printOutcome(r: ScenarioResult): void {
  const tag = r.passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`\n${tag} ${r.scenario.sid ? `[${r.scenario.sid}] ` : ''}${r.scenario.name}  (${r.durationMs}ms)`);
  for (const o of r.outcomes) {
    const tick = o.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    let line = `  ${tick} ${o.step.kind}`;
    if (o.details) line += ` — ${o.details.slice(0, 80)}`;
    if (o.error) line += ` — \x1b[31m${o.error.slice(0, 100)}\x1b[0m`;
    if (o.judgeVerdict) line += ` — ${o.judgeVerdict.passed ? 'PASS' : 'FAIL'}: ${o.judgeVerdict.reason.slice(0, 100)}`;
    console.log(line);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
