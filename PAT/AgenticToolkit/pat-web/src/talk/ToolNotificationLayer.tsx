/**
 * ToolNotificationLayer — notification-banner / "achievement"-style
 * ambient back-mind tool-call display.
 *
 * Replaces the older big-icon ToolIconLayer. Same SSE source
 * (`detail.row-received`), but rendered as a horizontal pill with an
 * icon at the left and a clean English label to the right — readable by
 * non-engineers, glanceable without breaking eye contact with Pat.
 *
 * Lifecycle per `tool_use_id`:
 *   - `tool-pre`     → banner appears with **present-tense** label
 *                      ("Searching the web…").
 *   - `tool-post` / `tool-failed` → label swaps to **past-tense**
 *                      ("Searched the web"), dismissal timer starts.
 *
 * Dismissal timing:
 *   - post arrived ≤500ms after pre → linger 2s (instant tool, brief).
 *   - longer        → linger clamp(2s + 0.3 × duration_s, 2s, 5s) after
 *                      the post.
 *
 * Stack rules:
 *   - max 4 visible. A 5th arrival evicts the oldest (with exit anim).
 *   - past-tense banners are "fading" and evicted first when new
 *     present-tense arrivals push the stack.
 *
 * Placement:
 *   - 'left' : anchored at left-middle of the stage. New banners
 *              slide in from off-left and settle at the anchor;
 *              older banners drift upward as new arrivals push them
 *              up. On dismissal they slide up a little further and
 *              fade out.
 *   - 'top'  : same motion vocabulary but anchored at top-center.
 *              New banners drop in from above; older ones drift down
 *              as new arrivals push them; dismissal slides them up
 *              and fades.
 *
 * The 'left' placement is the default — keeps the avatar's face area
 * unobstructed and reads naturally as ambient peripheral activity.
 */
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Bot,
  CheckSquare,
  FilePlus,
  FileText,
  Globe,
  LayoutTemplate,
  Pencil,
  Search,
  SearchCode,
  Send,
  Terminal,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { PatEvent, DetailRowReceived } from '@/types/log-events';

export type ToolBannerPlacement = 'left' | 'top';

/** Accepts a stored value that might be from a previous version of the
 *  placement enum and normalises it to the current set. */
export function normalizeBannerPlacement(v: unknown): ToolBannerPlacement {
  if (v === 'left' || v === 'top') return v;
  // Legacy values from older builds.
  if (v === 'upper-right') return 'top';
  if (v === 'behind-head') return 'top';
  return 'left';
}

interface ToolMeta {
  icon: LucideIcon;
  present: string;
  past: string;
}

/**
 * Tool name → {icon, present-tense label, past-tense label}. Falls back
 * to a {Wrench, "Working on something", "Did something"} entry when a
 * tool isn't in the table.
 *
 * Tool names match what nanoclaw emits in `data.tool` on
 * `detail.row-received`. MCP tools come through as full dotted names.
 */
const TOOL_META: Record<string, ToolMeta> = {
  Bash: { icon: Terminal, present: 'Running a command', past: 'Ran a command' },
  Read: { icon: FileText, present: 'Reading a file', past: 'Read a file' },
  Write: { icon: FilePlus, present: 'Writing a file', past: 'Wrote a file' },
  Edit: { icon: Pencil, present: 'Editing a file', past: 'Edited a file' },
  MultiEdit: { icon: Pencil, present: 'Editing files', past: 'Edited files' },
  NotebookEdit: { icon: Pencil, present: 'Editing a notebook', past: 'Edited a notebook' },
  WebFetch: { icon: Globe, present: 'Fetching from the web', past: 'Fetched from the web' },
  WebSearch: { icon: Search, present: 'Searching the web', past: 'Searched the web' },
  Grep: { icon: SearchCode, present: 'Searching the code', past: 'Searched the code' },
  Glob: { icon: SearchCode, present: 'Looking for files', past: 'Found some files' },
  Task: { icon: Bot, present: 'Spinning up a subagent', past: 'Subagent finished' },
  Agent: { icon: Bot, present: 'Spinning up a subagent', past: 'Subagent finished' },
  TaskCreate: { icon: CheckSquare, present: 'Adding to the plan', past: 'Plan updated' },
  TaskUpdate: { icon: CheckSquare, present: 'Updating the plan', past: 'Plan updated' },
  TaskStop: { icon: CheckSquare, present: 'Closing a task', past: 'Task closed' },
  TodoWrite: { icon: CheckSquare, present: 'Updating the plan', past: 'Plan updated' },
  mcp__nanoclaw__send_message: { icon: Send, present: 'Sending a message', past: 'Sent a message' },
  mcp__nanoclaw__send_card: { icon: LayoutTemplate, present: 'Sending a card', past: 'Sent a card' },
};

