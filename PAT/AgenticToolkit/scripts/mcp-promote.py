#!/usr/bin/env python3
"""
mcp-promote — promote container_configs.mcp_servers between staging and prod.

Dry-run by default. Additive (new entries apply), and **warns + requires
confirmation** before any update or delete (never silently clobber/drop — honors
"don't lose data"). Matched by the stable `agent_groups.folder` (the random
`agent_group_id` differs across envs). Soft-delete tombstones (`deleted:true`)
are promoted as deletions. See plans/mcp-management.md.

The staging/prod DBs live on different Fly VMs, so this runs from the laptop and
reaches each DB over `flyctl ssh` + sqlite3 (no local DB file). It does NOT touch
the OneCLI vault — credential routing rides its own DB rows (separate concern).

Usage:
  uv run scripts/mcp-promote.py --from staging --to prod              # dry-run (default)
  uv run scripts/mcp-promote.py --from staging --to prod --apply      # write (confirms on update/delete)
  uv run scripts/mcp-promote.py --from staging --to prod --apply --yes  # no prompts
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


def _env():
    # A stray FLY token scopes flyctl to one app — strip them (AGENTS.md).
    e = dict(os.environ)
    e.pop("FLY_API_TOKEN", None)
    e.pop("FLY_ACCESS_TOKEN", None)
    return e


def ssh(app: str, sh: str) -> str:
    """Run `sh` on the app's machine via flyctl ssh; return stdout."""
    r = subprocess.run(
        ["flyctl", "ssh", "console", "-a", app, "-C", f"/bin/sh -lc '{sh}'"],
        capture_output=True, text=True, env=_env(),
    )
    if r.returncode != 0:
        raise RuntimeError(f"ssh {app} failed: {(r.stderr or r.stdout).strip()}")
    return r.stdout


def read_groups(app: str) -> dict:
    """{folder: {"id": <ag-id>, "mcp": {name: cfg}}} for every container_config."""
    sql = ('SELECT ag.id AS id, ag.folder AS folder, cc.mcp_servers AS mcp '
           'FROM container_configs cc JOIN agent_groups ag ON ag.id=cc.agent_group_id')
    out = ssh(app, f'sqlite3 -json {DB} "{sql}"')
    start = out.find("[")
    rows = json.loads(out[start:]) if start >= 0 else []
    return {r["folder"]: {"id": r["id"], "mcp": json.loads(r["mcp"] or "{}")} for r in rows}


def classify(src_mcp: dict, tgt_mcp: dict) -> list:
    """List of (action, name, src_cfg, tgt_cfg). action ∈ add|update|delete|unchanged|target-only."""
    actions = []
    for name, scfg in src_mcp.items():
        tcfg = tgt_mcp.get(name)
        if tcfg is None:
            # A tombstone for something that doesn't exist on target → no-op.
            actions.append(("unchanged" if scfg.get("deleted") else "add", name, scfg, None))
        elif json.dumps(scfg, sort_keys=True) == json.dumps(tcfg, sort_keys=True):
            actions.append(("unchanged", name, scfg, tcfg))
        elif scfg.get("deleted") and not tcfg.get("deleted"):
            actions.append(("delete", name, scfg, tcfg))
        else:
            actions.append(("update", name, scfg, tcfg))
    for name, tcfg in tgt_mcp.items():
        if name not in src_mcp:
            actions.append(("target-only", name, None, tcfg))
    return actions


MARK = {"add": "＋ add", "update": "～ UPDATE", "delete": "✗ DELETE",
        "unchanged": "· unchanged", "target-only": "○ target-only (left as-is)"}


def write_groups(app: str, group_id: str, merged_mcp: dict):
    """Overwrite one group's mcp_servers blob. base64+readfile to dodge ssh/sql quoting."""
    blob = json.dumps(merged_mcp)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    sql = (
        "UPDATE container_configs "
        "SET mcp_servers = CAST(readfile('/tmp/mcp-promote.json') AS TEXT), "
        f"updated_at = '{ts}' WHERE agent_group_id = '{group_id}';"
    )
    b64j = base64.b64encode(blob.encode()).decode()
    b64s = base64.b64encode(sql.encode()).decode()
    cmd = (
        f"printf %s {b64j} | base64 -d > /tmp/mcp-promote.json && "
        f"printf %s {b64s} | base64 -d > /tmp/mcp-promote.sql && "
        f"sqlite3 {DB} < /tmp/mcp-promote.sql && "
        f"rm -f /tmp/mcp-promote.json /tmp/mcp-promote.sql && echo PROMOTE_OK"
    )
    out = ssh(app, cmd)
    if "PROMOTE_OK" not in out:
        raise RuntimeError(f"write to {app} did not confirm: {out.strip()}")


def main():
    ap = argparse.ArgumentParser(description="Promote MCP server config between envs.")
    ap.add_argument("--from", dest="src", required=True, choices=APPS)
    ap.add_argument("--to", dest="tgt", required=True, choices=APPS)
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry-run)")
    ap.add_argument("--yes", action="store_true", help="skip confirmation on update/delete")
    args = ap.parse_args()
    if args.src == args.tgt:
        ap.error("--from and --to must differ")

    src_app, tgt_app = APPS[args.src], APPS[args.tgt]
    print(f"Reading MCP config: {src_app} (source) → {tgt_app} (target)\n")
    src, tgt = read_groups(src_app), read_groups(tgt_app)

    plan = []  # (folder, group_id, action, name, src_cfg)
    risky = 0  # updates + deletes
    changes = 0
    for folder, sdata in src.items():
        if folder not in tgt:
            print(f"⚠ folder '{folder}' has no group on {args.tgt} — skipped (create the group first)")
            continue
        tdata = tgt[folder]
        print(f"━ group '{folder}' (target id {tdata['id']})")
        any_change = False
        for action, name, scfg, tcfg in classify(sdata["mcp"], tdata["mcp"]):
            if action in ("unchanged", "target-only"):
                continue
            print(f"    {MARK[action]:<28} {name}")
            if action in ("update", "delete"):
                risky += 1
            changes += 1
            any_change = True
            plan.append((folder, tdata["id"], action, name, scfg))
        if not any_change:
            print("    (no changes)")
        print()

    if changes == 0:
        print("Nothing to promote — target already matches source.")
        return

    if not args.apply:
        print(f"DRY RUN — {changes} change(s) ({risky} update/delete). Re-run with --apply to write.")
        return

    if risky and not args.yes:
        ans = input(f"{risky} update/delete will overwrite/remove target entries. Type 'yes' to proceed: ")
        if ans.strip().lower() != "yes":
            print("Aborted.")
            return

    # Apply per-group: merge source entries into the target blob (additive: keep
    # target-only entries untouched; overwrite/tombstone the planned ones).
    by_group = {}
    for folder, gid, action, name, scfg in plan:
        by_group.setdefault((folder, gid), []).append((name, scfg))
    for (folder, gid), items in by_group.items():
        merged = dict(tgt[folder]["mcp"])
        for name, scfg in items:
            merged[name] = scfg
        write_groups(tgt_app, gid, merged)
        print(f"✓ wrote {len(items)} change(s) to '{folder}' on {args.tgt}")
        print(f"  → materialize: restart the group so the container reloads "
              f"(ncl groups restart --id {gid}, or it applies on the next message)")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, KeyboardInterrupt) as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)
