#!/usr/bin/env python3
"""
routing-promote — promote the `credential_routing` table between staging and prod.

The DB-side companion to mcp-promote.py (same DB-only mechanism, same safety
semantics) — together they are the "promote DB config between envs" path the plans
describe. Routing rows are install-wide (no folder dimension), so this is simpler.

Dry-run by default. Additive; warns + requires confirmation before any update/delete.
Tombstone-aware (`deleted`). Compares on SEMANTIC fields only (ignores timestamps).
Tolerates the table not existing yet on the target (treats as empty → all adds).
Never touches the OneCLI vault — each box's boot-reconcile derives its own vault from
these rows.

Usage:
  uv run scripts/routing-promote.py --from staging --to prod            # dry-run
  uv run scripts/routing-promote.py --from staging --to prod --apply
  uv run scripts/routing-promote.py --from staging --to prod --apply --yes
"""
import argparse
import base64
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

APPS = {"staging": "pat-nanoclaw-staging", "prod": "pat-nanoclaw"}
DB = "/data/nanoclaw/data/v2.db"
SEMANTIC = ["host_pattern", "header_name", "value_format", "type", "secret_name", "deleted"]


def _env():
    e = dict(os.environ)
    e.pop("FLY_API_TOKEN", None)
    e.pop("FLY_ACCESS_TOKEN", None)
    return e


def ssh(app: str, sh: str) -> str:
    r = subprocess.run(
        ["flyctl", "ssh", "console", "-a", app, "-C", f"/bin/sh -lc '{sh}'"],
        capture_output=True, text=True, env=_env(),
    )
    if r.returncode != 0:
        raise RuntimeError(f"ssh {app} failed: {(r.stderr or r.stdout).strip()}")
    return r.stdout


def read_routing(app: str) -> dict:
    """{name: full_row}; {} if the table doesn't exist yet on this env."""
    try:
        out = ssh(app, f'sqlite3 -json {DB} "SELECT * FROM credential_routing"')
    except RuntimeError as e:
        if "no such table" in str(e):
            return {}  # migration 023 not applied on this env yet
        raise
    start = out.find("[")
    return {r["name"]: r for r in json.loads(out[start:])} if start >= 0 else {}


def norm(row: dict) -> dict:
    return {k: row.get(k) for k in SEMANTIC}


def classify(src: dict, tgt: dict) -> list:
    actions = []
    for name, srow in src.items():
        trow = tgt.get(name)
        s = norm(srow)
        if trow is None:
            actions.append(("unchanged" if s.get("deleted") else "add", name, srow))
        elif s == norm(trow):
            actions.append(("unchanged", name, srow))
        elif s.get("deleted") and not norm(trow).get("deleted"):
            actions.append(("delete", name, srow))
        else:
            actions.append(("update", name, srow))
    for name in tgt:
        if name not in src:
            actions.append(("target-only", name, tgt[name]))
    return actions


MARK = {"add": "＋ add", "update": "～ UPDATE", "delete": "✗ DELETE",
        "unchanged": "· unchanged", "target-only": "○ target-only (left as-is)"}


def sql_lit(v):
    return "NULL" if v is None else "'" + str(v).replace("'", "''") + "'"


def write_rows(app: str, rows: list):
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    stmts = []
    for r in rows:
        stmts.append(
            "INSERT INTO credential_routing "
            "(name, host_pattern, header_name, value_format, type, secret_name, deleted, created_at, updated_at) VALUES ("
            f"{sql_lit(r['name'])}, {sql_lit(r['host_pattern'])}, {sql_lit(r['header_name'])}, "
            f"{sql_lit(r['value_format'])}, {sql_lit(r['type'])}, {sql_lit(r['secret_name'])}, "
            f"{int(r.get('deleted') or 0)}, {sql_lit(now)}, {sql_lit(now)}) "
            "ON CONFLICT(name) DO UPDATE SET host_pattern=excluded.host_pattern, "
            "header_name=excluded.header_name, value_format=excluded.value_format, type=excluded.type, "
            "secret_name=excluded.secret_name, deleted=excluded.deleted, updated_at=excluded.updated_at;"
        )
    b64 = base64.b64encode("\n".join(stmts).encode()).decode()
    cmd = (f"printf %s {b64} | base64 -d > /tmp/routing-promote.sql && "
           f"sqlite3 {DB} < /tmp/routing-promote.sql && rm -f /tmp/routing-promote.sql && echo PROMOTE_OK")
    if "PROMOTE_OK" not in ssh(app, cmd):
        raise RuntimeError("write did not confirm")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="src", required=True, choices=APPS)
    ap.add_argument("--to", dest="tgt", required=True, choices=APPS)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--yes", action="store_true")
    args = ap.parse_args()
    if args.src == args.tgt:
        ap.error("--from and --to must differ")

    src_app, tgt_app = APPS[args.src], APPS[args.tgt]
    print(f"credential_routing: {src_app} (source) → {tgt_app} (target)\n")
    src, tgt = read_routing(src_app), read_routing(tgt_app)
    if not tgt:
        print(f"(note: credential_routing not present on {args.tgt} yet — deploy migration 023 there first to apply)\n")

    plan, risky = [], 0
    for action, name, row in classify(src, tgt):
        if action in ("unchanged", "target-only"):
            continue
        print(f"  {MARK[action]:<14} {name}")
        if action in ("update", "delete"):
            risky += 1
        plan.append(row if action != "delete" else {**row, "deleted": 1})

    if not plan:
        print("Nothing to promote — target routing already matches source.")
        return
    print()
    if not args.apply:
        print(f"DRY RUN — {len(plan)} change(s) ({risky} update/delete). Re-run with --apply.")
        return
    if risky and not args.yes:
        if input(f"{risky} update/delete will overwrite/remove target rows. Type 'yes': ").strip().lower() != "yes":
            print("Aborted.")
            return
    write_rows(tgt_app, plan)
    print(f"✓ wrote {len(plan)} routing change(s) to {args.tgt}.")
    print("  → each box reconciles its OneCLI vault from these rows at boot (reconcile step pending).")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, KeyboardInterrupt) as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)