function metaFor(tool: string): ToolMeta {
  if (tool in TOOL_META) return TOOL_META[tool]!;
  // Same heuristic fallbacks as the old ToolIconLayer — keep MCP tools
  // somewhat-relevant even when not pre-listed.
  if (tool.includes('send') || tool.includes('message')) {
    return { icon: Send, present: 'Sending a message', past: 'Sent a message' };
  }
  if (tool.includes('search') || tool.includes('find')) {
    return { icon: Search, present: 'Searching', past: 'Searched' };
  }
  if (tool.includes('read') || tool.includes('get')) {
    return { icon: FileText, present: 'Reading', past: 'Read' };
  }
  if (tool.includes('write') || tool.includes('edit') || tool.includes('create')) {
    return { icon: Pencil, present: 'Writing', past: 'Wrote' };
  }
  if (tool.includes('fetch') || tool.includes('http') || tool.includes('web')) {
    return { icon: Globe, present: 'Fetching from the web', past: 'Fetched from the web' };
  }
  // Final fallback — include the tool's friendly suffix so the past-
  // tense banner doesn't read as just "Done" with no context. Strip
  // common MCP prefixes (`mcp__nanoclaw__`, `mcp__server__`) so the
  // remaining slug is at least somewhat readable.
  const friendly = tool
    .replace(/^mcp__[a-z0-9_-]+__/i, '')
    .replace(/_/g, ' ');
  return {
    icon: Wrench,
    present: `Running ${friendly}`,
    past: `Ran ${friendly}`,
  };
}

/**
 * Per-Bash-category metadata. Mirrors `parsed_command.type` from
 * `realtime/src/bash-parse.ts`. The `salient` field (hostname, script
 * name, etc.) is stitched in by `bashMetaFor` below so e.g. a curl to
 * news.ycombinator.com reads "Fetched news.ycombinator.com" instead of
 * the generic "Fetched a web page".
 */
const BASH_META: Record<string, ToolMeta> = {
  'fetched-web-page': {
    icon: Globe,
    present: 'Fetching from the web',
    past: 'Fetched from the web',
  },
  'ran-program': { icon: Terminal, present: 'Running a program', past: 'Ran a program' },
  git: { icon: Terminal, present: 'Running git', past: 'Ran git' },
  'read-file': { icon: FileText, present: 'Reading a file', past: 'Read a file' },
  'listed-files': { icon: SearchCode, present: 'Listing files', past: 'Listed files' },
  'searched-files': { icon: Search, present: 'Searching files', past: 'Searched files' },
  'installed-packages': {
    icon: Wrench,
    present: 'Installing packages',
    past: 'Installed packages',
  },
  'edited-file': { icon: Pencil, present: 'Editing a file', past: 'Edited a file' },
  'made-directory': { icon: FilePlus, present: 'Creating a directory', past: 'Created a directory' },
  'changed-directory': { icon: Terminal, present: 'Changing directory', past: 'Changed directory' },
  other: { icon: Terminal, present: 'Running a command', past: 'Ran a command' },
};

/** Build the meta for a Bash invocation, using the server-parsed
 *  `parsed_command` to pick a friendly label and (where applicable)
 *  splice the salient detail (hostname / script name / git subcommand).
 */
