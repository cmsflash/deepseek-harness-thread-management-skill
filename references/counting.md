# Count DSH sessions

Count workspace ownership minus the archive set. A session log on disk is not
necessarily a sidebar thread: subagent children and other unowned sessions can
have logs without a workspace slot. Active in this document means
**workspace-owned and not archived**, not currently running.

## Use the live workspace baseline

After [authenticating the correct Host](rpc.md), read one application frame:

```sh
node scripts/rpc.mjs stream workspace/follow '{}' --max-items 1
```

`workspace/follow` takes empty named arguments and begins with
`{type:"baseline",value:{items,archivedSessionIds}}`. Compute from that single
baseline:

```text
owned          = union of value.items[].sessionIds
archived       = set(value.archivedSessionIds)
active         = |owned − archived|
archived_owned = |owned ∩ archived|
```

Include blank sessions in this count. To report running state or inspect cached
titles, join the IDs with:

```sh
node scripts/rpc.mjs call session/list '{"_request":{}}'
```

`session/list` alone is not an active-workspace count: it can include archived
sessions and subagents. A missing row is a discrepancy to report, not permission
to silently remove the ID from the ownership total. The workspace baseline and
session listing are separate observations and can race with changes.

Do not open `session/follow` on every thread for counts or an activity audit;
it can promote cold Agents. The workspace baseline and session list do not
need that promotion. For exact committed reply times on selected ordinary
threads, use [read-last-reply.mjs](../scripts/read-last-reply.mjs), not a cached
projection `asOfSeq` as though it were the current log end.

## Use the local-file helper when appropriate

[count-active-sessions.py](../scripts/count-active-sessions.py) reads the
workspace registry and counts log paths without loading message bodies:

```sh
python3 scripts/count-active-sessions.py
python3 scripts/count-active-sessions.py --json
python3 scripts/count-active-sessions.py --dsh-home /path/to/.dsh
```

The home selection order is `--dsh-home`, then `$DSH_HOME`, then `~/.dsh`.
Confirm that this home belongs to the Host being discussed; changing
`DSH_WEB_URL` does not change the counter's local data source.

The registry is `$DSH_HOME/storages/workspace.json`. Its equivalent formula is:

```text
owned    = union of tables.workspaces[w].sessionIds for w in global.workspaceIds
archived = set(global.archivedSessionIds)
active   = |owned − archived|
```

`global.workspaceIds` defines the authoritative workspace list. Archiving keeps
the session's slot, so archived IDs must be subtracted. The helper reads a file
snapshot, not an atomic live Host view; prefer the authenticated workspace
baseline when reconciling current state.

## Keep the populations separate

| Population | Definition |
|---|---|
| Active | Workspace-owned and absent from the archive set |
| Archived, owned | Workspace-owned and present in the archive set |
| Orphan log | Log on disk without an owning workspace slot |
| Archived without owner | Archive-set ID without an owning workspace slot |
| Owned without log | Workspace-owned ID with no log found by the local scan |

Unowned logs are not automatically disposable or broken. Subagent children
normally account for some of them. When attribution matters, inspect only the
log header's `origin` and parent metadata. Do not decompress whole message
histories merely to count or classify paths, and do not infer all orphans are
children from a past sample.

## Report the count accurately

State the population and source with the result. Include the live observation
time or the local registry mtime, converted to `America/Los_Angeles` and labelled
PST or PDT. An unlabelled machine-local timestamp must be converted or verified
before quoting it as Pacific Time; leave timestamps inside quoted logs unchanged.

The registry can change between reads, so a changed number is not by itself a
counting error. Conversely, do not assume every difference is archiving: first
check the Host, home directory, population, and observation cut.

The sidebar can hide blank sessions except the selected one, and collapsed
groups can hide their rows. Thus `owned − archived`, including blanks, is the
ownership/archive population, not an exact count of rendered rows. Never
compute it as `logs_on_disk − archived`, which includes unowned logs, or label
it as a count of running turns.
