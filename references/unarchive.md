# Getting an archived thread back

DSH archives one-way. `workspace.archiveSession` exists; no inverse does — not
as an RPC, not as a registry method, not as a CLI subcommand, not as a slash
command. Archived threads also have no viewing surface, so the sidebar cannot
show you what you archived.

This is scope, not oversight. The Agent Note that shipped the feature
(`.agents/notes/implemented/feature/2026-07-31-session-archive-global-set.md`)
closes: *"Archived sessions have no viewing or unarchive surface yet (this
iteration's scope …); data and accounting slots stay intact, so a future restore
is one UI surface plus one inverse RPC."* The storage anticipates it — an
archived session keeps its `sessionIds` slot precisely so a restore lands it
back in position.

Archiving is **non-destructive**: the session log is untouched, the workspace
accounting slot is preserved, and the archive set is one flat array of ids. It
is a visibility flag. Nothing is lost, and both recipes below are recoveries,
not repairs.

## Where the state lives

`$DSH_HOME/storages/workspace.json` → `global.archivedSessionIds`, a flat array
of session ids in archive order. Everything else about the session is untouched.

## Two recipes, different tradeoffs

|  | Fork copy | True unarchive |
|---|---|---|
| DSH restart | **No** — works live | Required |
| Session id | New | **Preserved** |
| Lineage | Records `parentSession` | **Clean** |
| Unfinished final turn | Dropped | **Preserved** |
| Bulk restore | Impractical (spins an agent each) | **Trivial** |
| Original | Stays archived (hidden) | Becomes visible again |

Pick the fork when DSH must stay up or you want one thread back now. Pick the
true unarchive when identity matters, when you need many at once, or when the
last turn never finished.

## Recipe A — fork copy (live, no restart)

The archived original already satisfies "hidden". A fork gets a fresh id that
is not in `archivedSessionIds`, so it is visible immediately; the original stays
archived where it was. No deletion is needed — and none exists.

```sh
scripts/unarchive.py list                  # archived threads: title, date, turns
scripts/unarchive.py fork <session-id>     # add --commit to actually write
scripts/unarchive.py archive <new-id>      # undo: re-hide an unwanted fork
```

`session.fork` reads the source "using attached state or persistence inspection
without acquiring an Agent", so a cold archived thread forks fine.

What transfers: complete event history through the last completed turn, cwd,
model target, `agentPreset`, and the source title. What does not: the session
id, clean lineage (the child durably records `parentSession` and `seedLength`),
and any unfinished final turn — the seed cuts at the last `turn/end`.

**Subagent children do not transfer** (verified: a source with one child forked
to zero). The parent's subagent tool calls and results stay in the transcript,
so the record of what the children did survives; the child sessions keep
pointing at the original id and are unreachable from the fork. `fork` warns when
the source has children. To reach them, go back to the original — archived
threads are hidden, not gone, and `subagent.list` still answers for them.

A fork also consumes a workspace `sessionIds` slot, and the archived original
keeps its own slot forever by design, so each rescue permanently adds an entry
to a workspace that never shrinks. Fine for a few threads; use recipe B for bulk.

Forking a source whose final turn is still open fails `fork-unavailable`. Since
archived threads are almost always idle, this is rare; when it bites, use
recipe B, which preserves the partial turn.

## Recipe B — true unarchive (offline edit, needs a restart)

Remove the id from `global.archivedSessionIds` and the thread returns intact —
same id, same position, no fork lineage.

**DSH must be stopped first.** Not because adding threads needs a restart (it
does not — recipe A is live), but because of who owns the file. The
`storage-domain` runtime holds authoritative in-memory state: writes "await
backend durability FIRST, then mutate memory". The JSON unit republishes the
*entire file* on every write. So `workspace.json` is a dump of memory that DSH
overwrites wholesale, not a database it reads from. Edit it live and the
registry never sees your change (`this.state` is a cached field, never re-read),
and the next unrelated write — creating a workspace, archiving anything —
serializes stale state over your edit and silently reverts it.

```sh
# 1. find the DSH web server and stop it
lsof -nP -iTCP -sTCP:LISTEN | grep "node.*bin.js --profile web"
# 2. edit (writes a .bak alongside)
scripts/unarchive.py restore <session-id> [<session-id> ...] --commit
scripts/unarchive.py restore --all --commit        # bulk
# 3. start DSH again
```

Stopping the server ends any running turns, so check `running` before killing
it.

## Finding the id

Archived sessions still come back from `session.list` with titles and
projections — only the UI filters them. `scripts/unarchive.py list` joins the
archive set against that listing and prints title, date, and turn count.

An archived id that no longer resolves to a listed session means the log is
gone; neither recipe recovers it, and the script marks it `<missing>`.

## Upstream

Tracked as a gap worth fixing properly: the inverse RPC is small and purely
additive, but it cannot be a plugin — `RpcMethodMap`, `UNARY_ROUTES`, and the
client method table are closed enumerations with no registration seam
(no `registerMethod`/`registerRpc` anywhere in `packages/`). See
`references/unarchive-discussion-draft.md` for the upstream write-up.
