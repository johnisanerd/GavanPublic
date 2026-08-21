#!/usr/bin/env python3
"""
Pull recent logs from pat-nanoclaw + pat-transports, merge them in
chronological order, and write a transcript.json that test-viewer can
display alongside smoketest scenarios.

Usage:
    scripts/fly-call-log.py
        # Last 10 minutes from both apps. Writes to:
        # nanoclaw/data/v2-sessions/_smoketest/live-<UTC-ts>/

    scripts/fly-call-log.py --since 5m
    scripts/fly-call-log.py --thread call-d85c34fb56ae
        # Filter to one phone-call thread end-to-end (recommended).

    scripts/fly-call-log.py --watch
        # Re-fetch every 10s into the same output dir; the viewer's
        # refresh button will pick up new entries. (Not true streaming,
        # but feels close enough for active debugging.)

Reads tokens from `.env.agent`:
    - FLY_DEPLOY_TOKEN_NANOCLAW
    - FLY_DEPLOY_TOKEN_TRANSPORTS

The viewer (../test-viewer/) lists entries from transcript.json by
timestamp; this script produces the same shape, with `source` set to
'nanoclaw' or 'voice-transport' so they're visually distinguishable.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

REPO_ROOT = Path(__file__).resolve().parent.parent
SECRETS_FILE = REPO_ROOT / ".env.agent"
SMOKETEST_DIR = REPO_ROOT / "nanoclaw" / "data" / "v2-sessions" / "_smoketest"

ANSI = re.compile(r"\x1b\[[0-9;]*m")

# Two log shapes both start with Fly's wrapping ISO-second timestamp
# and the same `app[machine] region [level]` framing, then differ on
# whether the inner sub-second ISO timestamp is in brackets:
#
#   nanoclaw:  ...[info] [2026-05-06T22:54:31.511Z] INFO inbound: …
#   voice-transport (loguru/stdlib):
#              ...[info]2026-05-06T22:55:08.143Z INFO line.voice_…
#
# So the inner ts bracket is optional and so is the space before it.
NANOCLAW_LINE = re.compile(
    r"^(?P<fly_ts>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s+"
    r"\S+\[\S+\]\s+\S+\s+\[\w+\]\s*"
    r"\[?(?P<inner_ts>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)?\]?\s*"
    r"(?P<rest>.*)$"
)


def read_token(name: str) -> str:
    """Read FLY_DEPLOY_TOKEN_X from .env.agent — fail loudly if missing."""
    if not SECRETS_FILE.exists():
        sys.exit(f"missing secrets file: {SECRETS_FILE}")
    for line in SECRETS_FILE.read_text().splitlines():
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1]
    sys.exit(f"missing secret: {name} in {SECRETS_FILE}")


def fly_logs(app: str, token: str) -> list[str]:
    """One-shot dump of recent logs for an app. Fly's `--no-tail` returns
    whatever's currently in their buffer (~last 10 min in practice)."""
    fly_bin = shutil.which("flyctl") or shutil.which("fly")
    if not fly_bin:
        sys.exit("flyctl not on PATH; brew install flyctl")
    import os
    env = os.environ.copy()
    env["FLY_API_TOKEN"] = token
    res = subprocess.run(
        [fly_bin, "logs", "--app", app, "--no-tail"],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if res.returncode != 0:
        print(f"warn: {app}: {res.stderr.strip()[:200]}", file=sys.stderr)
        return []
    return res.stdout.splitlines()


def persistent_logs(token: str, since_ms: int = 0, until_ms: int | None = None, date: str | None = None) -> list[str]:
    """Fetch from nanoclaw's `/admin/logs.jsonl` endpoint — the durable
    on-volume log file. Survives Fly buffer rolls, deploys, restarts.
    Returns a list of pseudo-Fly-format lines so existing parse_lines()
    can chew them with no changes (we synthesize the wrapping prefix).

    Implementation: SSH-tunnel via `flyctl ssh console -C curl` since the
    endpoint is on the internal network (fly-proxy doesn't expose 8765
    publicly). Trades latency for not punching a public hole.
    """
    fly_bin = shutil.which("flyctl") or shutil.which("fly")
    if not fly_bin:
        sys.exit("flyctl not on PATH; brew install flyctl")
    import os
    env = os.environ.copy()
    env["FLY_API_TOKEN"] = token
    qs = [f"since={since_ms}"]
    if until_ms is not None:
        qs.append(f"until={until_ms}")
    if date:
        qs.append(f"date={date}")
    url = f"http://127.0.0.1:8765/admin/logs.jsonl?{'&'.join(qs)}"
    res = subprocess.run(
        [fly_bin, "ssh", "console", "--app", "pat-nanoclaw", "-C", f"curl -sS '{url}'"],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if res.returncode != 0:
        print(f"warn: persistent log fetch: {res.stderr.strip()[:300]}", file=sys.stderr)
        return []
    # Convert JSONL → pseudo-Fly-format lines parseable by parse_lines.
    out: list[str] = []
    for raw in res.stdout.splitlines():
        if not raw.strip():
            continue
        try:
            j = json.loads(raw)
        except Exception:
            continue
        ts = j.get("ts", "")
        level = j.get("level", "info").upper()
        msg = j.get("msg", "")
        # Reconstruct fields for downstream consumers.
        extras = " ".join(
            f"{k}={json.dumps(v) if not isinstance(v, str) else json.dumps(v)}"
            for k, v in j.items()
            if k not in ("ts", "level", "msg")
        )
        # Pseudo-Fly prefix so NANOCLAW_LINE matches: `<flyTs> app[mach] region [level] [innerTs] rest`.
        # We only have innerTs (ours); fly_ts not strictly required for parse.
        fly_ts = ts.split(".")[0] + "Z" if ts else "1970-01-01T00:00:00Z"
        line = f"{fly_ts} app[X] region [{level.lower()}] [{ts}] {level} {msg} {extras}".rstrip()
        out.append(line)
    return out


@dataclass
class Entry:
    ts_ms: int
    source: str
    text: str

    def to_dict(self) -> dict:
        return {"ts": self.ts_ms, "source": self.source, "text": self.text}


def parse_ts(s: str) -> int | None:
    """ISO8601 with optional fractional seconds → ms since epoch (UTC)."""
    s = s.strip()
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except ValueError:
        return None


def parse_lines(lines: Iterable[str], source: str) -> list[Entry]:
    """Best-effort: extract a timestamp from each Fly-prefixed log line.
    Skip lines we can't parse rather than guess; the viewer is sturdier
    with fewer well-formed entries than many half-broken ones."""
    out: list[Entry] = []
    for raw in lines:
        line = ANSI.sub("", raw)
        m = NANOCLAW_LINE.match(line)
        if not m:
            continue
        # Inner ISO timestamp (from our own logger) is more precise than
        # Fly's wrapping one — prefer it when present.
        ts_str = m.group("inner_ts") or m.group("fly_ts")
        ts_ms = parse_ts(ts_str)
        if ts_ms is None:
            continue
        text = m.group("rest").strip()
        if not text:
            continue
        out.append(Entry(ts_ms=ts_ms, source=source, text=text))
    return out


def filter_thread(entries: list[Entry], thread: str) -> list[Entry]:
    """Slice to entries that mention the call thread id, plus a small
    pre/post window so we keep wider context (banter layer events don't
    always reference threadId in the line)."""
    matched_idxs = [i for i, e in enumerate(entries) if thread in e.text]
    if not matched_idxs:
        return []
    lo = max(0, matched_idxs[0] - 5)
    hi = min(len(entries), matched_idxs[-1] + 5)
    return entries[lo:hi]


def write_capture(entries: list[Entry], out_dir: Path, label: str) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    start_ts = entries[0].ts_ms if entries else int(time.time() * 1000)
    transcript = {
        "startTs": start_ts,
        "entries": [e.to_dict() for e in entries],
        "metadata": {"capture": label, "fly_apps": ["pat-nanoclaw", "pat-transports"]},
    }
    (out_dir / "transcript.json").write_text(json.dumps(transcript, indent=2))
    # Minimal result.json so the viewer's run-grouper recognizes it.
    (out_dir / "result.json").write_text(
        json.dumps({"scenario": label, "passed": None, "durationMs": 0, "outcomes": []}, indent=2)
    )
    # Markdown render, mirroring smoketest convention.
    md_lines = [f"# {label}", f"Captured {datetime.fromtimestamp(start_ts/1000, tz=timezone.utc).isoformat()}Z", ""]
    for e in entries:
        ts = datetime.fromtimestamp(e.ts_ms / 1000, tz=timezone.utc).strftime("%H:%M:%S.%f")[:-3]
        md_lines.append(f"`{ts}` **[{e.source}]** {e.text}")
    (out_dir / "transcript.md").write_text("\n".join(md_lines) + "\n")


# ───────────────────────── Timeline rendering ──────────────────────────
#
# Distill the unified log into a fixed set of "tracks" — each track is
# one type of activity rendered horizontally with seconds as columns.
# Spans (e.g. user speaking) are `=`; instantaneous events are `*`. The
# resulting file is meant to be read in `less -S timeline.txt` so you
# can scroll left/right and visually see overlap. Way easier than
# eyeballing 200 lines of unified log to figure out who was talking
# when.
#
# Tracks (top-down, ordered by causality of a turn):
#   user-speaking      🧑🔊…🧑🔇           (voice-transport STT span)
#   inbound-post       *                    user turn POST'd to nanoclaw
#   banter-call        *                    front-mind banter line emitted
#   forward-decided    *                    request layer says forward
#   container-spawn    =====                "Spawning container" → first
#                                            narration poll on that session
#   back-mind          =====                forward-decided → query-end
#   narrator-haiku     ==                   "haiku call: start" → "result"
#   rendition          ==                   "chat → banter rendition"
#                                            (has renderMs, so a span)
#   chat-row           *                    "narration: chat row seen"
#   agent-tts          =====                Agent started…stopped speaking

@dataclass
class Span:
    kind: str        # short, fixed-width track label rendered in the [bracket] column
    start_ms: int
    end_ms: int      # for instants: end_ms == start_ms
    label: str = ""  # truncated text/result for the right-hand column
    line_no: int = 0 # 1-based index into transcript.md so user can correlate
    src: str = ""    # nanoclaw / voice-transport, for the prefix tag

# Width of the [kind] column. Pad all kind labels to this so bars line up.
KIND_W = 11

# Regexes scoped to the *rest* of the log line (after the timestamp/ANSI strip).
RE_USER_START = re.compile(r"User started speaking")
RE_USER_STOP = re.compile(r"User stopped speaking")
RE_AGENT_START = re.compile(r"Agent started speaking")
RE_AGENT_STOP = re.compile(r"Agent stopped speaking")
# Full-utterance text (one line per utterance). Distinguish from
# per-word lines by the function-name prefix:
#   _map_output_event:640 <- 🤖🗣️ Agent said: "FULL"  ← what we want
#   _process_input_event:593 -> 🤖🗣️ Agent said: "word"  ← skip
# PAT: spoken text can contain literal `"` (e.g. inside `<emotion value="X">`
# voice tags). The naive `[^"]*` capture stopped at the first inner `"`,
# producing nonsense bar labels like `<em … ue="`. Match through the line
# end and trim the trailing `"` afterwards. The line is from the structured
# loguru/voice-transport logger which always wraps the utterance in `"..."`
# at the end of the line, so this is safe.
RE_AGENT_FULL = re.compile(r'_map_output_event[^"]*Agent said: "(.*)"$')
RE_USER_FULL = re.compile(r'User said: "(.*)"$')
RE_INBOUND_POST = re.compile(r"inbound POST text=\"([^\"]*)\"")
RE_BANTER = re.compile(r"inbound: banter layer text=\"([^\"]*)\"")
RE_FORWARD = re.compile(r"inbound: request layer decision decision=\"forward\"")
RE_SPAWN = re.compile(r"Spawning container sessionId=\"([^\"]+)\"")
RE_POLL = re.compile(r"narration: poll picked up rows sessionId=\"([^\"]+)\"")
RE_QUERY_END = re.compile(r"query-end \(isProcessing=false\)")
RE_HAIKU_START = re.compile(r"narration\[[^\]]+\]: haiku call: start")
RE_HAIKU_RESULT = re.compile(r"narration\[[^\]]+\]: haiku call: result utterance=\"([^\"]*)\"")
RE_RENDITION = re.compile(r"chat → banter rendition renderMs=(\d+) .*?renderedText=\"([^\"]*)\"")
RE_CHAT_ROW = re.compile(
    # The preview field contains backslash-escaped quotes — need to
    # match through them. Allow either an escaped char (\.) or any
    # non-quote, repeated, then a closing real quote.
    r'narration: chat row seen sessionId="[^"]+" seq=\d+ preview="((?:\\.|[^"])*)"'
)
# Chat-row previews are JSON-wrapped (`{\"text\":\"…actual text…\"`).
# Strip the wrapper so the timeline shows the response, not the JSON shell.
RE_CHAT_PREVIEW_TEXT = re.compile(r'^\{\\"text\\":\\"(.*?)(?:\\"|$)')


def extract_spans(entries: list[Entry]) -> list[Span]:
    """Walk the log and produce one Span per detected event/end pair.
    Each span carries the index (1-based) of the line in transcript.md
    where the END (for spans) or the event itself (for instants)
    happens, so the user can correlate timeline → transcript line."""
    spans: list[Span] = []
    open_user: tuple[int, int] | None = None    # (start_ms, start_idx)
    open_agent: tuple[int, int] | None = None
    open_haiku: tuple[int, int] | None = None
    open_back_mind: tuple[int, int] | None = None
    open_spawn: tuple[int, int, str] | None = None  # (start_ms, start_idx, sessionId)
    seen_poll_for: set[str] = set()
    # Buffer the most-recent full utterance line so we can attach its
    # text to the next-closing speech span (start/stop logs don't carry
    # the text inline).
    pending_user_text: str | None = None
    pending_agent_text: str | None = None
    for idx, e in enumerate(entries, start=1):
        t = e.text
        line_no = idx
        if RE_USER_START.search(t):
            open_user = (e.ts_ms, idx)
        elif RE_USER_STOP.search(t) and open_user is not None:
            spans.append(
                Span("user-speak", open_user[0], e.ts_ms, pending_user_text or "", line_no, e.source)
            )
            open_user = None
            pending_user_text = None
        elif RE_AGENT_START.search(t):
            open_agent = (e.ts_ms, idx)
        elif RE_AGENT_STOP.search(t) and open_agent is not None:
            spans.append(
                Span("agent-tts", open_agent[0], e.ts_ms, pending_agent_text or "", line_no, e.source)
            )
            open_agent = None
            pending_agent_text = None
        elif (m := RE_AGENT_FULL.search(t)):
            pending_agent_text = m.group(1)
        elif (m := RE_USER_FULL.search(t)):
            pending_user_text = m.group(1)
        elif (m := RE_INBOUND_POST.search(t)):
            spans.append(Span("inbound", e.ts_ms, e.ts_ms, m.group(1)[:60], line_no, e.source))
        elif (m := RE_BANTER.search(t)):
            spans.append(Span("banter", e.ts_ms, e.ts_ms, m.group(1)[:60], line_no, e.source))
        elif RE_FORWARD.search(t):
            spans.append(Span("forward", e.ts_ms, e.ts_ms, "", line_no, e.source))
            if open_back_mind is None:
                open_back_mind = (e.ts_ms, idx)
        elif (m := RE_SPAWN.search(t)):
            open_spawn = (e.ts_ms, idx, m.group(1))
        elif (m := RE_POLL.search(t)):
            sid = m.group(1)
            if open_spawn is not None and open_spawn[2] == sid and sid not in seen_poll_for:
                spans.append(Span("spawn", open_spawn[0], e.ts_ms, "", line_no, e.source))
                open_spawn = None
                seen_poll_for.add(sid)
        elif RE_QUERY_END.search(t) and open_back_mind is not None:
            spans.append(Span("back-mind", open_back_mind[0], e.ts_ms, "", line_no, e.source))
            open_back_mind = None
        elif RE_HAIKU_START.search(t):
            open_haiku = (e.ts_ms, idx)
        elif (m := RE_HAIKU_RESULT.search(t)) and open_haiku is not None:
            spans.append(Span("narrator", open_haiku[0], e.ts_ms, m.group(1)[:60], line_no, e.source))
            open_haiku = None
        elif (m := RE_RENDITION.search(t)):
            render_ms = int(m.group(1))
            spans.append(Span("rendition", e.ts_ms - render_ms, e.ts_ms, m.group(2)[:60], line_no, e.source))
        elif (m := RE_CHAT_ROW.search(t)):
            preview_raw = m.group(1)
            inner = RE_CHAT_PREVIEW_TEXT.match(preview_raw)
            preview = (inner.group(1) if inner else preview_raw).replace("\\n", " ")[:60]
            spans.append(Span("chat-row", e.ts_ms, e.ts_ms, preview, line_no, e.source))
    # Sort by event time. Spans use end-time (point of recognition) since
    # that's when we knew about them; matches how a log file orders.
    # Keep instants and span-ends interleaved by time.
    spans.sort(key=lambda s: (s.end_ms, s.start_ms))
    return spans


def render_timeline(
    entries: list[Entry],
    spans: list[Span],
    chars_per_sec: float = 1.0,
    section_secs: int = 120,
) -> str:
    """Log-file-style timeline. One line per event:
       <wall-clock> L<n> [<kind>] <bar>  <truncated text>
       Bar position/width reflects when the event happened in the
       current section's time window. Sections wrap every section_secs.
       An event prints in the section where it STARTS; if it extends
       past the section end, the bar terminates with `>` to indicate
       continuation, with the duration in parens at line end.
    """
    if not entries:
        return "(no entries)\n"
    out: list[str] = []
    t0 = entries[0].ts_ms
    bar_width = int(section_secs * chars_per_sec)

    def section_for(ts_ms: int) -> int:
        return (ts_ms - t0) // (section_secs * 1000)

    # Group spans by section (based on start_ms).
    by_section: dict[int, list[Span]] = {}
    for sp in spans:
        by_section.setdefault(section_for(sp.start_ms), []).append(sp)

    if not by_section:
        return "(no spans extracted from logs)\n"

    # Only emit sections that actually contain events. Skipping empty
    # sections keeps the file scannable when log entries are sparse or
    # cluster heavily in time.
    for sec in sorted(by_section.keys()):
        sec_t0_ms = t0 + sec * section_secs * 1000
        sec_t1_ms = sec_t0_ms + section_secs * 1000
        wall = datetime.fromtimestamp(sec_t0_ms / 1000, tz=timezone.utc).strftime("%H:%M:%S")
        rel = sec * section_secs
        ruler = [" "] * bar_width
        for s_off in range(0, section_secs + 1, 10):
            c = int(s_off * chars_per_sec)
            if c < bar_width:
                lbl = f"{rel + s_off}s"
                for i, ch in enumerate(lbl):
                    if c + i < bar_width:
                        ruler[c + i] = ch
        header_prefix = f"─── {wall}Z  T+{rel}s "
        out.append(header_prefix + "─" * max(0, 80 - len(header_prefix)))
        out.append(_pad_prefix() + "".join(ruler))
        for sp in by_section.get(sec, []):
            line = _format_event_line(sp, sec_t0_ms, sec_t1_ms, chars_per_sec, bar_width)
            out.append(line)
        out.append("")
    return "\n".join(out)


_PREFIX_W = len("HH:MM:SS.fff L0000 [           ] ")


def _pad_prefix() -> str:
    return " " * _PREFIX_W


SPEECH_KINDS = {"user-speak", "agent-tts"}


def _middle_ellipsize(text: str, width: int) -> str:
    """Trim text to width with a middle ellipsis: `keep first … keep last`.
    For very narrow widths where a middle ellipsis can't fit even one
    char on each side, fall back to a left-truncated form like `He…` —
    still gives the user a visual hint of what was said instead of a
    line of dots. Full text always lives in the line's suffix anyway."""
    if width <= 0 or not text:
        return ""
    if len(text) <= width:
        return text
    if width < 7:
        # Too narrow for middle-ellipsis; truncate to first chars + `…`.
        return text[: max(1, width - 1)] + "…"
    # Reserve 3 chars for ` … ` (space ellipsis space) for readability.
    keep = width - 3
    left = keep // 2
    right = keep - left
    return text[:left] + " … " + text[-right:]


def _format_event_line(
    sp: Span, sec_t0_ms: int, sec_t1_ms: int, chars_per_sec: float, bar_width: int
) -> str:
    wall = datetime.fromtimestamp(sp.start_ms / 1000, tz=timezone.utc).strftime("%H:%M:%S.%f")[:-3]
    line_ref = f"L{sp.line_no:04d}"
    kind = f"[{sp.kind:<{KIND_W}}]"
    prefix = f"{wall} {line_ref} {kind} "
    bar = [" "] * bar_width
    c0 = max(0, int(((sp.start_ms - sec_t0_ms) / 1000.0) * chars_per_sec))
    if sp.end_ms == sp.start_ms:
        # Instantaneous event — single `*` at the column.
        if 0 <= c0 < bar_width:
            bar[c0] = "*"
        suffix = f'  "{sp.label}"' if sp.label else ""
        return prefix + "".join(bar) + suffix
    # Span. Clip end to section. Mark continuation with `>`.
    end_ms = min(sp.end_ms, sec_t1_ms)
    c1 = max(c0, int(((end_ms - sec_t0_ms) / 1000.0) * chars_per_sec))
    span_w = max(1, c1 - c0 + 1)
    if sp.kind in SPEECH_KINDS and sp.label:
        # Render the spoken text inline as `"start … end"` positioned
        # at the speech-start column. No bracket characters — the quotes
        # delimit the span, the column position shows when, and the
        # middle ellipsis preserves both ends of what was actually said.
        # Reserve 2 chars for the surrounding quotes.
        text_w = max(0, span_w - 2)
        rendered = _middle_ellipsize(sp.label, text_w)
        # If the text is shorter than the time-span width, center it
        # between the two quote marks; the gap is implicit silence
        # within the speaking window (very rare for actual speech).
        if len(rendered) < text_w:
            pad_left = (text_w - len(rendered)) // 2
            rendered = " " * pad_left + rendered + " " * (text_w - len(rendered) - pad_left)
        body = '"' + rendered + '"'
        # Mark continuation when the speech extends past the section.
        if sp.end_ms > sec_t1_ms:
            # Replace the closing quote with `>` to signal continuation.
            body = body[:-1] + ">"
        for i, ch in enumerate(body):
            c = c0 + i
            if 0 <= c < bar_width:
                bar[c] = ch
    else:
        # Non-speech span: bracketed bar `[====]` (or `[===>` if
        # continuing past the section).
        for c in range(c0, min(c1 + 1, bar_width)):
            bar[c] = "="
        if 0 <= c0 < bar_width:
            bar[c0] = "["
        if sp.end_ms <= sec_t1_ms and 0 <= c1 < bar_width:
            bar[c1] = "]"
        elif sp.end_ms > sec_t1_ms and 0 <= min(c1, bar_width - 1) < bar_width:
            bar[min(c1, bar_width - 1)] = ">"
    dur_ms = sp.end_ms - sp.start_ms
    dur_str = f"{dur_ms / 1000:.1f}s"
    if sp.kind in SPEECH_KINDS and sp.label:
        # Full text in suffix so an ellipsized bar still gives the
        # complete utterance for grepping / context.
        suffix = f'  ({dur_str}) "{sp.label}"'
    elif sp.label:
        suffix = f'  ({dur_str}) "{sp.label}"'
    else:
        suffix = f"  ({dur_str})"
    return prefix + "".join(bar) + suffix


def split_calls(entries: list[Entry]) -> list[list[Entry]]:
    """Split entries into per-call chunks. Bounded by the voice-transport
    `📞 Call started` / `📞 Call ended` emoji markers (specifically — the
    string `Call started:` also appears in our own logger and would
    over-split). If neither marker is present, treat as one call."""
    calls: list[list[Entry]] = []
    cur: list[Entry] = []
    for e in entries:
        if "📞 Call started" in e.text:
            if cur:
                calls.append(cur)
            cur = [e]
        elif "📞 Call ended" in e.text:
            cur.append(e)
            calls.append(cur)
            cur = []
        else:
            cur.append(e)
    if cur:
        calls.append(cur)
    return calls or [entries]


def write_timeline(
    entries: list[Entry],
    out_dir: Path,
    chars_per_sec: float = 1.0,
    section_secs: int = 120,
) -> None:
    calls = split_calls(entries)
    out: list[str] = []
    out.append("# Timeline")
    out.append("")
    out.append(
        f"# {chars_per_sec} char/sec, {section_secs}s sections. "
        "Read like a log: each line is one event at its real time. "
        "Span lines show [====] (or [===> if continuing past section). "
        "Instants show *. L#### refers to the line in transcript.md."
    )
    out.append("")
    for i, call in enumerate(calls, 1):
        if not call:
            continue
        spans = extract_spans(call)
        t0 = datetime.fromtimestamp(call[0].ts_ms / 1000, tz=timezone.utc).strftime("%H:%M:%S")
        out.append(f"## Call {i} — starts {t0}Z — {len(call)} log entries, {len(spans)} spans")
        out.append("")
        out.append(render_timeline(call, spans, chars_per_sec, section_secs))
        out.append("")
    (out_dir / "timeline.txt").write_text("\n".join(out))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--thread", help="filter to one phone-call thread id (e.g. call-d85c34fb56ae)")
    ap.add_argument("--watch", action="store_true", help="re-fetch every 10s into the same output dir")
    ap.add_argument("--label", default=None, help="label for the capture dir; default = live-<utc-ts>")
    ap.add_argument("--out-root", default=str(SMOKETEST_DIR), help="parent dir for output (default: viewer dir)")
    ap.add_argument(
        "--replay",
        default=None,
        help="rebuild timeline.txt from an existing capture dir's transcript.json; skips Fly fetch",
    )
    ap.add_argument(
        "--timeline",
        action="store_true",
        default=True,
        help="emit timeline.txt alongside transcript (default: on; --no-timeline to disable)",
    )
    ap.add_argument("--no-timeline", action="store_false", dest="timeline")
    ap.add_argument(
        "--timeline-chars-per-sec",
        type=float,
        default=1.0,
        help="bar resolution (default 1 char/sec; raise for finer detail)",
    )
    ap.add_argument(
        "--timeline-section-secs",
        type=int,
        default=120,
        help="section wrap window in seconds (default 120)",
    )
    ap.add_argument(
        "--source",
        choices=["fly", "persistent"],
        default="fly",
        help="fly = `flyctl logs --no-tail` (rolls every ~7-10min); "
        "persistent = nanoclaw's on-volume host.jsonl (durable forever)",
    )
    ap.add_argument(
        "--date",
        default=None,
        help="when --source=persistent: YYYY-MM-DD UTC; default = today",
    )
    args = ap.parse_args()

    if args.replay:
        # Re-render timeline from a saved transcript.json. Lets you
        # iterate on the timeline format without re-pulling from Fly.
        replay_dir = Path(args.replay)
        tj = replay_dir / "transcript.json"
        if not tj.exists():
            sys.exit(f"--replay: no transcript.json at {tj}")
        data = json.loads(tj.read_text())
        entries = [Entry(ts_ms=e["ts"], source=e["source"], text=e["text"]) for e in data["entries"]]
        write_timeline(entries, replay_dir, args.timeline_chars_per_sec, args.timeline_section_secs)
        print(f"[fly-call-log] re-rendered timeline → {replay_dir / 'timeline.txt'}", file=sys.stderr)
        return 0

    label = args.label or f"live-{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%SZ')}"
    out_dir = Path(args.out_root) / label

    nano_token = read_token("FLY_DEPLOY_TOKEN_NANOCLAW")
    vt_token = read_token("FLY_DEPLOY_TOKEN_TRANSPORTS")

    while True:
        if args.source == "persistent":
            # Pull from nanoclaw's durable on-volume log. voice-transport
            # remains buffer-only for now (no /admin/log-event forwarding
            # yet); critical voice-transport events that hit nanoclaw via
            # /inbound /agent-turn-ended /call-ended are already in the
            # nanoclaw stream so we get most of what we need.
            nano = parse_lines(persistent_logs(nano_token, date=args.date), "nanoclaw")
            vt = parse_lines(fly_logs("pat-transports", vt_token), "voice-transport")
        else:
            nano = parse_lines(fly_logs("pat-nanoclaw", nano_token), "nanoclaw")
            vt = parse_lines(fly_logs("pat-transports", vt_token), "voice-transport")
        merged = sorted(nano + vt, key=lambda e: e.ts_ms)
        if args.thread:
            merged = filter_thread(merged, args.thread)
        write_capture(merged, out_dir, label)
        if args.timeline:
            write_timeline(merged, out_dir, args.timeline_chars_per_sec, args.timeline_section_secs)
        print(f"[fly-call-log] wrote {len(merged)} entries → {out_dir}", file=sys.stderr)
        if not args.watch:
            return 0
        time.sleep(10)


if __name__ == "__main__":
    sys.exit(main())
