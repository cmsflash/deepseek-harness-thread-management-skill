# Draft: GitHub Discussion for deepseek-ai/deepseek-harness

Not posted. `deepseek-ai` is outside the Aire orgs, so posting needs Zhuoran's
go-ahead; if an agent posts it rather than him, it must say so explicitly.

- Repo: https://github.com/deepseek-ai/deepseek-harness (Discussions enabled)
- Category: **Ideas**
- Title: `Archiving a session is one-way: no unarchive API, no archived-session view`

---

## Body

Archiving a session has no inverse. `workspace.archiveSession` exists;
nothing undoes it — no RPC, no registry method, no CLI subcommand, no slash
command. Archived sessions also have no viewing surface, so once archived a
session cannot be listed, opened, or restored from the UI.

This looks deliberate rather than accidental. The Agent Note that shipped the
feature (`.agents/notes/implemented/feature/2026-07-31-session-archive-global-set.md`)
closes:

> Archived sessions have no viewing or unarchive surface yet (this iteration's
> scope; recorded as a README Known Limitation); data and accounting slots stay
> intact, so a future restore is one UI surface plus one inverse RPC.

and `packages/client/ui-workspace/README.md` lists it under Known Limitations.
The storage anticipates the restore: `archivedSessionIds`' JSDoc notes an
archived session keeps its `sessionIds` slot "so unarchiving restores its
position", and `workspace.ts` refers to "a future unarchive".

### Why the gap is sharper than it looks

Archive is the only operation whose purpose is removing its own entry point.
Every other session verb — prompt, steer, rename, fork, cancel — acts on a row
that stays visible, so its inverse is cheap. Other reversible pairs in the API
(`goal.pause`/`resume`, `credentials.set`/`unset`, `workspace.create`/`delete`)
all keep their subject on screen. Archive does not, so the missing inverse is
the one that strands state.

It also can't be filled by a plugin, which is unusual for this codebase.
`RpcMethodMap`, `UNARY_ROUTES`, and the client method table are closed
enumerations; there is no `registerMethod`/`registerRpc` seam anywhere in
`packages/`, unlike tools, events, and slots. So unlike most gaps here, users
cannot patch around it locally.

Two further points make recovery awkward:

- **There is no session deletion at all** — logs are append-only and permanent
  (the `_deleteSession` in `session-query-sqlite` removes search-index rows,
  not logs). Archive is the only "remove from view" verb, so it absorbs
  everything users mean by hide, defer, and clean up.
- **The durable state is memory-owned.** The archive set is a flat array in
  `$DSH_HOME/storages/workspace.json`, but `storage-domain` treats in-memory
  state as authoritative and the JSON unit republishes the whole file per
  write, so hand-editing while DSH runs is silently reverted. Recovery
  therefore requires stopping the app.

### Two workarounds today

1. **Fork the archived session.** `session.fork` reads cold sessions without
   acquiring an Agent, and the child gets a fresh id absent from
   `archivedSessionIds`, so it is visible immediately while the original stays
   archived. Verified working against an archived session. Costs the session
   id, records `parentSession`/`seedLength` lineage, and drops an unfinished
   final turn (the seed cuts at the last `turn/end`).
2. **Stop DSH and edit `archivedSessionIds`.** True restore — same id, same
   position — but needs a restart, so it does not scale to routine use.

Neither is discoverable from the product.

### Suggestion

The inverse RPC seems worth splitting from the UI. `workspace.unarchiveSession`
mirrors `archiveSession` closely: same write chain, and the existing
`host/archived-sessions-changed` frame already carries the full snapshot, so a
shrinking set needs no new client merge logic. That alone makes archiving
reversible for API and script users without settling how an archived-sessions
view should look.

A viewing surface is the larger design question (where it lives, whether
archived sessions appear in search) and could follow separately.

Happy to open a PR for the RPC half if that split sounds right.
