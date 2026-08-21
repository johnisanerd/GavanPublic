#!/usr/bin/env python3
"""
seed-routing-from-vault — populate the DB `credential_routing` table from the live
OneCLI vault on a box (ground-truth source, run deliberately per env).

The vault (postgres on each VM) is today's source of routing truth; this mirrors it
into the DB table that BECOMES the source of truth going forward (the boot-reconcile
later goes the other way: table → vault). Dry-run by default.

Reads the vault over `flyctl ssh` + the gateway REST API (Bearer $ONECLI_API_KEY,
expanded on the box — the key never leaves the VM). Idempotent upsert (preserves
created_at; never deletes rows — a vault entry removed upstream stays until you
tombstone it explicitly, so we don't silently drop routing).

Usage:
  uv run scripts/seed-routing-from-vault.py --env staging            # dry-run
  uv run scripts/seed-routing-from-vault.py --env staging --apply
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

# vault entry name → canonical AGENT_ secret that provides its value (the name-map).
SECRET_NAME = {
    "anthropic-prod": "ANTHROPIC_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "cartesia": "CARTESIA_API_KEY",
    "firecrawl": "FIRECRAWL_API_KEY",
    "apify-api": "APIFY_API_KEY",
    "apify-mcp": "APIFY_API_KEY",
    "kernel": "KERNEL_API_KEY",
}


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


def read_vault(app: str) -> list:
    out = ssh(app, 'curl -fsS --max-time 6 -H "Authorization: Bearer $ONECLI_API_KEY" http://127.0.0.1:10254/api/secrets')
    start = out.find("[")
    if start < 0:
        raise RuntimeError(f"unexpected vault response: {out[:200]}")
    return json.loads(out[start:])


def rows_from_vault(secrets: list) -> list:
    rows = []
    for s in secrets:
        inj = s.get("injectionConfig") or {}
        rows.append({
            "name": s["name"],
            "host_pattern": s.get("hostPattern") or "",
            "header_name": inj.get("headerName"),  # None for anthropic
            "value_format": inj.get("valueFormat") or "{value}",
            "type": s.get("type") or "generic",
            "secret_name": SECRET_NAME.get(s["name"]),  # None if unmapped → flag it
        })
    return rows


def sql_lit(v):
    if v is None:
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


def write_rows(app: str, rows: list):
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    stmts = []
    for r in rows:
        stmts.append(
            "INSERT INTO credential_routing "
            "(name, host_pattern, header_name, value_format, type, secret_name, deleted, created_at, updated_at) VALUES ("
            f"{sql_lit(r['name'])}, {sql_lit(r['host_pattern'])}, {sql_lit(r['header_name'])}, "
            f"{sql_lit(r['value_format'])}, {sql_lit(r['type'])}, {sql_lit(r['secret_name'])}, 0, "
            f"{sql_lit(now)}, {sql_lit(now)}) "
            "ON CONFLICT(name) DO UPDATE SET host_pattern=excluded.host_pattern, "
            "header_name=excluded.header_name, value_format=excluded.value_format, type=excluded.type, "
            "secret_name=excluded.secret_name, updated_at=excluded.updated_at;"
        )
    sql = "\n".join(stmts)
    b64 = base64.b64encode(sql.encode()).decode()
    cmd = (f"printf %s {b64} | base64 -d > /tmp/seed-routing.sql && "
           f"sqlite3 {DB} < /tmp/seed-routing.sql && rm -f /tmp/seed-routing.sql && echo SEED_OK")
    out = ssh(app, cmd)
    if "SEED_OK" not in out:
        raise RuntimeError(f"seed write did not confirm: {out.strip()}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--env", required=True, choices=APPS)
    ap.add_argument("--apply", action="store_true", help="write rows (default: dry-run)")
    args = ap.parse_args()
    app = APPS[args.env]

    print(f"Reading OneCLI vault on {app} …")
    rows = rows_from_vault(read_vault(app))
    print(f"{len(rows)} vault entries → credential_routing rows:\n")
    for r in rows:
        flag = "" if r["secret_name"] else "   ⚠ no secret_name mapping"
        print(f"  {r['name']:<16} host={r['host_pattern']:<22} "
              f"hdr={r['header_name'] or '(anthropic auto)':<16} "
              f"fmt={r['value_format']:<14} type={r['type']:<9} secret={r['secret_name'] or '—'}{flag}")
    print()
    if not args.apply:
        print("DRY RUN — re-run with --apply to write into credential_routing.")
        return
    write_rows(app, rows)
    print(f"✓ seeded {len(rows)} routing rows into {app} (idempotent upsert).")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, KeyboardInterrupt) as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)
