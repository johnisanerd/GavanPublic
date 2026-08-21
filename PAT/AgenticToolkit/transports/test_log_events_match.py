"""
Drift test — assert every mirror of realtime/src/log-events.ts agrees
with the canonical TS source.

Mirrors checked:
    transports/log_events.py        full mirror (Python set must equal TS)
    pat-frontend/src/types/log-events.ts   full mirror (TS set must equal canonical)
    pat-web/src/types/log-events.ts        intentional subset (must be strict subset)

Adding a kind upstream without updating a mirror — or renaming a kind
without sweeping the mirrors — fails this test.

Run:
    cd transports && uv run python -m pytest test_log_events_match.py
    # or just `uv run python test_log_events_match.py` (asserts at top
    # level — exits non-zero on drift).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

from log_events import LOG_EVENT_KINDS

REPO = Path(__file__).resolve().parent.parent
TS_FILE = REPO / "realtime" / "src" / "log-events.ts"
PAT_FRONTEND_FILE = REPO / "pat-frontend" / "src" / "types" / "log-events.ts"
PAT_WEB_FILE = REPO / "pat-web" / "src" / "types" / "log-events.ts"


def extract_canonical_kinds() -> list[str]:
    """Parse the LOG_EVENT_KINDS array out of the canonical TS source.

    Looking for:
        export const LOG_EVENT_KINDS = [
          'inbound.received',
          ...
        ] as const;
    """
    src = TS_FILE.read_text()
    m = re.search(
        r"export const LOG_EVENT_KINDS\s*=\s*\[(?P<body>.*?)\]\s*as const;",
        src,
        re.DOTALL,
    )
    if not m:
        sys.exit(f"could not find LOG_EVENT_KINDS in {TS_FILE}")
    body = m.group("body")
    # Each entry: 'name', possibly with trailing comment. Char class includes
    # '_' so underscore kinds (e.g. 'agent.tool_use') are captured — otherwise
    # the regex stops at the underscore and the kind silently drops out of the
    # extracted set, defeating drift enforcement for it.
    return re.findall(r"'([a-z][a-z0-9._-]*)'", body)


def extract_mirror_kinds(path: Path) -> list[str]:
    """Pat-frontend and pat-web declare kinds as discriminated-union
    `kind: 'foo.bar';` literals on each interface, not as a single
    `LOG_EVENT_KINDS` array. Scrape those literals."""
    src = path.read_text()
    # Char class includes '_' so underscore kinds (e.g. 'agent.tool_use') match.
    return re.findall(r"\bkind:\s*'([a-z][a-z0-9._-]*)'", src)


def main() -> int:
    ts_kinds = extract_canonical_kinds()
    py_kinds = list(LOG_EVENT_KINDS)
    ts_set = set(ts_kinds)
    py_set = set(py_kinds)
    failed = False

    # ── 1. transports/log_events.py — full mirror ───────────────────
    only_in_ts = ts_set - py_set
    only_in_py = py_set - ts_set
    if only_in_ts or only_in_py:
        print("DRIFT between canonical TS and Python log-event kinds:", file=sys.stderr)
        if only_in_ts:
            print(f"  only in TS:  {sorted(only_in_ts)}", file=sys.stderr)
        if only_in_py:
            print(f"  only in py:  {sorted(only_in_py)}", file=sys.stderr)
        failed = True
    elif ts_kinds != py_kinds:
        # Same set, different order. Doesn't break correctness but a
        # diff-friendly source-of-truth ordering helps reviewers; flag
        # it loud anyway.
        print("ORDER MISMATCH between TS and Python (same kinds, different sequence):", file=sys.stderr)
        print(f"  TS:  {ts_kinds}", file=sys.stderr)
        print(f"  py:  {py_kinds}", file=sys.stderr)
        failed = True

    # ── 2. pat-frontend/src/types/log-events.ts — full mirror ───────
    fe_kinds = extract_mirror_kinds(PAT_FRONTEND_FILE)
    fe_set = set(fe_kinds)
    only_in_canonical = ts_set - fe_set
    only_in_fe = fe_set - ts_set
    if only_in_canonical or only_in_fe:
        print("DRIFT between canonical TS and pat-frontend mirror:", file=sys.stderr)
        if only_in_canonical:
            print(f"  only in canonical:    {sorted(only_in_canonical)}", file=sys.stderr)
        if only_in_fe:
            print(f"  only in pat-frontend: {sorted(only_in_fe)}", file=sys.stderr)
        failed = True

    # ── 3. pat-web/src/types/log-events.ts — strict subset ──────────
    # pat-web deliberately types only the kinds the browser dispatcher
    # reads; rest land in PatEventUnknown. So we require subset, not
    # equality — but a rename upstream that drops a kind from the
    # canonical set must fail loud here.
    web_kinds = extract_mirror_kinds(PAT_WEB_FILE)
    web_set = set(web_kinds)
    leaked = web_set - ts_set
    if leaked:
        print("DRIFT — pat-web references kinds not in canonical TS:", file=sys.stderr)
        print(f"  unknown to canonical: {sorted(leaked)}", file=sys.stderr)
        failed = True

    if failed:
        return 1

    print(
        f"OK — {len(ts_kinds)} canonical kinds; "
        f"transports/Python full mirror; "
        f"pat-frontend full mirror; "
        f"pat-web subset ({len(web_set)} of {len(ts_set)})."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
