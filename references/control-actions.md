# DSH control actions: the write surface

Wire recipes for acting on another thread. `$API` is
`http://127.0.0.1:3080/api`; every call uses the envelope documented in
SKILL.md, and every call here is a **write**, so the propose-then-act rule
governs all of them: the target's durable log cannot tell an agent from the
owner.

## Session lifecycle

```sh
# create (preallocated id is idempotent on retry; needs the FULL workspace id)
curl -s -X POST $API/session.create -H 'Content-Type: application/json' -d '{"type":"client-request","rpcId":"c1","method":"session.create","payload":{"sessionId":"session-<uuid>","workspaceId":"<full uuid>"}}'
# fork: child inherits cwd, model target, lineage; seed = source's last completed turn
# atSeq anchors to the first turn/end at or after it; a still-open turn fails fork-unavailable
curl -s -X POST $API/session.fork   -H 'Content-Type: application/json' -d '{"type":"client-request","rpcId":"c2","method":"session.fork","payload":{"sessionId":"<src>"}}'
# rename (pins the title against regeneration)
curl -s -X POST $API/session.rename -H 'Content-Type: application/json' -d '{"type":"client-request","rpcId":"c3","method":"session.rename","payload":{"sessionId":"<id>","title":"New title"}}'
# archive: display-level; keeps the log and the workspace slot. One-way over the
# API — there is no unarchive method. See references/unarchive.md to get one back.
curl -s -X POST $API/workspace.archiveSession -H 'Content-Type: application/json' -d '{"type":"client-request","rpcId":"c4","method":"workspace.archiveSession","payload":{"sessionId":"<id>"}}'
```

`workspaceId` must be the full UUID from `workspace.list` — a truncated id
returns `workspace-not-found` and looks like the workspace vanished.

There is no session deletion anywhere in DSH — no RPC, no CLI, no registry
method. Session logs are append-only and permanent. (`session-query-sqlite`'s
`_deleteSession` removes search-index rows, not logs.) Archiving is the only
"remove from view" operation, which is why unarchiving matters.

## Cancel

```sh
curl -s -X POST $API/session.cancel -H 'Content-Type: application/json' -d '{"type":"client-request","rpcId":"k1","method":"session.cancel","payload":{"sessionId":"<id>"}}'
```

Cancelling preserves pending inbox work — it resumes after settlement. The log
records `{kind:"aborted", reason:{kind:"user"}}`, identically for API cancels and
the owner's stop button.

## The transient queue

Pending inbox state lives only in the mux stream (`session/queue` frames), never
in the durable log. Watch it with a WebSocket on `ws://<host>/api/events.mux`
filtering `payload.sessionId` (a plain GET returns `426 Upgrade Required`). Each
frame is the complete snapshot:
`{placement: "queued"|"steering"|"context", id, message}`.

```sh
# edit a still-pending queued message (content replaces wholesale)
curl -s -X POST $API/session.updateQueue -H 'Content-Type: application/json' -d '{"type":"client-request","rpcId":"q1","method":"session.updateQueue","payload":{"sessionId":"<id>","itemId":"<msg uuid>","action":{"kind":"edit","content":[{"type":"text","text":"replacement"}]}}}'
# remove a pending message
#   same shape with "action":{"kind":"remove"}
# convert a queued message into a steer of the running turn
#   same shape with "action":{"kind":"steer"}
```

Cancelled turns preserve their queued messages; after settlement (seconds to
~80s observed) the next queued message claims the following turn. A queue-edit
survives durably: the edited text is what the turn claims.

## Slash commands (the permission switch, and more)

`session.prompt` does NOT intercept slash commands — a prompt starting with `/`
goes to the model as ordinary text. Commands execute through the Typert gateway
with NAMED args:

```sh
curl -s -X POST $API/commands/execute -H 'Content-Type: application/json' -d '{"type":"client-request","rpcId":"cmd1","method":"commands/execute","payload":{"args":{"agentId":"<sessionId>","line":"/permission read-only","images":[]}}}'
```

`/permission <preset>` is the practical use: switch a thread between
`read-only` / `workspace-write` / `danger-full-access` (this also changes its
approval policy). Other registered commands take the same shape. An unknown
command returns a success envelope with no `value` — check for `.result.value`
before trusting execution.

## Approvals and questions

When a thread hits a permission boundary (or calls `ask_user_question`), the host
mints an answerable frame with a **fresh envelope rpcId** and pushes it on the
mux stream. The frame replays — same rpcId — on every stream open while still
pending. Answering is `POST /api/respond` with the envelope's rpcId echoed plus a
payload validated against the pending entry.

Use the bundled script rather than hand-rolling the dance:

```sh
scripts/respond.mjs <sessionId>                      # list pending approvals/questions
scripts/respond.mjs <sessionId> --approve <approvalId> [allowed-once|rejected]
scripts/respond.mjs <sessionId> --answer '[{"id":"color","selected":["Red"]}]'
```

It connects, collects the replayed pending frames, and answers through
`/api/respond` in one step. Question answers are semantically validated: answer
ids must match the question ids in order, selected labels must be among the
question's declared options, and a single-select question takes exactly one
selected label. Approvals correlate by `sessionId` + `approvalId`.

The consequence chain for an approval: `approval/asked` event → your outcome via
respond → `approval/decided` event (e.g. `allowed-once`) → the escalated tool
call executes. For a question: `question/requested` frame → answer →
`question/resolved` outcome `answered` → the model receives your answer as the
tool result, verbatim.

**This is the one action to hold hardest.** Answering is the owner's permission
decision; never do it without an explicit, specific instruction for that exact
request.

## Subagent children over HTTP

`subagent.prompt` and `subagent.interrupt` over HTTP need no live parent and no
in-harness authority — naming the `parentSessionId` in the address IS the
credential (this is the exact check that blocks in-harness `send_message`; the
HTTP layer does not repeat it):

```sh
# child ids come from subagent.list; continuable children accept prompts
curl -s -X POST $API/subagent.list -H 'Content-Type: application/json' -d '{"type":"client-request","rpcId":"s1","method":"subagent.list","payload":{"parentSessionId":"<parent>"}}'
curl -s -X POST $API/subagent.prompt -H 'Content-Type: application/json' -d '{"type":"client-request","rpcId":"s2","method":"subagent.prompt","payload":{"parentSessionId":"<parent>","childSessionId":"<child>","mode":"continuable","content":[{"type":"text","text":"..."}]}}'
curl -s -X POST $API/subagent.interrupt -H 'Content-Type: application/json' -d '{"type":"client-request","rpcId":"s3","method":"subagent.interrupt","payload":{"parentSessionId":"<parent>","childSessionId":"<child>","mode":"continuable"}}'
```

`subagent.prompt` returns a `messageId`; the child's next turn carries your
content. `subagent.interrupt` is fire-and-return: `accepted` acknowledges the
cancel signal, not quiescence.

## Trials

To prove or rehearse an action without touching real threads: create a scratch
session (`session.create`, preallocated id), run trivial `Reply with exactly: X`
turns, arm an approval by setting `/permission read-only` then requesting a file
write outside the workspace, and answer it with `scripts/respond.mjs`. Every
capability in this file was validated that way against live threads. Leave the
scratch threads in place unless told to clean up — the owner inspects them.