function bashMetaFor(parsed?: { type: string; salient: string }): ToolMeta {
  if (!parsed) return TOOL_META.Bash!;
  const base = BASH_META[parsed.type] ?? TOOL_META.Bash!;
  if (!parsed.salient) return base;
  switch (parsed.type) {
    case 'fetched-web-page':
      return {
        icon: base.icon,
        present: `Fetching ${parsed.salient}`,
        past: `Fetched ${parsed.salient}`,
      };
    case 'ran-program':
      return {
        icon: base.icon,
        present: `Running ${parsed.salient}`,
        past: `Ran ${parsed.salient}`,
      };
    case 'git':
      return {
        icon: base.icon,
        present: `git ${parsed.salient}`,
        past: `git ${parsed.salient}`,
      };
    case 'read-file':
      return {
        icon: base.icon,
        present: `Reading ${parsed.salient}`,
        past: `Read ${parsed.salient}`,
      };
    case 'listed-files':
      return {
        icon: base.icon,
        present: `Listing ${parsed.salient}`,
        past: `Listed ${parsed.salient}`,
      };
    case 'searched-files':
      return {
        icon: base.icon,
        present: `Searching for "${parsed.salient}"`,
        past: `Searched for "${parsed.salient}"`,
      };
    case 'installed-packages':
      return {
        icon: base.icon,
        present: `${parsed.salient} install…`,
        past: `${parsed.salient} install`,
      };
    case 'edited-file':
      return {
        icon: base.icon,
        present: `Editing ${parsed.salient}`,
        past: `Edited ${parsed.salient}`,
      };
    case 'made-directory':
      return {
        icon: base.icon,
        present: `Creating ${parsed.salient}`,
        past: `Created ${parsed.salient}`,
      };
    case 'changed-directory':
      return {
        icon: base.icon,
        present: `cd ${parsed.salient}`,
        past: `cd ${parsed.salient}`,
      };
    default:
      return base;
  }
}

interface ToolBanner {
  id: string;
  tool: string;
  meta: ToolMeta;
  startedAt: number;
  /** null = still running (present tense); number = post timestamp (past tense). */
  endedAt: number | null;
  /** Set when a stale-clear timer fires — banner never received a
   *  tool-post within STALE_AFTER_MS of its tool-pre. Drives a distinct
   *  exit animation so a stuck banner looks abandoned rather than
   *  completed. We deliberately do NOT swap the label to past tense:
   *  we never knew it completed. */
  staleAt?: number;
}

const MAX_VISIBLE = 4;

/** A tool-pre with no matching tool-post within this window is treated
 *  as stale and dismissed with the "abandoned" exit animation.
 *  Anything taking longer than this is almost certainly a backend
 *  drop, network blip, or a tool family whose post-event is lost — in
 *  either case the user shouldn't see a forever-banner. */
const STALE_AFTER_MS = 45_000;

/** Compute dismissal delay (ms after post) for a finished banner. */
function dismissDelay(startedAt: number, endedAt: number): number {
  const durationMs = endedAt - startedAt;
  if (durationMs <= 500) return 2000;
  const scaled = 2000 + durationMs * 0.3;
  return Math.min(5000, scaled);
}

export interface ToolNotificationLayerProps {
  /** Same subscribe handle as the legacy EventTimeline / ToolIconLayer. */
  subscribe: (handler: (ev: PatEvent) => void) => () => void;
  placement: ToolBannerPlacement;
  /** PAT: when true, scenario.action events also render as banners
   *  (alongside tool-pre/-post events). Lets the operator verify
   *  the agent is emitting frag_next / slide_next / verbatim /
   *  tool_* tags when bullets aren't advancing as expected. */
  showActionStream?: boolean;
}

