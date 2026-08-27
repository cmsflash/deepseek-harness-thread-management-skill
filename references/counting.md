# Counting DSH sessions from the workspace registry

The full method behind `scripts/count-active-sessions.py`. Read this when a count
needs auditing, when the number disagrees with the GUI, or when working on the
script itself.

## The formula

Registry: `$DSH_HOME/storages/workspace.json`, owned by
`packages/workspace/workspace/src/spec.ts` in the deepseek-harness repo.

```
owned    = union of tables.workspaces[w].sessionIds for w in global.workspaceIds
archived = set(global.archivedSessionIds)
ACTIVE   = |owned − archived|
```

Two fields carry the whole result:

- `global.workspaceIds` — the authoritative workspace list and display order.
- `global.archivedSessionIds` — a registry-global archive set. Per its own spec
  JSDoc, an archived session *keeps* its `sessionIds` slot so unarchiving can
  restore its position. Archiving is a reversible display flag, never deletion —
  so archived sessions must be subtracted, not assumed absent.

## Why disk counts are wrong

Three populations, and only the first is what a session count usually means:

| Population | Where it lives |
|---|---|
| **Active** | owned by a workspace, absent from the archive set |
| **Archived** | owned, present in the archive set |
| **Orphaned** | a log on disk that no workspace's `sessionIds` contains |

Orphans are the large hidden population, and they are overwhelmingly **subagent
child sessions** — every delegation writes its own log without being filed into a
workspace. Verify rather than assume, reading only the header line's `origin`
field:

```sh
zstd -dc "$LOG" | head -1 | python3 -c "import json,sys;print(json.load(sys.stdin).get('header',{}).get('origin'))"
```

Never decompress another session's message content to count it; the header line
carries everything a count needs.

## Traps

**The registry mutates while the server runs.** Archiving a session in the GUI
rewrites `workspace.json` immediately. Repeated counts minutes apart legitimately
differ. Always report the count with the registry's mtime, which the script
prints. A changing number across reads is real archiving, not a broken method.

**You are reading a file the server owns in memory.** Unflushed state can make an
on-disk read lag the GUI. For an authoritative live figure, read the GUI itself.

**BSD `find` parses DSH's project directory names as flags.** Project directories
are named like `--Users-zhuoran-Programs-core--`; a bare
`find --Users-.../ -name ...` fails with `illegal option`. Prefix with `./` or use
a glob. This failure prints per-directory errors and can total to zero silently.

**"Not archived" ≠ "shown".** Do not compute active as
`logs_on_disk − archived`; that silently folds orphans into the total. Active is
`owned − archived`.

**Further UI-side filters exist.** `deriveGroups` in
`packages/client/ui-workspace/src/client/tree.ts` also hides blank sessions
(except the current selection) and only populates a group's rows when the group
is expanded. The registry count is the ceiling of what the sidebar renders, not
an exact render count.

## Reference reading

A verified snapshot, for shape only — every number here moves:

```
logs on disk                   110
  owned by a workspace          61   → active 27 / archived 34
  orphaned (subagent children)  49
```

At that moment `ACTIVE` was **27**. Later reads in the same hour returned 26 and
25 as sessions were archived live. Treat the *ratio* as durable and the digits as
a timestamped snapshot.
