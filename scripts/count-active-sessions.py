#!/usr/bin/env python3
"""Count DSH sessions by lifecycle state from the workspace registry.

Reports the active count the DSH sidebar can render: sessions owned by a
workspace and not in the registry-global archive set.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from datetime import datetime, timezone


def load_registry(dsh_home: str) -> dict:
    path = os.path.join(dsh_home, "storages", "workspace.json")
    with open(path, encoding="utf-8") as handle:
        return {"data": json.load(handle), "path": path, "mtime": os.path.getmtime(path)}


def summarize(dsh_home: str) -> dict:
    registry = load_registry(dsh_home)
    data = registry["data"]
    state = data["global"]
    table = data["tables"]["workspaces"]

    archived = set(state.get("archivedSessionIds", []))
    owned: set[str] = set()
    per_workspace = []
    for workspace_id in state["workspaceIds"]:
        record = table[workspace_id]
        session_ids = record["sessionIds"]
        owned.update(session_ids)
        per_workspace.append({
            "title": record.get("title", workspace_id),
            "path": record.get("path", ""),
            "total": len(session_ids),
            "archived": sum(1 for s in session_ids if s in archived),
            "active": sum(1 for s in session_ids if s not in archived),
        })

    on_disk = {
        os.path.basename(os.path.dirname(p))
        for p in glob.glob(os.path.join(dsh_home, "sessions", "*", "*", "session.jsonl*"))
    }

    return {
        "registry_path": registry["path"],
        "registry_mtime": datetime.fromtimestamp(registry["mtime"], timezone.utc)
        .astimezone().strftime("%Y-%m-%d %H:%M:%S"),
        "active": len(owned - archived),
        "archived_owned": len(owned & archived),
        "owned": len(owned),
        "archived_total": len(archived),
        "archived_without_owner": len(archived - owned),
        "logs_on_disk": len(on_disk),
        "orphan_logs": len(on_disk - owned),
        "owned_without_log": len(owned - on_disk),
        "workspaces": per_workspace,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dsh-home",
        default=os.environ.get("DSH_HOME", os.path.expanduser("~/.dsh")),
        help="DSH home directory (default: $DSH_HOME or ~/.dsh)",
    )
    parser.add_argument("--json", action="store_true", help="emit JSON instead of a table")
    args = parser.parse_args()

    try:
        result = summarize(args.dsh_home)
    except FileNotFoundError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(result, indent=2))
        return 0

    print(f"registry: {result['registry_path']}")
    print(f"snapshot: {result['registry_mtime']} (mutates while the server runs)")
    print()
    for row in result["workspaces"]:
        print(
            f"  {row['title'][:24]:<24} {row['path'][-30:]:<30} "
            f"total={row['total']:>3}  archived={row['archived']:>3}  active={row['active']:>3}"
        )
    print()
    print(f"  ACTIVE (workspace-owned, not archived) : {result['active']}")
    print(f"  archived (owned)                       : {result['archived_owned']}")
    print(f"  owned total                            : {result['owned']}")
    print()
    print(f"  logs on disk                           : {result['logs_on_disk']}")
    print(f"  orphan logs (no workspace)             : {result['orphan_logs']}")
    if result["archived_without_owner"]:
        print(f"  archived ids with no owning workspace  : {result['archived_without_owner']}")
    if result["owned_without_log"]:
        print(f"  owned sessions with no log on disk     : {result['owned_without_log']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
