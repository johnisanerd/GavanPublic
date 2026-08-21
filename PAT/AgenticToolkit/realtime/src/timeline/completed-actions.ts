/**
 * `<completed_actions>` XML emitter.
 *
 * When the back-mind is invoked on a follow-up turn, the host stamps a
 * `<completed_actions>` block into the inbound message — read-only view
 * of what ACTUALLY played from any prior timeline. The agent reasons
 * about what was said vs cut off, computes durations, distinguishes
 * partial-vs-complete states. Same XML vocabulary the agent already
 * emits, just in receive direction.
 *
 * Spec: `plans/timeline-runtime-and-scenarios.md` §3.6.5 + §3.6.6.
 *
 * Phase 2's orchestrator wires this into the inbox-forward path. This
 * file is pure (no I/O, no logger dep) so it can be exercised in
 * isolation by unit tests and trace-e2e replay tooling.
 *
 * Wire shape produced (interrupted example):
 *   <inbox now="01:36:12Z">
 *     <completed_actions reason="interrupted">
 *       <next_fragment ts_start="01:35:40Z" ts_end="01:35:40Z"/>
 *       <say ts_start="01:35:40Z" ts_end="01:35:43Z">First bullet.</say>
 *       <say ts_start="01:35:47Z" partial="true">Second bullet was cut—</say>
 *     </completed_actions>
 *   </inbox>
 *
 * Time format: short ISO 8601 UTC time-only (`HH:MM:SSZ`) per the plan,
 * since multi-day sessions are vanishingly rare. If the `nowMs` wrapper
 * crosses midnight from the earliest action's `ts_start_ms`, we fall
 * back to the full `YYYY-MM-DDTHH:MM:SSZ` form on the inbox wrapper
 * so the agent can compute durations across the boundary.
 */

/** Input shape for one already-played action. Phase 2 builds this from
 *  the sequencer's in-flight `CompletedActionRecord` (in `types.ts`),
 *  which carries more runtime detail — this slim shape keeps the
 *  emitter pure and testable without a sequencer instance. */
export interface CompletedAction {
  /** Action kind — becomes the XML tag name (e.g. `say`, `next_fragment`,
   *  `pause`, `tool`). ASCII-only per the spec; not escaped at render. */
  kind: string;
  /** ms since epoch when dispatch began. */
  ts_start_ms: number;
  /** ms since epoch when the completion signal fired. Omit when the
   *  action was cancelled mid-flight (set `partial: true` instead). */
  ts_end_ms?: number;
  /** Spoken text for `<say>` actions. For partial says, this is the
   *  prefix captured before the cancel signal arrived. Renders as the
   *  tag's child content, XML-escaped. */
  text?: string;
  /** Tag-specific attributes to round-trip on non-`say` actions
   *  (e.g. `{ms: 300}` on `<pause>`, `{n: 4}` on `<goto_slide>`).
   *  Keys are ASCII; values are coerced to strings and rendered after
   *  the time stamps. */
  attrs?: Record<string, string | number | boolean>;
  /** True iff the action was cancelled mid-flight. The renderer omits
   *  `ts_end` and writes `partial="true"`. The plan calls for this
   *  ONLY on the final action of an interrupted timeline; the emitter
   *  doesn't enforce that — callers shape the array correctly. */
  partial?: boolean;
}

export interface RenderCompletedActionsArgs {
  actions: CompletedAction[];
  reason: 'completed' | 'interrupted';
  /** ms timestamp for the inbox `now=` wrapper. Defaults to Date.now().
   *  Used here only to decide the wrapper's time format (short vs full
   *  ISO) — the actual wrapper is rendered by `renderInboxWrapper`. */
  nowMs?: number;
}

/** Render the `<completed_actions reason="...">...</completed_actions>`
 *  block. Returns '' when the input array is empty so callers can skip
 *  cleanly. The wrapping `<inbox now=...>` is NOT included — use
 *  `renderInboxWrapper` (or the convenience
 *  `renderInboxWithCompletedActions`) to add it. */
export function renderCompletedActions(args: RenderCompletedActionsArgs): string {
  if (args.actions.length === 0) return '';

  const inner = args.actions.map((a) => renderOneAction(a)).join('\n');
  return `<completed_actions reason="${args.reason}">\n${inner}\n</completed_actions>`;
}

