---
name: deepseek-harness-thread-management
description: "Find and count DeepSeek Harness (DSH) sessions/threads by lifecycle state — active, archived, or orphaned — by reading the workspace registry rather than the sessions directory, and wait for another thread's turn to finish via the host's event stream. Use when asked how many threads/sessions/conversations exist, which are active or archived, why the sidebar count differs from what is on disk, when auditing DSH session storage, or when asked to wait on / watch / get notified about another thread. Triggers: 'how many sessions', 'how many threads', 'active sessions', 'archived sessions', 'count my threads', 'session count', 'why does the UI show fewer', 'wait for that thread', 'notify me when it finishes', 'watch the other session'."
---

# DSH thread management: finding, counting, and waiting on sessions

DSH has no model-facing tool that enumerates sessions. `list_agents` only walks an
agent's own subagent subtree, and the cross-session capabilities that exist in the
repo (`tool-session-query`, `session-reference`) are not mounted in the shipped
`base` + `web-app` bundles. Counting therefore means reading DSH's own state files.

**Count from the workspace registry, not the sessions directory.** Counting
`~/.dsh/sessions/*/*/` overcounts by roughly 4x.

## The count

```sh
./count-active-sessions.py            # human-readable table
./count-active-sessions.py --json     # machine-readable
```

`--dsh-home` overrides the location (default `$DSH_HOME`, else `~/.dsh`).

The active number it reports is the one that corresponds to the DSH sidebar.

## The formula

Registry: `$DSH_HOME/storages/workspace.json`, owned by
`packages/workspace/workspace/src/spec.ts` in the deepseek-harness repo.

```
owned   = union of tables.workspaces[w].sessionIds for w in global.workspaceIds
archived = set(global.archivedSessionIds)
ACTIVE  = |owned − archived|
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

## Waiting on another thread

DSH has no cross-thread notification for agents: the subagent lifecycle emitter
is parent-scoped, so a *sibling's* turn ending produces no event an agent can
see in-harness. Both halves of a notification exist around the harness, though,
and they chain:

1. The GUI's own event stream — `ws://<host>/api/events.mux` — pushes every
   attached session's raw events to any local WebSocket client. No auth: the
   `/api` trust fence binds the Host header (DNS-rebinding defense) and is
   explicitly not an auth layer, so a loopback client is a full peer of the
   browser.
2. The harness notifies an agent when a background job it started settles
   (`tool-jobs` wakeup delivery).

`wait-for-turn-end.mjs` glues them: connect to the mux stream, filter for one
session id, exit when that session emits `turn/end`. Run it as a **background
job** — job settlement then becomes your notification, no polling.

```sh
./wait-for-turn-end.mjs --session session-xxxx --timeout-min 30
```

Exit codes: `0` saw turn/end; `2` timeout; `3` stream error; `4` stream closed
without the event. The `ws` dependency resolves from the deepseek-harness
checkout's node_modules (`DSH_ROOT` env overrides the location).

### Arming order — the two races

- **The mux stream never replays past session events** (only pending
  approvals/questions replay on open). A watcher connected after a turn already
  ended sees nothing and burns its whole timeout. So: check `running` first;
  arm only what is actually running.
- **The connect window.** Between the `running` check and the WebSocket
  opening, the turn can end. After arming, re-check `running`: false means it
  ended in the window — kill the watcher and read the log directly.

Check running state through the same API:

```sh
curl -s -X POST http://127.0.0.1:3080/api/session.list \
  -H 'Content-Type: application/json' \
  -d '{"type":"client-request","rpcId":"r1","method":"session.list","payload":{}}'
```

`items[].running` is live. On timeout (exit 2), re-check `running`: false means
the turn ended during the window (read the log); true means re-arm. Tool-heavy
threads can exceed 30 minutes — one measured run went past it.

### Waiting caveats

- **First `turn/end` only.** If several messages were queued to the target, the
  watcher fires at the end of the first turn; later turns need re-arming.
- **The wake budget.** Job notices degrade from opening a new turn to riding
  the current one after 3 consecutive plugin-opened turns without human input
  (`tool-jobs` `maxConsecutiveWakes`, default 3). A long chain of watcher
  re-arms should expect its notification to arrive as an injected notice in an
  already-running turn, not a standalone wake.
- **`GET /api/events.mux` returns `426 Upgrade Required`** in web deployments:
  it is a WebSocket downlink (`websocket-downlink.ts`), not SSE, even though an
  SSE handler path exists in the fetch carrier. Use a WebSocket client.
- **Server restart drops the stream** (exit 3 or 4). Re-arm once the new server
  is up.

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
`glob`. This failure prints per-directory errors and can total to zero silently.

**"Not archived" ≠ "shown".** Do not compute active as
`logs_on_disk − archived`; that silently folds orphans into the total. Active is
`owned − archived`.

**Further UI-side filters exist.** `deriveGroups` in
`packages/client/ui-workspace/src/client/tree.ts` also hides blank sessions
(except the current selection) and only populates a group's rows when the group is
expanded. The registry count is the ceiling of what the sidebar renders, not an
exact render count.

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
