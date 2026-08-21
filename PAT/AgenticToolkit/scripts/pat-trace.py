#!/usr/bin/env python3
"""
pat-trace — pull a single PAT call's structured log and render an
interrupt-aware ASCII timeline.

Designed for "I just hung up and something felt weird — what happened?"
diagnosis. Each call (anam-web, Signal, Slack, PSTN) has a thread_id
in the structured log. Give this tool a thread_id (or let it auto-pick
the most recent anam-web call) and it walks the events into a
glanceable timeline with:

  - Source-coded utterance streams (banter-ack vs banter-render vs
    narrator) on separate columns
  - Concurrent-stream OVERLAP warnings (the bug I traced manually on
    2026-05-13: banter-ack and banter-rendition both streaming into
    Anam at the same time)
  - User turns in a left column with the actual transcribed text
  - Latency hints (Δms since last event) so slowdowns pop out

Usage
-----
    scripts/pat-trace.py                         # most recent anam-web call
    scripts/pat-trace.py <thread_id>             # a specific thread
    scripts/pat-trace.py --signal +15550100000   # most recent Signal thread
                                                 # for this user
    scripts/pat-trace.py --since 5m              # only last 5min
    scripts/pat-trace.py --follow                # live tail (Ctrl-C to exit)
    scripts/pat-trace.py --json                  # raw event dump (one per line)

Auth
----
Reads PAT_VIEWER_TOKEN from `.env.agent` at the repo root. Hits
pat-frontend.fly.dev's public log endpoints — same surface as opening
the dashboard with the token, so no Fly SSH or admin creds required.

Transport
---------
For one-shot fetches (the default) we prefer `/api/logs.jsonl` with
server-side `thread_id` + `since` filtering — that's O(thread) on the
wire and returns in seconds even on busy days. If the jsonl proxy
returns 502 or 504 (older deploys lacked the keepalive flush fix and
the Fly edge would time out on slow scans) we fall back to the
`/api/logs.tail` SSE firehose and filter client-side — slower but
self-contained.

`--follow` always uses SSE.

What it surfaces
----------------
- Source overlap: utterance.stream-started for one source while a
  different source still has an open utterance.stream-started (no
  stream-ended yet). Shows as ⚠ OVERLAP on the line.
- Phantom turns: inbound.received with no following banter.called
  within 2s (banter Haiku hung or dropped).
- Render-without-back-mind: banter.rendered without a preceding
  chat.row-received in the same turn (rendition fired off stale or
  hallucinated back-mind output).
- Long thinks: gap >5s between request-layer.decided forward and
  chat.row-received with no narrator.fired in between (Narrator
  silent during long back-mind work).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

# ──────────────────────────── config ─────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parent.parent
SECRETS = REPO_ROOT / ".env.agent"
# Override with PAT_FRONTEND env (e.g. https://pat-frontend-staging.fly.dev
# to trace the staging stack — viewer token is shared with prod).
PAT_FRONTEND = os.environ.get("PAT_FRONTEND", "https://pat-frontend.fly.dev")

# ANSI palette — kind-coded, but degrades gracefully when stdout isn't a tty.
USE_COLOR = sys.stdout.isatty()


def c(code: str, text: str) -> str:
    if not USE_COLOR:
        return text
    return f"\x1b[{code}m{text}\x1b[0m"


SOURCE_COLOR = {
    "banter-ack": "33",  # yellow
    "banter-rendered": "32",  # green
    "narrator": "36",  # cyan
    "tool": "35",  # magenta
}

# Timeline-runtime palette. Mirrors the dashboard's per-category swimlane
# treatment (pat-frontend/src/components/Timeline.tsx). Bracket events
# (timeline.started / finished) use a bright tint so the wrappers pop;
# each action category gets its own hue so the cascade reads in-place.
TIMELINE_BRACKET_COLOR = "95"  # bright magenta
TIMELINE_CATEGORY_COLOR = {
    "slide": "36",      # cyan — navigation
    "fragment": "96",   # bright cyan — sub-navigation
    "say": "33",        # yellow — spoken (matches banter-ack)
    "tool": "35",       # magenta — round-trip to back-mind
    "pause": "37",      # white/grey — visual beat
    "wait": "34",       # blue — external cue
    "qa": "94",         # bright blue — audience pause
    "other": "37",
}


def _action_salient(kind: str, attrs: dict) -> str:
    """Short inline label per action kind, populated from the
    `attrs` payload (timeline-core 03ae995) when available. Mirrors
    `actionSalient` in pat-frontend/src/components/Timeline.tsx so
    pat-trace and the dashboard tell the same story.

    Returns '' when there's nothing useful to render — caller chooses
    whether to elide the field entirely.
    """
    cat = _action_category(kind)
    if cat == "slide":
        k = kind.replace("terminator:", "", 1)
        if k == "next_slide":
            return "→"
        if k == "prev_slide":
            return "←"
        if k == "nav_slide_up":
            return "↑"
        if k == "nav_slide_down":
            return "↓"
        if k == "nav_slide_left":
            return "←"
        if k == "nav_slide_right":
            return "→"
        if k == "goto_slide":
            n = attrs.get("n")
            v = attrs.get("v")
            if isinstance(n, (int, float)):
                return f"→{int(n)}:v{int(v)}" if isinstance(v, (int, float)) else f"→{int(n)}"
            return "→…"
        if k == "end_of_timeline":
            return "◼"
        return k
    if cat == "fragment":
        if kind == "next_fragment":
            return "→"
        if kind == "prev_fragment":
            return "←"
        return kind
    if cat == "say":
        # Authored say text (truncated). banter-dispatch's REWRITE
        # arrives as its own event further down the timeline — pat-trace
        # renders both, so we don't dedup here.
        text = attrs.get("text")
        if isinstance(text, str) and text:
            clipped = text.strip().replace("\n", " ")
            return f'"{clipped[:36] + ("…" if len(clipped) > 36 else "")}"'
        return ""
    if cat == "tool":
        name = attrs.get("tool_name")
        if isinstance(name, str) and name:
            async_mark = " …" if attrs.get("async") is True else ""
            return f"{name}{async_mark}"
        # fallback — parse the kind label
        bare = kind.replace("tool:", "", 1).removesuffix(":async")
        return bare or "tool"
    if cat == "pause":
        ms = attrs.get("ms")
        if isinstance(ms, (int, float)):
            return f"{int(ms)}ms"
        return ""
    if cat == "wait":
        cue = attrs.get("cue")
        return cue if isinstance(cue, str) and cue else "cue"
    if cat == "qa":
        return "?"
    return ""


def _action_category(kind: str) -> str:
    """Bucket an action-kind label into the same coarse categories the
    pat-frontend swimlane uses. Pure on the kind string; mirrors
    `actionCategory` in pat-frontend/src/components/Timeline.tsx so the
    online and offline views tell the same story."""
    if kind == "say":
        return "say"
    if kind == "pause":
        return "pause"
    if kind == "wait-for-cue":
        return "wait"
    if kind == "ask_for_questions" or kind == "terminator:ask_for_questions":
        return "qa"
    if kind == "tool" or kind.startswith("tool:"):
        return "tool"
    if kind in ("next_fragment", "prev_fragment"):
        return "fragment"
    if (
        kind in ("next_slide", "prev_slide", "goto_slide")
        or kind.startswith("nav_slide_")
        or kind.startswith("terminator:next_slide")
        or kind.startswith("terminator:prev_slide")
        or kind.startswith("terminator:goto_slide")
        or kind.startswith("terminator:nav_slide_")
        or kind.startswith("terminator:end_of_timeline")
    ):
        return "slide"
    return "other"


# ──────────────────────── secrets / fetch ────────────────────────────


def load_viewer_token() -> str:
    if not SECRETS.exists():
        sys.stderr.write(f"missing {SECRETS}; cannot authenticate\n")
        sys.exit(2)
    for line in SECRETS.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("PAT_VIEWER_TOKEN="):
            return line.split("=", 1)[1].strip()
    sys.stderr.write("PAT_VIEWER_TOKEN not found in .env.agent\n")
    sys.exit(2)


def fetch_events_jsonl(
    token: str,
    since_ms: int | None = None,
    until_ms: int | None = None,
    thread_id: str | None = None,
    kind: str | None = None,
    include_debug: bool = False,
    read_timeout_s: float = 90.0,
) -> list[dict] | None:
    """One-shot fetch from pat-frontend's /api/logs.jsonl proxy.

    The jsonl endpoint supports server-side filtering by `thread_id`,
    `since`, `until`, etc., so thread-scoped fetches are O(thread) on
    the wire — much smaller than the SSE firehose tail.

    Returns a fully-materialized list of parsed events on success.
    Returns `None` on 502/timeout from the proxy — the caller should
    fall back to SSE. (The fix for these 502s lives in pat-frontend
    and nanoclaw and may not be deployed yet on every environment.)

    Empty lines — which nanoclaw uses as keepalives so Fly's edge
    doesn't 502 on slow scans — are silently ignored.
    """
    qs = [f"token={token}"]
    if since_ms is not None:
        qs.append(f"since={since_ms}")
    if until_ms is not None:
        qs.append(f"until={until_ms}")
    if thread_id is not None:
        qs.append(f"thread_id={thread_id}")
    if kind is not None:
        qs.append(f"kind={kind}")
    if include_debug:
        qs.append("include_debug=1")
    url = f"{PAT_FRONTEND}/api/logs.jsonl?{'&'.join(qs)}"

    req = urllib.request.Request(url, headers={"Accept": "application/x-ndjson"})
    events: list[dict] = []
    try:
        with urllib.request.urlopen(req, timeout=read_timeout_s) as resp:
            for raw in resp:
                stripped = raw.strip()
                if not stripped:
                    continue  # keepalive
                try:
                    events.append(json.loads(stripped))
                except json.JSONDecodeError:
                    continue
    except urllib.error.HTTPError as e:
        if e.code in (502, 504):
            return None  # caller falls back to SSE
        body = e.read().decode("utf-8", errors="replace")[:500] if hasattr(e, "read") else ""
        sys.stderr.write(f"fetch failed: HTTP {e.code} {e.reason}\n  {body}\n")
        sys.exit(3)
    except urllib.error.URLError as e:
        sys.stderr.write(f"fetch failed: {e}\n")
        sys.exit(3)
    return events


def fetch_events_sse(
    token: str,
    since_ms: int | None = None,
    until_ms: int | None = None,
    idle_timeout_s: float = 4.0,
    max_wall_s: float = 90.0,
    follow: bool = False,
) -> Iterable[dict]:
    """Stream SSE events from pat-frontend's /api/logs.tail proxy.

    Selects on the raw socket so we can multiplex an idle timeout
    (drop out N seconds after the historical backlog dries up) and
    a wall-clock ceiling without ever calling `socket.settimeout()`
    on urllib's response — that puts urllib in a "tainted" state
    where every subsequent read raises
    `OSError: cannot read from timed out object`. That bug used to
    make `pat-trace` silently exit in <1s on every invocation.

    `follow=True` disables both timeouts and reads until the caller
    breaks out (Ctrl-C).
    """
    import select

    qs = [f"token={token}"]
    if since_ms is not None:
        qs.append(f"since={since_ms}")
    url = f"{PAT_FRONTEND}/api/logs.tail?{'&'.join(qs)}"

    req = urllib.request.Request(url, headers={"Accept": "text/event-stream"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            sock = resp.fp.raw._sock  # type: ignore[attr-defined]
            buf = ""
            last_event_ts = time.monotonic()
            started_at = time.monotonic()
            saw_first_event = False
            while True:
                if not follow:
                    if time.monotonic() - started_at > max_wall_s:
                        break
                    if (
                        saw_first_event
                        and time.monotonic() - last_event_ts > idle_timeout_s
                    ):
                        break
                ready, _, _ = select.select([sock], [], [], 0.5)
                if not ready:
                    continue
                try:
                    chunk = resp.read1(4096) if hasattr(resp, "read1") else resp.read(4096)
                except Exception:
                    break
                if not chunk:
                    if follow:
                        time.sleep(0.5)
                        continue
                    break
                buf += chunk.decode("utf-8", errors="replace")
                while "\n" in buf:
                    line, buf = buf.split("\n", 1)
                    if not line.startswith("data: "):
                        continue
                    try:
                        ev = json.loads(line[6:])
                    except json.JSONDecodeError:
                        continue
                    last_event_ts = time.monotonic()
                    saw_first_event = True
                    yield ev
                    # Client-side `until` for one-shot mode — the SSE
                    # firehose doesn't take an `until=` query param, but
                    # we can stop reading as soon as the stream catches
                    # up past our snapshot boundary. Otherwise the idle
                    # timeout never fires (poll-loop heartbeats keep the
                    # stream warm forever).
                    if not follow and until_ms is not None:
                        try:
                            ev_ms = int(
                                datetime.fromisoformat(
                                    ev["ts"].replace("Z", "+00:00")
                                ).timestamp() * 1000
                            )
                            if ev_ms >= until_ms:
                                return
                        except Exception:
                            pass
    except urllib.error.URLError as e:
        sys.stderr.write(f"fetch failed: {e}\n")
        sys.exit(3)


# ──────────────────────── thread discovery ───────────────────────────


def auto_pick_thread(events: list[dict], prefix: str = "anam-web-call-") -> str | None:
    """Pick the most-recent thread_id starting with prefix."""
    last_ts: dict[str, str] = {}
    for ev in events:
        tid = ev.get("thread_id")
        if not isinstance(tid, str) or not tid.startswith(prefix):
            continue
        ts = ev.get("ts", "")
        if tid not in last_ts or ts > last_ts[tid]:
            last_ts[tid] = ts
    if not last_ts:
        return None
    return max(last_ts.items(), key=lambda kv: kv[1])[0]


# ─────────────────────────── render ──────────────────────────────────


@dataclass
class OpenStream:
    source: str
    started_ts: str
    text: str = ""


def fmt_time(ts: str) -> str:
    # ISO 8601 → HH:MM:SS.mmm
    try:
        return ts.split("T", 1)[1].rstrip("Z")[:12]
    except Exception:
        return ts[:12]


def parse_ts(ts: str) -> float:
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def render(events: list[dict], thread_id: str) -> None:
    """Print a chronological one-line-per-event timeline with overlap
    and gap warnings inline."""
    filtered = [e for e in events if e.get("thread_id") == thread_id]
    if not filtered:
        sys.stderr.write(f"no events for thread_id={thread_id}\n")
        return

    print(c("1;37", f"\n  thread: {thread_id}"))
    print(c("2", f"  {len(filtered)} events  ·  {fmt_time(filtered[0]['ts'])} → {fmt_time(filtered[-1]['ts'])}\n"))

    open_streams: dict[str, OpenStream] = {}
    last_inbound_ts: float | None = None
    last_request_forward_ts: float | None = None
    saw_narrator_since_forward = False
    last_chat_row_idx: int | None = None

    # Timeline nesting — every action-* / banter-dispatch row indents under
    # the currently-open `<timeline>` wrapper. Counter (not stack) since
    # nested timelines aren't permitted by the runtime; if one shows up
    # anyway we still produce readable indent.
    timeline_depth = 0
    # Track open enqueues so completed/cancelled rows can fill in their
    # paired enqueue's ts/seq when needed. Key: "<timeline_id>:<seq>".
    open_actions: dict[str, dict] = {}

    prev_event_ts: float | None = None

    for i, ev in enumerate(filtered):
        ts = ev["ts"]
        kind = ev.get("kind", "?")
        data = ev.get("data", {}) or {}
        cur = parse_ts(ts)
        gap_ms = int((cur - prev_event_ts) * 1000) if prev_event_ts else 0
        prev_event_ts = cur

        gap_str = c("2", f"  +{gap_ms:>5}ms")

        markers: list[str] = []

        if kind == "inbound.received":
            text = (data.get("text") or "")[:80]
            sender = data.get("sender", "?")
            print(
                f"  {fmt_time(ts)}{gap_str}  "
                f"{c('1;34', '◀ USER')}  "
                f"{c('34', text)}"
                f"{c('2', f'   ({sender})')}"
            )
            last_inbound_ts = cur
            saw_narrator_since_forward = False
            continue

        if kind == "utterance.stream-started":
            source = data.get("source", "unknown")
            color = SOURCE_COLOR.get(source.split("-")[0] if source.startswith("banter") else source.split(".")[0], "37")
            # Overlap detection: any other open stream right now?
            others = [s for s in open_streams.keys() if s != source]
            if others:
                markers.append(c("1;31", f"⚠ OVERLAP with {','.join(others)}"))
            open_streams[source] = OpenStream(source=source, started_ts=ts)
            print(f"  {fmt_time(ts)}{gap_str}  {c(color, '▶ start')}  {c(color, source):<24}  " + " ".join(markers))
            continue

        if kind == "utterance.stream-delta":
            source = data.get("source", "unknown")
            delta = data.get("text_delta") or ""
            if source in open_streams:
                open_streams[source].text += delta
            # Quiet by default — deltas are noise; uncomment for very-verbose mode.
            # print(f"  {fmt_time(ts)}{gap_str}  {c('2','  Δ')}  {source}  '{delta}'")
            continue

        if kind in ("utterance.stream-ended", "utterance.stream-cancelled"):
            source = data.get("source", "unknown")
            color = SOURCE_COLOR.get(source.split("-")[0] if source.startswith("banter") else source.split(".")[0], "37")
            full = data.get("full_text") or data.get("partial_text") or open_streams.get(source, OpenStream("", "")).text
            duration_ms = data.get("stream_ms")
            tag = "end" if kind == "utterance.stream-ended" else c("1;31", "cancelled")
            dur_str = c("2", f"  ({duration_ms}ms)") if duration_ms else ""
            print(
                f"  {fmt_time(ts)}{gap_str}  {c(color, '◼ '+tag)}  {c(color, source):<24}"
                f"{dur_str}  {c(color, full[:90])}"
            )
            open_streams.pop(source, None)
            continue

        if kind == "banter.called":
            silent = data.get("intentionally_silent")
            text = (data.get("response_text") or "")[:90]
            label = "(silent)" if silent else f"\"{text}\""
            print(f"  {fmt_time(ts)}{gap_str}  {c('33', '● banter.called  ')}{label}")
            continue

        if kind == "request-layer.decided":
            decision = data.get("decision", "?")
            color = "32" if decision == "forward" else "2"
            reason = (data.get("reason") or "")[:80]
            extra = ""
            if decision == "forward":
                extra = f"  → {(data.get('invoke_text') or '')[:60]}"
                last_request_forward_ts = cur
            print(
                f"  {fmt_time(ts)}{gap_str}  {c(color, '● request-layer  ')}"
                f"{c(color, decision):<10}  {c('2', reason)}{extra}"
            )
            continue

        if kind == "banter.rendered":
            text = (data.get("rendered_text") or "")[:90]
            ms = data.get("render_ms")
            ms_str = c("2", f" ({ms}ms)") if ms else ""
            # Check if there was a chat.row-received before this in this thread.
            tag = ""
            if last_chat_row_idx is None:
                tag = c("1;33", "  ⚠ no preceding chat.row")
            print(f"  {fmt_time(ts)}{gap_str}  {c('32', '● banter.rendered')}{ms_str}  {c('32', text)}{tag}")
            continue

        if kind == "chat.row-received":
            try:
                preview_text = (data.get("preview") or "")[:90]
                # The text is JSON-encoded one level deep; parse if obvious.
                if preview_text.startswith('{"text":"'):
                    inner = json.loads(data.get("full_text") or data.get("preview") or "{}")
                    preview_text = (inner.get("text") or "")[:90]
            except Exception:
                preview_text = (data.get("preview") or "")[:90]
            print(f"  {fmt_time(ts)}{gap_str}  {c('1;32', '▶ chat.row     ')}  {c('1;32', preview_text)}")
            last_chat_row_idx = i
            continue

        if kind == "narrator.fired":
            utterance = (data.get("utterance") or "")[:90]
            print(f"  {fmt_time(ts)}{gap_str}  {c('36', '● narrator.fired ')}{c('36', utterance)}")
            saw_narrator_since_forward = True
            continue

        if kind == "narrator.brain-spawned":
            print(f"  {fmt_time(ts)}{gap_str}  {c('2', '· narrator.brain-spawned')}")
            continue

        if kind == "detail.row-received":
            d_type = data.get("type", "?")
            tool = data.get("tool", "")
            if d_type == "tool-pre":
                print(f"  {fmt_time(ts)}{gap_str}  {c('35', '🔧 tool-pre      ')}{c('35', tool)}")
            elif d_type == "tool-post":
                preview = (data.get("result_preview") or "")[:70]
                print(f"  {fmt_time(ts)}{gap_str}  {c('35', '✓ tool-post     ')}{c('35', tool)}  {c('2', preview)}")
            elif d_type == "tool-failed":
                err = (data.get("error") or "")[:80]
                print(f"  {fmt_time(ts)}{gap_str}  {c('1;31', '✗ tool-failed   ')}{c('1;31', tool)}  {c('31', err)}")
            continue

        if kind == "state.transitioned":
            state = data.get("state", "?")
            frm = data.get("from")
            to = data.get("to")
            print(f"  {fmt_time(ts)}{gap_str}  {c('2', f'  · state {state}: {frm} → {to}')}")
            continue

        # ── Timeline runtime events ─────────────────────────────────────
        # Brackets stay at base indent; action-* + banter-dispatch indent
        # one level under the currently-open <timeline> wrapper.

        if kind == "timeline.started":
            tid = data.get("timeline_id") or "?"
            slug = data.get("scenario_slug")
            extra = f"  ({slug})" if slug else ""
            print(
                f"  {fmt_time(ts)}{gap_str}  "
                f"{c(TIMELINE_BRACKET_COLOR, '▶ timeline')}  "
                f"{c(TIMELINE_BRACKET_COLOR, tid)}"
                f"{c('2', extra)}"
            )
            timeline_depth += 1
            continue

        if kind == "timeline.finished":
            tid = data.get("timeline_id") or "?"
            reason = data.get("reason", "?")
            dur = data.get("duration_ms")
            dur_str = c("2", f"  ({dur}ms)") if dur is not None else ""
            reason_color = "1;31" if reason == "interrupted" else TIMELINE_BRACKET_COLOR
            timeline_depth = max(0, timeline_depth - 1)
            print(
                f"  {fmt_time(ts)}{gap_str}  "
                f"{c(TIMELINE_BRACKET_COLOR, '■ timeline')}  "
                f"{c(TIMELINE_BRACKET_COLOR, tid)}  "
                f"{c(reason_color, reason)}{dur_str}"
            )
            continue

        if kind == "timeline.action-enqueued":
            tid = data.get("timeline_id") or "?"
            seq = data.get("seq")
            action_kind = data.get("kind") or "?"
            cat = _action_category(action_kind)
            color = TIMELINE_CATEGORY_COLOR.get(cat, "37")
            indent = "    " * max(1, timeline_depth)
            # Salient — pulled from attrs (timeline-core 03ae995).
            # Mirrors actionSalient() in pat-frontend Timeline.tsx so the
            # offline cascade reads the same way as the dashboard.
            attrs = data.get("attrs") or {}
            salient = _action_salient(action_kind, attrs)
            sal_str = f"  {c('2', salient)}" if salient else ""
            print(
                f"  {fmt_time(ts)}{gap_str}  "
                f"{indent}{c(color, '+ ' + action_kind)}  "
                f"{c('2', f'[seq {seq}]')}{sal_str}"
            )
            open_actions[f"{tid}:{seq}"] = {
                "ts": cur,
                "kind": action_kind,
                "attrs": attrs,
            }
            continue

        if kind == "timeline.action-completed":
            tid = data.get("timeline_id") or "?"
            seq = data.get("seq")
            action_kind = data.get("kind") or "?"
            dur = data.get("duration_ms")
            cat = _action_category(action_kind)
            color = TIMELINE_CATEGORY_COLOR.get(cat, "37")
            indent = "    " * max(1, timeline_depth)
            dur_str = f"  {c('2', f'{int(dur)}ms')}" if isinstance(dur, (int, float)) else ""
            # Recover the salient from the matching enqueue's attrs so
            # the completion row carries the same affordance as the
            # enqueue (target slide number, tool name, cue, etc.).
            paired = open_actions.get(f"{tid}:{seq}") or {}
            paired_attrs = paired.get("attrs") if isinstance(paired, dict) else None
            salient = _action_salient(action_kind, paired_attrs or {})
            sal_str = f"  {c('2', salient)}" if salient else ""
            print(
                f"  {fmt_time(ts)}{gap_str}  "
                f"{indent}{c(color, '✓ ' + action_kind)}  "
                f"{c('2', f'[seq {seq}]')}{dur_str}{sal_str}"
            )
            open_actions.pop(f"{tid}:{seq}", None)
            continue

        if kind == "timeline.action-cancelled":
            tid = data.get("timeline_id") or "?"
            seq = data.get("seq")
            action_kind = data.get("kind") or "?"
            reason = data.get("reason") or "cancelled"
            partial = data.get("partial")
            cat = _action_category(action_kind)
            color = TIMELINE_CATEGORY_COLOR.get(cat, "37")
            indent = "    " * max(1, timeline_depth)
            partial_str = ""
            if isinstance(partial, str) and partial:
                # Trim to a short prefix — same idiom as the dashboard
                # tooltip; full text in the structured log.
                clipped = partial.strip().replace("\n", " ")
                if len(clipped) > 60:
                    clipped = clipped[:59] + "…"
                partial_str = f"  {c('2', f'…“{clipped}”')}"
            print(
                f"  {fmt_time(ts)}{gap_str}  "
                f"{indent}{c('1;31', '✗ ' + action_kind)}  "
                f"{c('2', f'[seq {seq}]')}  "
                f"{c('31', reason)}{partial_str}"
            )
            open_actions.pop(f"{tid}:{seq}", None)
            continue

        if kind == "banter-dispatch.called":
            inp = (data.get("input_text") or "").strip().replace("\n", " ")
            out = (data.get("output_text") or "").strip().replace("\n", " ")
            ok = data.get("ok", True)
            latency = data.get("latency_ms")
            indent = "    " * max(1, timeline_depth)
            # Clamp both texts for one-line rendering; the dashboard's
            # detail modal has the full strings if needed.
            in_clip = inp[:36] + ("…" if len(inp) > 36 else "")
            out_clip = out[:36] + ("…" if len(out) > 36 else "")
            lat_str = c("2", f"  ({int(latency)}ms)") if isinstance(latency, (int, float)) else ""
            if not ok:
                err = (data.get("error") or "fail").strip()
                print(
                    f"  {fmt_time(ts)}{gap_str}  "
                    f"{indent}{c('1;31', '▸ banter-dispatch FAIL')}  "
                    f"{c('31', err)}  {c('2', f'raw: \"{in_clip}\"')}{lat_str}"
                )
            else:
                arrow = "→" if inp != out else "="
                print(
                    f"  {fmt_time(ts)}{gap_str}  "
                    f"{indent}{c('33', '▸ banter-dispatch')}  "
                    f"{c('33', f'\"{in_clip}\" {arrow} \"{out_clip}\"')}{lat_str}"
                )
            continue

        # Fallthrough — print kind only.
        print(f"  {fmt_time(ts)}{gap_str}  {c('2', '· '+kind)}")

    # Footer: lingering open streams?
    if open_streams:
        print()
        print(c("1;31", "  ⚠ unclosed streams at end of capture:"))
        for src, s in open_streams.items():
            print(f"     {src}  (started {fmt_time(s.started_ts)})")
    # Footer: open timeline / in-flight actions at end of capture?
    if timeline_depth > 0 or open_actions:
        print()
        if timeline_depth > 0:
            print(c("1;31", f"  ⚠ timeline still open at end of capture (depth={timeline_depth})"))
        if open_actions:
            print(c("1;31", "  ⚠ in-flight timeline actions at end of capture:"))
            for key, st in open_actions.items():
                print(f"     {st.get('kind', '?')} · {key}")
    print()


# ──────────────────────────── cli ────────────────────────────────────


def parse_since(spec: str) -> int:
    """`5m` / `2h` / `90s` → ms ago. `<bare int>` → absolute ms epoch."""
    if spec.isdigit():
        return int(spec)
    unit = spec[-1].lower()
    n = int(spec[:-1])
    if unit == "s":
        delta_ms = n * 1000
    elif unit == "m":
        delta_ms = n * 60 * 1000
    elif unit == "h":
        delta_ms = n * 60 * 60 * 1000
    elif unit == "d":
        delta_ms = n * 24 * 60 * 60 * 1000
    else:
        raise ValueError(f"unknown time unit in {spec!r}")
    return int(time.time() * 1000) - delta_ms


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("Usage")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("thread_id", nargs="?", help="thread_id to render; omit for most-recent anam-web call")
    ap.add_argument("--since", default="1h", help="how far back to fetch (e.g. 5m, 2h, 1d). Default: 1h.")
    ap.add_argument("--follow", action="store_true", help="stream live (Ctrl-C to exit)")
    ap.add_argument("--json", action="store_true", help="dump raw events as JSONL instead of rendering")
    ap.add_argument("--prefix", default="anam-web-call-", help="thread_id prefix for auto-pick (default: anam-web-call-)")
    ap.add_argument(
        "--include-debug",
        action="store_true",
        help="include level=debug events (the llm.call forensic trace stream)",
    )
    args = ap.parse_args()

    token = load_viewer_token()
    since_ms = parse_since(args.since)

    # ─── One-shot fetch ──────────────────────────────────────────────
    # Preferred path: /api/logs.jsonl with server-side thread_id +
    # since filtering. That's O(thread) on the wire instead of
    # O(firehose) — much faster and avoids the Fly edge timeout
    # entirely on selective queries.
    #
    # Fallback path: /api/logs.tail SSE firehose + client-side filter.
    # Used when the jsonl proxy 502s (old pat-frontend deploy missing
    # the keepalive fix) or returns no result for the discovery query.

    events: list[dict] = []
    thread: str | None = args.thread_id

    if thread:
        result = fetch_events_jsonl(
            token,
            since_ms=since_ms,
            thread_id=thread,
            include_debug=args.include_debug,
        )
        if result is None:
            sys.stderr.write(
                "(jsonl proxy returned 502/504 — falling back to SSE firehose; "
                "deploy pat-frontend + nanoclaw for the fast path)\n"
            )
            sse_events = list(
                fetch_events_sse(
                    token, since_ms=since_ms, until_ms=int(time.time() * 1000)
                )
            )
            events = [e for e in sse_events if e.get("thread_id") == thread]
        else:
            events = result
    else:
        # Auto-pick: try a server-side discovery scan first; fall back
        # to SSE firehose if the jsonl endpoint is unreachable.
        result = fetch_events_jsonl(
            token,
            since_ms=since_ms,
            kind="inbound.received",
            include_debug=args.include_debug,
        )
        if result is None:
            sys.stderr.write(
                "(jsonl proxy returned 502/504 — falling back to SSE firehose; "
                "deploy pat-frontend + nanoclaw for the fast path)\n"
            )
            sse_events = list(
                fetch_events_sse(
                    token, since_ms=since_ms, until_ms=int(time.time() * 1000)
                )
            )
            thread = auto_pick_thread(sse_events, args.prefix)
            if not thread:
                sys.stderr.write(
                    f"no thread found with prefix {args.prefix!r} in last {args.since}\n"
                    f"  (scanned {len(sse_events)} firehose events)\n"
                )
                return 1
            events = [e for e in sse_events if e.get("thread_id") == thread]
        else:
            thread = auto_pick_thread(result, args.prefix)
            if not thread:
                sys.stderr.write(
                    f"no thread found with prefix {args.prefix!r} in last {args.since}\n"
                    f"  (scanned {len(result)} inbound.received events)\n"
                )
                return 1
            thread_events = fetch_events_jsonl(
                token,
                since_ms=since_ms,
                thread_id=thread,
                include_debug=args.include_debug,
            )
            if thread_events is None:
                # second jsonl call 502'd — fall back to SSE for the
                # full thread fetch.
                sys.stderr.write(
                    "(jsonl thread fetch 502'd — falling back to SSE firehose)\n"
                )
                sse_events = list(
                    fetch_events_sse(
                        token, since_ms=since_ms, until_ms=int(time.time() * 1000)
                    )
                )
                events = [e for e in sse_events if e.get("thread_id") == thread]
            else:
                events = thread_events

    if not args.follow:
        if args.json:
            for ev in events:
                print(json.dumps(ev))
            return 0
        render(events, thread)
        return 0

    # ─── Follow mode ─────────────────────────────────────────────────
    # Render the pre-scan, then keep streaming via SSE and append new
    # events for the chosen thread as they arrive.
    if not args.json:
        render(events, thread)
    last_ts = events[-1]["ts"] if events else None
    sys.stderr.write(f"(following {thread}…)\n")
    try:
        for ev in fetch_events_sse(token, since_ms=since_ms, follow=True):
            if ev.get("thread_id") != thread:
                continue
            if last_ts and ev["ts"] <= last_ts:
                continue
            last_ts = ev["ts"]
            if args.json:
                print(json.dumps(ev))
                sys.stdout.flush()
            else:
                render([ev], thread)
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