/** Render the `<inbox now="...">` open + `</inbox>` close as a pair the
 *  caller can wrap arbitrary inbound content with. The `now=` attribute
 *  is short ISO (`HH:MM:SSZ`) by default; if any provided `actions` lie
 *  on a different UTC day than `nowMs`, the wrapper switches to the
 *  full `YYYY-MM-DDTHH:MM:SSZ` form so the agent can subtract across
 *  the midnight boundary unambiguously. */
export function renderInboxWrapper(args: {
  nowMs: number;
  actions?: CompletedAction[];
}): { open: string; close: string } {
  const needsFull = spansUtcMidnight(args.nowMs, args.actions ?? []);
  const stamp = needsFull
    ? formatDateTimeIso8601(args.nowMs)
    : formatTimeIso8601Short(args.nowMs);
  return { open: `<inbox now="${stamp}">`, close: '</inbox>' };
}

/** Convenience: render the full
 *  `<inbox now="..."><completed_actions reason="...">...</completed_actions></inbox>`
 *  string in one call. Returns '' when there are no actions (caller can
 *  decide whether to omit the wrapper entirely or stamp `<inbox now=...>`
 *  on its own via `renderInboxWrapper`). */
export function renderInboxWithCompletedActions(args: RenderCompletedActionsArgs): string {
  if (args.actions.length === 0) return '';
  const nowMs = args.nowMs ?? Date.now();
  const { open, close } = renderInboxWrapper({ nowMs, actions: args.actions });
  const body = renderCompletedActions(args);
  return `${open}\n${body}\n${close}`;
}

/** Format a ms-since-epoch as the short `HH:MM:SSZ` UTC string the plan
 *  specifies for `ts_start` / `ts_end` / `now`. Exposed for unit-testability
 *  and for callers that want to stamp the same format on their own tags
 *  (e.g. trace tooling). */
export function formatTimeIso8601Short(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}Z`;
}

/** Format a ms-since-epoch as the full `YYYY-MM-DDTHH:MM:SSZ` UTC
 *  string. Used by `renderInboxWrapper` when the `now=` and earliest
 *  action span different UTC days. */
export function formatDateTimeIso8601(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}Z`
  );
}

// ─────────────────────────── Internals ─────────────────────────────

function renderOneAction(a: CompletedAction): string {
  const startStamp = `ts_start="${formatTimeIso8601Short(a.ts_start_ms)}"`;
  const endStamp =
    a.partial || a.ts_end_ms === undefined
      ? null
      : `ts_end="${formatTimeIso8601Short(a.ts_end_ms)}"`;
  const partialAttr = a.partial ? `partial="true"` : null;

  const stampParts = [startStamp, endStamp, partialAttr].filter((s): s is string => s !== null);

  // Tag-specific attrs — rendered after the timestamp triplet for
  // consistency with the plan's example output. ASCII keys + coerced
  // values; no attribute-value escaping beyond `"` substitution since
  // tag names and attribute keys are ASCII-only per the spec.
  const extraAttrs: string[] = [];
  if (a.attrs) {
    for (const [k, v] of Object.entries(a.attrs)) {
      extraAttrs.push(`${k}="${escapeAttrValue(String(v))}"`);
    }
  }

  const allAttrs = [...stampParts, ...extraAttrs].join(' ');

  // `<say>` is the only base action that carries body text. Other
  // actions are self-closing — the timestamps are the payload.
  if (a.kind === 'say') {
    const body = a.text !== undefined ? escapeXmlText(a.text) : '';
    return `<say ${allAttrs}>${body}</say>`;
  }
  return `<${a.kind} ${allAttrs}/>`;
}

/** True if `nowMs` and the earliest action's `ts_start_ms` fall on
 *  different UTC dates. When true, the inbox wrapper switches to the
 *  full date-stamp form. */
function spansUtcMidnight(nowMs: number, actions: CompletedAction[]): boolean {
  if (actions.length === 0) return false;
  const earliest = actions.reduce((min, a) => (a.ts_start_ms < min ? a.ts_start_ms : min), nowMs);
  return utcDateKey(earliest) !== utcDateKey(nowMs);
}

function utcDateKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** XML-escape text destined for an element body — `&`, `<`, `>`. We do
 *  NOT escape `"` here; that's an attribute concern, handled separately. */
function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Minimal attribute-value escape for round-tripped action attrs.
 *  Quote char + `<`, `&` are the only XML-significant chars inside an
 *  attribute value. We coerce values to string upstream so a NaN/Infinity
 *  number renders without surprise. */
function escapeAttrValue(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}
