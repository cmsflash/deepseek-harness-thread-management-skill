# Restore an archived thread

Use native `workspace/unarchiveSession` on the authenticated running Host.
Archiving is a visibility change: the session keeps its ID, log, and workspace
slot. Native restore removes the ID from the archive set without replacing the
thread, dropping its unfinished tail, or moving its children to a new parent.
No server restart or storage-file edit is needed.

Authenticate the correct Host using [Authenticated RPC](rpc.md). Every lifecycle
write still requires human approval of the exact action and targets.

## Preview the targets

Run from the skill directory:

```sh
node scripts/unarchive.mjs list
node scripts/unarchive.mjs restore session-xxxx
node scripts/unarchive.mjs restore session-xxxx session-yyyy
```

[unarchive.py](../scripts/unarchive.py) is a compatibility launcher with the same
arguments. Both entry points support `--base-url` and `--auth-file` through the
shared client.

`list` is read-only. It joins the `workspace/follow` baseline's archive set and
workspace membership with `session/list`. Each entry includes the ID, cached
title, `workspaceOwned`, `available`, and `archived`. It does not claim to show
an exact latest title or interaction time; use the cold-safe reply reader when
those facts matter.

`restore`, `archive`, and `fork` are dry-run unless `--commit` is present. Review
the complete target list, including missing or unowned entries. A commit refuses
any selected target absent from the session list or without a workspace slot;
it does not try to reconstruct missing data or adopt an unowned session.

## Restore the original identity

After the human approves the previewed IDs:

```sh
node scripts/unarchive.mjs restore session-xxxx session-yyyy --commit
```

For each ID, the helper calls:

```sh
node scripts/rpc.mjs call workspace/unarchiveSession '{"request":{"sessionId":"session-xxxx"}}'
```

The receipt's `archivedSessionIds` must omit the restored ID. The helper checks
that result. An ID already absent from the archive set is a native no-op; no
new session is created. A restored blank session may still be hidden by the
sidebar's blank-session filter.

Bulk selection is available:

```sh
node scripts/unarchive.mjs restore --all
```

`--all --commit` re-reads the archive set; a dry-run is not a saved transaction.
Prefer explicit approved IDs when the set can change between review and
execution. Multiple targets are processed sequentially, not atomically. If a
later request fails, earlier restorations remain applied. Check state instead
of replaying the whole command automatically.

## Archive a visible thread

Preview first, then add `--commit` only after approval:

```sh
node scripts/unarchive.mjs archive session-xxxx
```

The helper calls `workspace/archiveSession` and checks that the returned archive
set contains the target. This hides the thread; it does not delete its log or
clear pending input. Use it to re-hide a restored thread or an unwanted fork
only when the human asks for that action.

## Fork only when a new thread is wanted

```sh
node scripts/unarchive.mjs fork session-xxxx
node scripts/unarchive.mjs fork session-xxxx --at-seq 123
```

`123` is an example event anchor. Add `--commit` only after approval of the
source and intended cut. Fork is a different action from restoration:

| Property | Native restore | Fork |
|---|---|---|
| Session ID | Preserved | New ID with `parentSession` lineage |
| History | Original log remains intact | Prefix through an eligible `turn/end` |
| Unfinished tail | Preserved | Excluded from the default fork cut |
| Subagent children | Keep the same parent | Remain with the original; not copied |
| Workspace slot | Original slot retained | A new slot is added when the fork is attached |
| Original's archive state | Cleared | Unchanged unless separately archived |

An anchor inside an unfinished turn, or a source with no eligible ended turn,
can fail `session/fork-unavailable`. A fork is not a promise to preserve the
original's runtime model selection. Choose native restore when the goal is to
continue the same thread with its original state.

`--archive-original` adds a separate archive request after a successful fork.
It must be part of the approved plan. If archiving fails or its receipt does not
list the original as archived, the command exits nonzero with the new fork
already created; inspect both IDs rather than retrying the fork.

## Boundaries

The helper never edits `$DSH_HOME/storages/workspace.json`, stops the Host, or
uses an authentication failure as permission for an offline fallback. If login,
ownership, or availability checks fail, report the specific limitation.

The [unarchive discussion draft](unarchive-discussion-draft.md) is a historical,
unposted artifact, not guidance for the current native API.
