# /// script
# requires-python = ">=3.11"
# dependencies = ["textual>=0.85", "httpx>=0.27"]
# ///
"""
pat-observability live tail TUI.

A scrolling, colorized live tail of the centralized PAT log store (OpenObserve),
with a filter line at the bottom that takes `column:"substring"` pairs (and bare
full-text terms) and compiles them to SQL.

Run (with the store proxy up — `pat-observability/scripts/proxy.sh`):
    uv run pat-observability/tui/tail.py
    uv run pat-observability/tui/tail.py --stream pat_raw

Filter line examples (Enter to apply, clears + re-backfills):
    kind:"llm" env:"prod"
    thread:"call-7af3"           (thread -> thread_id; session -> session_id)
    level:"error"
    data.tool:"Bash"             (dotted -> flattened data_tool)
    getServerGuid                (bare term -> full-text match_all, great for pat_raw)

Keys:  Enter apply filter · ctrl+s toggle stream (pat_events/pat_raw) · ctrl+l clear · ctrl+c quit

Config (env, or auto-loaded from agentic_toolkit/.agent-secrets):
    OPENOBSERVE_URL (default http://127.0.0.1:5080), OPENOBSERVE_ORG (default),
    OPENOBSERVE_USER, OPENOBSERVE_PASSWORD
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
from pathlib import Path

import httpx


# ---- config -----------------------------------------------------------------

def _load_secrets() -> dict[str, str]:
    """Pull creds from the gitignored .observability-secrets (repo root), with
    agentic_toolkit/.agent-secrets as a fallback. Values are verbatim (the '#'
    in the password is preserved)."""
    out: dict[str, str] = {}
    here = Path(__file__).resolve()
    bases = [here.parent, *here.parents]
    for base in bases:  # 1) .observability-secrets (ancestor of tui/)
        cand = base / ".observability-secrets"
        if cand.exists():
            for line in cand.read_text().splitlines():
                t = line.strip()
                if t and not t.startswith("#") and "=" in t:
                    k, v = t.split("=", 1)
                    out[k.strip()] = v
            return out
    for base in bases:  # 2) fallback: agentic_toolkit/.agent-secrets
        cand = base / "agentic_toolkit" / ".agent-secrets"
        if cand.exists():
            for line in cand.read_text().splitlines():
                t = line.strip()
                if t.startswith("OPENOBSERVE_") and "=" in t:
                    k, v = t.split("=", 1)
                    out[k] = v
            break
    return out


_SECRETS = _load_secrets()


def cfg(name: str, default: str = "") -> str:
    return os.environ.get(name) or _SECRETS.get(name) or default


OO_URL = cfg("OPENOBSERVE_URL", "http://127.0.0.1:5080").rstrip("/")
OO_ORG = cfg("OPENOBSERVE_ORG", "default")
OO_USER = cfg("OPENOBSERVE_USER")
OO_PASS = cfg("OPENOBSERVE_PASSWORD")
AUTH = "Basic " + base64.b64encode(f"{OO_USER}:{OO_PASS}".encode()).decode()


# ---- filter parsing ---------------------------------------------------------

# shorthands -> real columns; dotted data.x -> flattened data_x
_COL_ALIAS = {"thread": "thread_id", "session": "session_id", "app_name": "app"}


def _col(name: str) -> str:
    name = _COL_ALIAS.get(name, name)
    return name.replace(".", "_")


def _esc(v: str) -> str:
    return v.replace("'", "''")


# tokenizer: keeps quoted substrings together; allows a leading `-` for negation
_TOKEN_RE = re.compile(r'-?\w[\w.]*:"[^"]*"|-?\w[\w.]*:\S+|-?"[^"]+"|-?\S+')
_COLVAL_RE = re.compile(r'^(\w[\w.]*):"?(.*?)"?$')


def parse_filter(text: str) -> str:
    """Turn `col:"sub" -col:"x" bare` into a SQL WHERE fragment (no leading AND).

    `col:"v"`  -> col LIKE '%v%'              (substring match)
    `-col:"v"` -> (col IS NULL OR col NOT LIKE '%v%')   (exclude matches)
    `term`     -> match_all('term')          (full-text across the row)
    `-term`    -> NOT match_all('term')
    Shorthands: thread->thread_id, session->session_id; dotted data.x -> data_x.
    """
    clauses: list[str] = []
    for tok in _TOKEN_RE.findall(text.strip()):
        neg = tok.startswith("-")
        if neg:
            tok = tok[1:]
        m = _COLVAL_RE.match(tok)
        if m and ":" in tok:
            col, val = _col(m.group(1)), _esc(m.group(2))
            if neg:
                clauses.append(f"({col} IS NULL OR {col} NOT LIKE '%{val}%')")
            else:
                clauses.append(f"{col} LIKE '%{val}%'")
        else:
            term = _esc(tok.strip('"'))
            if term:
                clauses.append(f"NOT match_all('{term}')" if neg else f"match_all('{term}')")
    return " AND ".join(clauses)


# ---- query ------------------------------------------------------------------

# the observability stack's own apps — excluded from pat_raw by default so the
# tail isn't polluted by the pipeline watching itself. (pat_events is nanoclaw-
# only and never contains these, so the exclusion only applies to pat_raw.)
DEFAULT_EXCLUDE_APPS = ("pat-observability", "pat-log-forwarder", "pat-log-shipper")


def build_sql(stream: str, where: str, since_us: int, exclude_self: bool = True) -> str:
    clauses = [f"_timestamp > {since_us}"]
    if exclude_self and stream == "pat_raw":
        apps = ", ".join(f"'{a}'" for a in DEFAULT_EXCLUDE_APPS)
        clauses.append(f"app NOT IN ({apps})")
    if where:
        clauses.append(where)
    return f'SELECT * FROM "{stream}" WHERE ' + " AND ".join(clauses) + " ORDER BY _timestamp ASC LIMIT 300"


async def fetch_columns(client: httpx.AsyncClient, stream: str) -> list[str]:
    """Best-effort column list for a stream (so the user knows what to filter on)."""
    try:
        r = await client.get(
            f"{OO_URL}/api/{OO_ORG}/streams/{stream}/schema",
            headers={"authorization": AUTH},
            timeout=15.0,
        )
        r.raise_for_status()
        data = r.json()
        fields = data.get("schema") or data.get("settings", {}).get("schema") or []
        return sorted(f.get("name") for f in fields if isinstance(f, dict) and f.get("name"))
    except Exception:  # noqa: BLE001
        return []


async def search(client: httpx.AsyncClient, sql: str, start_us: int, end_us: int) -> list[dict]:
    r = await client.post(
        f"{OO_URL}/api/{OO_ORG}/_search",
        headers={"content-type": "application/json", "authorization": AUTH},
        json={"query": {"sql": sql, "start_time": start_us, "end_time": end_us, "from": 0, "size": 300}},
        timeout=20.0,
    )
    r.raise_for_status()
    return r.json().get("hits", [])


# ---- rendering --------------------------------------------------------------

_LEVEL_STYLE = {"error": "bold red", "fatal": "bold white on red", "warn": "yellow", "info": "green", "debug": "dim"}
_ENV_STYLE = {"prod": "bold cyan", "staging": "bold magenta"}


def _hhmmss(row: dict) -> str:
    ts = row.get("_timestamp")
    if isinstance(ts, (int, float)):
        lt = time.localtime(ts / 1_000_000)
        ms = int((ts / 1000) % 1000)
        return time.strftime("%H:%M:%S", lt) + f".{ms:03d}"
    return str(row.get("ts", ""))[11:23]


def _esc_markup(s: str) -> str:
    return s.replace("[", r"\[")


# pure-metric / noisy fields kept out of the inline body (still queryable + in the
# MCP); content fields shown first so message bodies are front-and-center.
_SKIP_FIELDS = {
    "data_seq", "data_system_prompt", "data_prompt_chars", "data_input_tokens",
    "data_output_tokens", "data_ttfb_ms", "data_latency_ms", "data_layer",
    "data_ok", "data_provider", "data_upstream_provider", "data_preview",
}
_CONTENT_ORDER = [
    "data_full_text", "data_text", "data_user_message", "data_response",
    "data_decision", "data_sender", "data_type", "data_tool",
    "data_error", "message",
]


def _unwrap(k: str, v):
    # chat rows store {"text": "..."} as a JSON string in data_full_text
    if k in ("data_full_text", "message") and isinstance(v, str) and v.startswith("{"):
        try:
            j = json.loads(v)
            if isinstance(j, dict) and "text" in j:
                return str(j["text"])
        except Exception:  # noqa: BLE001
            pass
    return v


def _body(row: dict) -> str:
    parts: list[str] = []
    seen: set[str] = set()
    for k in _CONTENT_ORDER:  # content fields first, big
        v = row.get(k)
        if v in (None, "", []) or k in seen:
            continue
        seen.add(k)
        sv = str(_unwrap(k, v)).replace("\n", " ")
        parts.append(f"[cyan]{k}[/]=[white]{_esc_markup(sv[:400])}[/]")
    for k in sorted(row):  # remaining data_* (model, etc.), small
        if not k.startswith("data_") or k in seen or k in _SKIP_FIELDS:
            continue
        v = row.get(k)
        if v in (None, "", []):
            continue
        sv = str(v).replace("\n", " ")
        parts.append(f"[dim cyan]{k}[/]=[dim]{_esc_markup(sv[:120])}[/]")
    return "  ".join(parts)


def render_row(stream: str, row: dict) -> str:
    t = _hhmmss(row)
    env = str(row.get("env", "?"))
    env_m = f"[{_ENV_STYLE.get(env, 'white')}]{env:<7}[/]"
    if stream == "pat_raw":
        app = str(row.get("app", "?"))
        msg = str(_unwrap("message", row.get("message", "")) or row.get("log", ""))
        return f"[dim]{t}[/] {env_m} [yellow]{app:<22}[/] {_esc_markup(msg)[:600]}"
    level = str(row.get("level", "info"))
    lvl_m = f"[{_LEVEL_STYLE.get(level, 'white')}]{level:<5}[/]"
    kind = str(row.get("kind", "?"))
    thread = str(row.get("thread_id") or "")[-10:]
    line = f"[dim]{t}[/] {env_m} {lvl_m} [bold]{kind:<26}[/] [dim]{thread:>10}[/]"
    body = _body(row)
    if body:
        line += f"  {body}"
    return line


# ---- selftest (non-TUI) -----------------------------------------------------

def selftest(filter_text: str, stream: str) -> int:
    where = parse_filter(filter_text)
    now_us = int(time.time() * 1_000_000)
    sql = build_sql(stream, where, now_us - 1800 * 1_000_000)
    print(f"OO_URL={OO_URL} stream={stream}")
    print(f"filter={filter_text!r} -> WHERE: {where or '(none)'}")
    print(f"SQL: {sql}")
    import asyncio

    async def go():
        async with httpx.AsyncClient() as c:
            hits = await search(c, sql, now_us - 1800 * 1_000_000, now_us + 60 * 1_000_000)
            print(f"--- {len(hits)} rows ---")
            for h in hits[-15:]:
                # strip rich markup for plain print
                print(re.sub(r"\[/?[^\]]*\]", "", render_row(stream, h)))

    try:
        asyncio.run(go())
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: {e}", file=sys.stderr)
        return 1


# ---- TUI --------------------------------------------------------------------

def run_tui(stream: str, exclude_self: bool = True) -> None:
    from textual.app import App, ComposeResult
    from textual.containers import Vertical
    from textual.widgets import Header, Footer, Input, RichLog
    from rich.columns import Columns
    from rich.text import Text

    class TailApp(App):
        CSS = """
        RichLog { background: $surface; }
        Input { dock: bottom; border: tall $accent; }
        """
        BINDINGS = [
            ("ctrl+s", "toggle_stream", "stream"),
            ("ctrl+f", "show_columns", "columns"),
            ("ctrl+l", "clear_log", "clear"),
            ("ctrl+c", "quit", "quit"),
        ]

        def __init__(self) -> None:
            super().__init__()
            self.stream = stream
            self.exclude_self = exclude_self
            self.where = ""
            self.last_us = int(time.time() * 1_000_000) - 60 * 1_000_000  # 60s backfill
            self.seen: set[str] = set()
            self.columns: set[str] = set()
            self.client: httpx.AsyncClient | None = None

        def compose(self) -> ComposeResult:
            yield Header(show_clock=True)
            yield Vertical(RichLog(highlight=False, markup=True, wrap=True, id="log"))
            yield Input(placeholder='filter: kind:"llm" -kind:"tts" thread:"call-7a"  ·  bare=full-text  ·  ctrl+f=columns', id="filter")
            yield Footer()

        def on_mount(self) -> None:
            self.client = httpx.AsyncClient()
            self._set_title()
            self.query_one("#log", RichLog).write(
                "[dim]ctrl+f: list columns to filter on · ctrl+s: switch stream · -col:\"x\" excludes[/]"
            )
            self.run_worker(self._load_columns(), exclusive=False)
            self.set_interval(1.5, self.poll)

        def _set_title(self) -> None:
            self.title = f"pat-observability · {self.stream}"
            excl = " · excl-self" if (self.exclude_self and self.stream == "pat_raw") else ""
            self.sub_title = f"filter: {self.where or '(none)'}{excl}"

        async def _load_columns(self) -> None:
            assert self.client is not None
            cols = await fetch_columns(self.client, self.stream)
            if cols:
                self.columns.update(cols)

        def action_show_columns(self) -> None:
            log = self.query_one("#log", RichLog)
            if not self.columns:
                log.write("[yellow]no columns seen yet — wait for events or check the proxy[/]")
                return
            # group by prefix: core (top-level) vs data.* (payload), each a clean grid
            core = sorted(c for c in self.columns if not c.startswith("data_") and c != "_timestamp")
            data = sorted(c[len("data_"):] for c in self.columns if c.startswith("data_"))
            log.write(Text(f"  columns · {self.stream}  ", style="bold black on cyan"))
            log.write('[bold]core[/] [dim]— filter as  col:"…"[/]')
            log.write(Columns([Text(c, style="cyan") for c in core], padding=(0, 3), equal=True, expand=True))
            if data:
                log.write('[bold]data.*[/] [dim]— filter as  data.<name>:"…"  (e.g. data.tool:"Bash")[/]')
                log.write(Columns([Text(c, style="green") for c in data], padding=(0, 3), equal=True, expand=True))

        async def poll(self) -> None:
            assert self.client is not None
            log = self.query_one("#log", RichLog)
            now_us = int(time.time() * 1_000_000)
            sql = build_sql(self.stream, self.where, self.last_us, self.exclude_self)
            try:
                hits = await search(self.client, sql, self.last_us, now_us + 60 * 1_000_000)
            except Exception as e:  # noqa: BLE001
                log.write(f"[red]query error: {e}[/]")
                return
            for h in hits:
                self.columns.update(h.keys())
                hid = str(h.get("id") or f"{h.get('_timestamp')}-{h.get('kind')}")
                if hid in self.seen:
                    continue
                self.seen.add(hid)
                ts = h.get("_timestamp")
                if isinstance(ts, (int, float)) and ts > self.last_us:
                    self.last_us = int(ts)
                log.write(render_row(self.stream, h))
            if len(self.seen) > 5000:
                self.seen = set(list(self.seen)[-2000:])

        async def on_input_submitted(self, event: Input.Submitted) -> None:
            self.where = parse_filter(event.value)
            self.last_us = int(time.time() * 1_000_000) - 120 * 1_000_000  # re-backfill 2m with new filter
            self.seen.clear()
            self.query_one("#log", RichLog).clear()
            self._set_title()

        def action_toggle_stream(self) -> None:
            self.stream = "pat_raw" if self.stream == "pat_events" else "pat_events"
            self.last_us = int(time.time() * 1_000_000) - 60 * 1_000_000
            self.seen.clear()
            self.columns.clear()
            self.query_one("#log", RichLog).clear()
            self.run_worker(self._load_columns(), exclusive=False)
            self._set_title()

        def action_clear_log(self) -> None:
            self.query_one("#log", RichLog).clear()

    TailApp().run()


def main() -> int:
    ap = argparse.ArgumentParser(description="pat-observability live tail TUI")
    ap.add_argument("--stream", default="pat_events", choices=["pat_events", "pat_raw"])
    ap.add_argument("--include-observability", action="store_true",
                    help="don't exclude the pipeline's own apps from pat_raw (default: excluded)")
    ap.add_argument("--selftest", metavar="FILTER", help="non-TUI: parse filter, run one query, print rows")
    args = ap.parse_args()
    if not OO_USER or not OO_PASS:
        print("Missing OPENOBSERVE_USER/PASSWORD (set env or agentic_toolkit/.agent-secrets).", file=sys.stderr)
        return 2
    if args.selftest is not None:
        return selftest(args.selftest, args.stream)
    run_tui(args.stream, exclude_self=not args.include_observability)
    return 0


if __name__ == "__main__":
    sys.exit(main())
