#!/usr/bin/env python3
"""Recover archived DSH threads. DSH archives one-way; this provides both inverses.

    list                      archived threads with title, date, turn count
    fork <id>                 live copy under a new id (no restart; --commit to write)
    archive <id>              archive a session; the undo for an unwanted fork
    restore <id> [<id> ...]   true unarchive, same id (DSH must be STOPPED; --commit)
    restore --all             restore every archived id

Both write paths are dry-run by default and require --commit.
See references/unarchive.md for which recipe to pick.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
import uuid
from datetime import datetime

DEFAULT_BASE_URL = "http://127.0.0.1:3080"


def dsh_home() -> str:
    return os.environ.get("DSH_HOME") or os.path.expanduser("~/.dsh")


def registry_path(home: str) -> str:
    return os.path.join(home, "storages", "workspace.json")


def load_registry(home: str) -> dict:
    with open(registry_path(home), encoding="utf-8") as handle:
        return json.load(handle)


def archived_ids(home: str) -> list[str]:
    return list(load_registry(home)["global"].get("archivedSessionIds", []))


def rpc(base_url: str, method: str, payload: dict) -> dict:
    body = json.dumps({
        "type": "client-request",
        "rpcId": str(uuid.uuid4()),
        "method": method,
        "payload": payload,
    }).encode()
    request = urllib.request.Request(
        f"{base_url}/api/{method}",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            envelope = json.load(response)
    except urllib.error.URLError as error:
        raise SystemExit(
            f"cannot reach DSH at {base_url}: {error}\n"
            "Is it running? Find the port with:\n"
            "  lsof -nP -iTCP -sTCP:LISTEN | grep 'node.*bin.js --profile web'"
        )
    result = envelope.get("result", {})
    if not result.get("ok"):
        raise SystemExit(f"{method} failed: {json.dumps(result.get('error', result))}")
    return result["value"]


def server_running(base_url: str) -> bool:
    try:
        rpc(base_url, "workspace.list", {})
        return True
    except SystemExit:
        return False


def session_index(base_url: str) -> dict[str, dict]:
    items = rpc(base_url, "session.list", {})["items"]
    return {item["sessionId"]: item for item in items}


def describe(item: dict | None) -> tuple[str, str, str]:
    """Return (date, turns, title) for display."""
    if item is None:
        return ("?", "?", "<missing — log gone; unrecoverable>")
    values = (item.get("projections") or {}).get("values", {})
    title = values.get("title")
    if isinstance(title, dict):
        title = title.get("title") or title.get("text")
    turns = (values.get("sessionStats") or {}).get("turns")
    updated = item.get("updatedAt")
    stamp = (
        datetime.fromtimestamp(updated / 1000).strftime("%Y-%m-%d %H:%M")
        if isinstance(updated, (int, float)) else "?"
    )
    return (stamp, str(turns if turns is not None else "?"), str(title or "<untitled>"))


def cmd_list(args) -> int:
    ids = archived_ids(dsh_home())
    if not ids:
        print("No archived threads.")
        return 0
    index = session_index(args.base_url) if server_running(args.base_url) else {}
    if not index:
        print("(DSH not reachable — ids only, no titles)\n")
        for session_id in ids:
            print(f"  {session_id}")
        return 0

    rows = [(describe(index.get(i)), i) for i in ids]
    # Unrecoverable rows have no date; keep them last instead of letting "?" sort high.
    rows.sort(key=lambda r: (r[0][0] != "?", r[0][0]), reverse=True)
    print(f"{len(ids)} archived thread(s), newest first:\n")
    print(f"  {'DATE':<17} {'TURNS':>5}  {'TITLE':<44} SESSION ID")
    for (stamp, turns, title), session_id in rows:
        print(f"  {stamp:<17} {turns:>5}  {title[:44]:<44} {session_id}")
    missing = sum(1 for _, i in rows if i not in index)
    if missing:
        print(f"\n{missing} archived id(s) have no session log; neither recipe recovers those.")
    return 0


def subagent_children(index: dict[str, dict], session_id: str) -> list[str]:
    return [
        item["sessionId"] for item in index.values()
        if item.get("parentSessionId") == session_id and item.get("origin") == "subagent"
    ]


def cmd_fork(args) -> int:
    session_id = args.session_id
    archived = archived_ids(dsh_home())
    if session_id not in archived:
        print(f"warning: {session_id} is not archived (forking anyway)", file=sys.stderr)

    index = session_index(args.base_url)
    stamp, turns, title = describe(index.get(session_id))
    if session_id not in index:
        raise SystemExit(f"{session_id} has no session log — unrecoverable.")

    children = subagent_children(index, session_id)

    print(f"Fork source : {title}  ({stamp}, {turns} turns)")
    print(f"              {session_id}")
    print("Creates a NEW visible thread; the original stays archived.")
    print("New id, records parentSession lineage, drops any unfinished final turn.")
    if children:
        print(
            f"NOTE: {len(children)} subagent child session(s) do NOT transfer. The parent's\n"
            "      subagent tool calls and results stay in the transcript, but the child\n"
            "      sessions keep pointing at the original and are unreachable from the fork."
        )
    if args.archive_original and session_id not in archived:
        print("NOTE: --archive-original is a no-op here; the source is not archived.")
    if not args.commit:
        print("\nDRY RUN — re-run with --commit to fork.")
        return 0

    value = rpc(args.base_url, "session.fork", {"sessionId": session_id})
    new_id = value["sessionId"]
    print(f"\nForked -> {new_id}")

    if args.archive_original and session_id in archived:
        print("Source already archived; nothing to do (--archive-original).")

    print("Visible in the sidebar now. To undo, archive the fork:")
    print(f"  {sys.argv[0]} archive {new_id} --commit")
    return 0


def cmd_archive(args) -> int:
    """Archive a session — the undo for an unwanted fork."""
    index = session_index(args.base_url)
    stamp, turns, title = describe(index.get(args.session_id))
    print(f"Archive: {title}  ({stamp}, {turns} turns)")
    print(f"         {args.session_id}")
    if not args.commit:
        print("\nDRY RUN — re-run with --commit to archive.")
        return 0
    rpc(args.base_url, "workspace.archiveSession", {"sessionId": args.session_id})
    print("\nArchived (hidden from every surface; the log is untouched).")
    return 0


def cmd_restore(args) -> int:
    home = dsh_home()
    path = registry_path(home)
    registry = load_registry(home)
    archived = registry["global"].get("archivedSessionIds", [])

    targets = archived[:] if args.all else list(args.session_ids)
    if not targets:
        raise SystemExit("give session ids, or --all")

    unknown = [t for t in targets if t not in archived]
    if unknown:
        for t in unknown:
            print(f"warning: {t} is not in the archive set; skipping", file=sys.stderr)
        targets = [t for t in targets if t in archived]
    if not targets:
        raise SystemExit("nothing to restore")

    running = server_running(args.base_url)
    index = session_index(args.base_url) if running else {}

    print(f"Restore {len(targets)} thread(s) — same id, same position, no fork lineage:\n")
    for session_id in targets[:20]:
        stamp, turns, title = describe(index.get(session_id)) if index else ("?", "?", "")
        print(f"  {stamp:<17} {title[:44]:<44} {session_id}")
    if len(targets) > 20:
        print(f"  … and {len(targets) - 20} more")

    if running:
        print(
            "\nREFUSING: DSH is running at "
            f"{args.base_url}.\n"
            "It holds workspace.json in memory and republishes the whole file on\n"
            "every write, so a live edit is silently reverted. Stop DSH first:\n"
            "  lsof -nP -iTCP -sTCP:LISTEN | grep 'node.*bin.js --profile web'\n"
            "Check no turns are running before killing it.",
            file=sys.stderr,
        )
        return 2

    if not args.commit:
        print("\nDRY RUN — re-run with --commit to write.")
        return 0

    backup = f"{path}.bak-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    shutil.copy2(path, backup)
    remaining = [i for i in archived if i not in set(targets)]
    registry["global"]["archivedSessionIds"] = remaining
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(registry, handle, indent=2)
        handle.write("\n")
    os.replace(tmp, path)

    print(f"\nRestored {len(targets)}; {len(remaining)} still archived.")
    print(f"Backup: {backup}")
    print("Start DSH again to see them.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default=os.environ.get("DSH_BASE_URL", DEFAULT_BASE_URL))
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list", help="show archived threads").set_defaults(func=cmd_list)

    fork = sub.add_parser("fork", help="live copy under a new id (no restart)")
    fork.add_argument("session_id")
    fork.add_argument("--commit", action="store_true", help="actually fork")
    fork.add_argument(
        "--archive-original", action="store_true",
        help="ensure the source stays archived (already true for an archived source)")
    fork.set_defaults(func=cmd_fork)

    archive = sub.add_parser("archive", help="archive a session (undo an unwanted fork)")
    archive.add_argument("session_id")
    archive.add_argument("--commit", action="store_true", help="actually archive")
    archive.set_defaults(func=cmd_archive)

    restore = sub.add_parser("restore", help="true unarchive; DSH must be stopped")
    restore.add_argument("session_ids", nargs="*")
    restore.add_argument("--all", action="store_true", help="restore every archived id")
    restore.add_argument("--commit", action="store_true", help="actually write")
    restore.set_defaults(func=cmd_restore)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