export function ToolNotificationLayer({ subscribe, placement }: ToolNotificationLayerProps) {
  const [banners, setBanners] = useState<ToolBanner[]>([]);
  // Per-banner dismissal timers, keyed by id, so we can cancel if a
  // banner gets evicted early by the MAX_VISIBLE cap.
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Tool-use ids the back-mind has SUPPRESSED — used to short-circuit
  // matching tool-post/-failed events so we don't open then immediately
  // close a hidden banner. We mute "ghost" tool calls that fire during
  // session-bootstrap (before any user input or front-mind forward
  // decision lands), since those are workspace-priming reads, not
  // anything the user kicked off.
  const suppressedToolUseIds = useRef<Set<string>>(new Set());
  // Has the user (or front-mind) actually triggered work yet? We open
  // the gate on the first observation of an `inbound.received`,
  // `stt.user-said`, or `request-layer.decided` (forward) event. Until
  // then any `tool-pre` is treated as session-bootstrap noise and
  // suppressed. Once gated open it stays open for the call's lifetime.
  const userHasActedRef = useRef<boolean>(false);

  // Per-banner stale-clear timers. Separate from `timers` (which holds
  // post→dismiss delays) so a banner that gets a real tool-post just
  // before its stale window expires cleanly switches off the stale
  // timer and onto the normal dismissal path.
  const staleTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const clearTimer = (id: string): void => {
      const t = timers.current.get(id);
      if (t !== undefined) {
        clearTimeout(t);
        timers.current.delete(id);
      }
    };
    const clearStaleTimer = (id: string): void => {
      const t = staleTimers.current.get(id);
      if (t !== undefined) {
        clearTimeout(t);
        staleTimers.current.delete(id);
      }
    };
    const scheduleDismissal = (id: string, ms: number): void => {
      clearTimer(id);
      const t = setTimeout(() => {
        setBanners((prev) => prev.filter((b) => b.id !== id));
        timers.current.delete(id);
      }, ms);
      timers.current.set(id, t);
    };
    const scheduleStaleClear = (id: string): void => {
      clearStaleTimer(id);
      const t = setTimeout(() => {
        // Two-phase: first mark the banner staleAt so the NEXT render
        // captures a stale-flavoured `exit` value on its motion.div;
        // then remove the banner shortly after so AnimatePresence
        // runs that exit transition. Without the two phases the
        // banner would just pop off with whatever exit was last
        // rendered (the normal one).
        let stillOpen = false;
        setBanners((prev) =>
          prev.map((b) => {
            if (b.id !== id || b.endedAt !== null) return b;
            stillOpen = true;
            return { ...b, staleAt: Date.now() };
          }),
        );
        if (!stillOpen) {
          staleTimers.current.delete(id);
          return;
        }
        // Remove on the next macrotask so React has a chance to commit
        // the staleAt-bearing render and motion captures the stale exit.
        const r = setTimeout(() => {
          setBanners((prev) => prev.filter((b) => b.id !== id));
          timers.current.delete(id);
        }, 30);
        timers.current.set(id, r);
        staleTimers.current.delete(id);
      }, STALE_AFTER_MS);
      staleTimers.current.set(id, t);
    };

    const unsub = subscribe((ev) => {
      // Open the suppression gate the moment the user actually does
      // anything. After this point all tool-pre events render normally.
      if (
        ev.kind === 'inbound.received' ||
        ev.kind === 'stt.user-said' ||
        (ev.kind === 'request-layer.decided' &&
          (ev as { data?: { decision?: string } }).data?.decision === 'forward')
      ) {
        userHasActedRef.current = true;
        return;
      }
      if (ev.kind !== 'detail.row-received') return;
      const d = ev as DetailRowReceived;
      const toolUseId = d.data.tool_use_id;
      if (!toolUseId) return;
      const now = Date.now();

      if (d.data.type === 'tool-pre') {
        // Ghost-call suppression: any tool-pre that arrives BEFORE the
        // user has spoken (or the front-mind forwarded) is bootstrap
        // noise — suppress its banner AND remember the tool_use_id so
        // we drop the matching tool-post when it arrives.
        if (!userHasActedRef.current) {
          suppressedToolUseIds.current.add(toolUseId);
          // Bound the suppression set so a long-running session with
          // many bootstrap calls doesn't accumulate forever.
          if (suppressedToolUseIds.current.size > 200) {
            suppressedToolUseIds.current = new Set();
          }
          return;
        }
        const tool = d.data.tool ?? '?';
        // PAT: prefer server-parsed Bash labels when available so the
        // banner reads "Fetching news.ycombinator.com" instead of
        // "Running a command". Falls back to the static catalog for
        // other tools.
        const meta =
          tool === 'Bash' ? bashMetaFor(d.data.parsed_command) : metaFor(tool);
        setBanners((prev) => {
          // De-dupe by tool_use_id.
          if (prev.some((b) => b.id === toolUseId)) return prev;
          const next: ToolBanner = { id: toolUseId, tool, meta, startedAt: now, endedAt: null };
          const combined = [...prev, next];
          // Evict oldest when over the cap. Prefer evicting past-tense
          // ("fading") banners first; otherwise drop the literal oldest.
          if (combined.length <= MAX_VISIBLE) return combined;
          const fadingIdx = combined.findIndex((b) => b.endedAt !== null);
          const dropIdx = fadingIdx >= 0 ? fadingIdx : 0;
          const dropped = combined[dropIdx]!;
          clearTimer(dropped.id);
          clearStaleTimer(dropped.id);
          return combined.filter((_, i) => i !== dropIdx);
        });
        // Arm the stale-clear timer in parallel — if no tool-post lands
        // within STALE_AFTER_MS the banner gets the abandoned-exit
        // dismissal instead of sitting forever.
        scheduleStaleClear(toolUseId);
        return;
      }

      if (d.data.type === 'tool-post' || d.data.type === 'tool-failed') {
        // Drop tool-post for any tool-pre we suppressed — there is no
        // banner to swap into past-tense.
        if (suppressedToolUseIds.current.has(toolUseId)) {
          suppressedToolUseIds.current.delete(toolUseId);
          return;
        }
        // Tool completed normally — cancel the stale-clear timer so the
        // banner takes the "completed → linger → fade up" path instead.
        clearStaleTimer(toolUseId);
        setBanners((prev) => {
          const idx = prev.findIndex((b) => b.id === toolUseId);
          if (idx < 0) return prev;
          // Mark as ended; label swaps via memoized lookup in render.
          const ended: ToolBanner = { ...prev[idx]!, endedAt: now };
          const next = [...prev];
          next[idx] = ended;
          scheduleDismissal(toolUseId, dismissDelay(ended.startedAt, now));
          return next;
        });
        return;
      }
    });
    return () => {
      unsub();
      for (const t of timers.current.values()) clearTimeout(t);
      timers.current.clear();
      for (const t of staleTimers.current.values()) clearTimeout(t);
      staleTimers.current.clear();
    };
  }, [subscribe]);

  // Both placements share the same motion vocabulary — slide in from
  // off-stage, settle at the anchor, drift further along the entry
  // axis as new arrivals push older banners away, slide further out
  // and fade on dismissal. Anchor + entry direction differ:
  //   'left' : anchored left-middle, banners enter from off-left.
  //            Newest sits at the bottom of the column; older ones
  //            drift upward. Dismissal slides up and fades.
  //   'top'  : anchored top-center, banners enter from off-top.
  //            Newest sits at the top of the column; older ones
  //            drift down. Dismissal slides up and fades.
  // For 'left' we use a bottom-anchored flex-col with `justify-end`
  // so naturally-flowing items stack with the newest at the bottom
  // (the anchor) and the oldest pushed upward.
  const isLeft = placement === 'left';

  const stackPositionStyle: React.CSSProperties = isLeft
    ? {
        left: 'calc(env(safe-area-inset-left, 0px) + 1.25rem)',
        // Center vertically. We anchor the stack's BOTTOM at the
        // vertical midline so new arrivals appear at midline and older
        // ones drift upward into the upper half.
        bottom: '50%',
      }
    : {
        left: '50%',
        top: 'calc(env(safe-area-inset-top, 0px) + 1rem)',
        transform: 'translateX(-50%)',
      };

  const stackFlowCls = isLeft
    ? 'items-start justify-end'
    : 'items-center justify-start';

  // Reverse the list for 'left' so the newest banner renders LAST in
  // DOM order, which (with `justify-end` on a column) puts it at the
  // bottom — i.e. closest to the vertical-center anchor. For 'top' we
  // keep insertion order so newest is first/highest.
  const ordered = isLeft ? [...banners] : [...banners].reverse();

  return (
    <div
      className={`pointer-events-none absolute z-30 flex flex-col gap-2 ${stackFlowCls}`}
      style={stackPositionStyle}
      aria-live="polite"
      aria-atomic="false"
    >
      <AnimatePresence initial={false}>
        {ordered.map((b) => {
          const label = b.endedAt === null ? `${b.meta.present}…` : b.meta.past;
          const Icon = b.meta.icon;
          const isDone = b.endedAt !== null;
          // Initial offset along the entry axis.
          const initial = isLeft ? { opacity: 0, x: -48, y: 0 } : { opacity: 0, x: 0, y: -16 };
          // Exit motion has two flavours:
          //   - Completed (default): drifts UPWARD (and slightly along
          //     the anchor axis for 'left') with a quick fade. Reads as
          //     "ascending / done" — matches user spec ("slide up at
          //     the top as they disappear").
          //   - Stale (`b.staleAt` set — banner timed out without ever
          //     receiving tool-post): retreats BACK along the entry
          //     direction with a slower fade. Reads as "abandoned" /
          //     "retreated" rather than "completed".
          const stale = b.staleAt != null;
          const exit = stale
            ? (isLeft
                ? { opacity: 0, x: -72, y: 6, transition: { duration: 0.6, ease: [0.3, 0, 0.7, 1] as [number, number, number, number] } }
                : { opacity: 0, y: -32, transition: { duration: 0.6, ease: [0.3, 0, 0.7, 1] as [number, number, number, number] } })
            : (isLeft
                ? { opacity: 0, x: -24, y: -24, transition: { duration: 0.34 } }
                : { opacity: 0, y: -16, transition: { duration: 0.3 } });
          return (
            <motion.div
              key={b.id}
              layout
              initial={initial}
              animate={{ opacity: 1, x: 0, y: 0 }}
              exit={exit}
              transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
              className="flex items-center gap-2.5 rounded-full font-medium backdrop-blur-md min-w-[220px] max-w-[320px] px-3 py-2 text-[12.5px]"
              style={{
                background: 'oklch(0.10 0.012 250 / 0.88)',
                color: 'oklch(0.97 0.005 250)',
                border: '1px solid oklch(0.36 0.012 250 / 0.55)',
                boxShadow: '0 6px 24px oklch(0 0 0 / 0.32)',
              }}
              title={b.tool}
              aria-label={`${label} (${b.tool})`}
            >
              <div
                className="flex shrink-0 items-center justify-center rounded-full"
                style={{
                  width: 26,
                  height: 26,
                  background: isDone
                    ? 'oklch(0.75 0.12 145 / 0.22)'
                    : 'oklch(0.62 0.02 250 / 0.42)',
                  // Subtle pulse while running; static once done.
                  animation: isDone ? undefined : 'tool-banner-pulse 2.4s ease-in-out infinite',
                }}
              >
                <Icon
                  size={15}
                  strokeWidth={2}
                  color={isDone ? 'oklch(0.92 0.08 145)' : 'oklch(0.94 0.005 250)'}
                />
              </div>
              <motion.span
                key={label}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.18 }}
                className="truncate"
              >
                {label}
              </motion.span>
            </motion.div>
          );
        })}
      </AnimatePresence>
      {/* Pulse keyframes — local to this component, scoped via a
          one-shot <style> tag to avoid a global stylesheet edit. */}
      <style>{`
        @keyframes tool-banner-pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.08); }
        }
      `}</style>
    </div>
  );
}
