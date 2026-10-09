# DSH control actions

Use the authenticated client and named-argument envelopes in
[Authenticated RPC](rpc.md). Run examples from the skill directory after
selecting and authenticating the authorized Host.

**Propose, then act.** Get human approval of the exact target, action, and
content before any write. `rpc.mjs call` sends immediately; it has no dry-run
mode. Authentication is not permission to act. Every prompt and queue edit
carries the `[agent-drafted: …]` header from [SKILL.md](../SKILL.md#standing-rules).
The listing and observation examples below are reads, not permission to perform
their adjacent writes.

## Session lifecycle

Discover full workspace IDs from the `workspace/follow` baseline, not a
truncated display ID. These calls use `payload.args.request`:

```sh
node scripts/rpc.mjs call session/create '{"request":{"sessionId":"session-<fresh UUID>","workspaceId":"<full workspace ID>"}}'
node scripts/rpc.mjs call session/fork '{"request":{"sessionId":"<source session ID>"}}'
node scripts/rpc.mjs call session/rename '{"request":{"sessionId":"<session ID>","title":"<exact approved title>"}}'
node scripts/rpc.mjs call workspace/archiveSession '{"request":{"sessionId":"<session ID>"}}'
node scripts/rpc.mjs call workspace/unarchiveSession '{"request":{"sessionId":"<session ID>"}}'
```

Archive hides a session without removing its log or workspace slot. Native
unarchive restores the same ID on the running Host. Prefer the dry-run recovery
helper in [Restoring archived threads](unarchive.md) for previewing these actions.
Do not edit the workspace registry or stop the server to restore a thread.

Fork creates a new session with `parentSession` lineage and a history prefix
ending at a `turn/end` boundary. Its default cut omits an unfinished tail; an
`atSeq` inside a turn with no eligible end fails `session/fork-unavailable`.
Subagent children remain attached to the original, not the fork. Do not assume
runtime model selection transfers; choose unarchive when preserving the
original identity and state is the goal.

## Cancel a turn

```sh
node scripts/rpc.mjs call session/cancel '{"request":{"sessionId":"<session ID>"}}'
```

`{accepted:true}` acknowledges cancellation, not quiescence. Pending inbox work
is preserved and can start a later turn. Removing queued work is a separate
write requiring approval of the specific item.

## Inspect or change pending input

Pending input is represented by the `inbox` projection, with `next-turn` and
`next-step` arrays of messages. A message's `id` is the `itemId` for a queue
mutation; it is not a prompt request ID or a pending-interaction event ID.

For resident sessions, a bounded `session/control` read provides
`baseline.value.projections[sessionId].values.inbox`; later projection frames
replace the value for their session and key:

```sh
node scripts/rpc.mjs stream session/control '{}' --max-items 1
```

An absent projection is not proof that a cold session has no queued work. Do
not bulk-follow cold sessions just to populate control state. Pending input is
reconstructed from durable `agent/inbox/spliced` events, not only a transient
WebSocket queue.

After approval, edit, remove, or promote one still-pending message:

```sh
node scripts/rpc.mjs call session/updateQueue '{"request":{"sessionId":"<session ID>","itemId":"<message ID>","action":{"kind":"edit","content":[{"type":"text","text":"<exact approved replacement>"}]}}}'
node scripts/rpc.mjs call session/updateQueue '{"request":{"sessionId":"<session ID>","itemId":"<message ID>","action":{"kind":"remove"}}}'
node scripts/rpc.mjs call session/updateQueue '{"request":{"sessionId":"<session ID>","itemId":"<message ID>","action":{"kind":"steer"}}}'
```

Edits replace content wholesale and accept nonempty text only. Steering
requires a next-turn item and a running target. The item may be consumed between
inspection and submission; a missing-item or unavailable-steer error is not a
reason to retry automatically.

## Execute a slash command

A slash-prefixed `session/prompt` message goes to the model as text. Invoke
commands through `commands/execute` with these direct named arguments:

```sh
node scripts/rpc.mjs call commands/execute '{"agentId":"<session ID>","line":"/permission read-only","submittedAttachments":[]}'
```

That example changes permissions and needs explicit approval just like any
other command. `submittedAttachments` is required even for a plain invocation;
use an empty array. An undefined `result.value` means no command matched the
line; the CLI prints `null`. When a value exists, inspect the nested command
result rather than treating RPC success as command success.

## Observe pending approvals or questions

**Never answer without the human's exact authorization for that event and
response.** The approval is their permission decision; a question is their
input, not an invitation to choose on their behalf.

```sh
node scripts/respond.mjs session-xxxx --list
node scripts/respond.mjs session-xxxx --list --wait-seconds 3
```

The helper opens `$events` over `/api/remote.mux`. Application frames include:

```jsonl
{"type":"ready","clientId":"<connection generation>"}
{"type":"waterfall","event":"approval/request","eventId":"<event ID>","agentId":"<session ID>","request":{}}
{"type":"waterfall","event":"user-questions/request","eventId":"<event ID>","agentId":"<session ID>","request":{}}
{"type":"cancel","eventId":"<event ID>"}
```

Use the actual `request` to identify the permission boundary or question.
`cancel` removes the corresponding pending entry. Listing filters for the
specified session and observes a bounded window after `ready`, three seconds
by default. There is no atomic replay-complete marker: `complete:false` and an
empty `pending` array do not prove that no request exists. Passive listing
never calls `$events/next` to advance a waterfall.

### Submit an authorized response

The approval argument is the waterfall's **event ID**, not an approval ID or a
transport `rpcId`. Question responses also require an explicit event ID:

```sh
node scripts/respond.mjs session-xxxx --approve '<event ID>' allowed-once
node scripts/respond.mjs session-xxxx --approve '<event ID>' rejected
node scripts/respond.mjs session-xxxx --answer '[{"id":"color","selected":["Red"]}]' --event-id '<event ID>'
```

The omitted approval outcome defaults to `allowed-once`; pass it explicitly
when carrying out a human decision. Question answers must name each question
from the selected event exactly once. Use the request's exact option labels and
only the human-approved selections or custom text.

The helper waits to observe that event on a live stream. While keeping the same
connection open, it submits unary `$events/result` with direct named arguments:

```json
{"clientId":"<live connection generation>","eventId":"<event ID>","outcome":{"kind":"result","value":"allowed-once"}}
```

For questions, `outcome.value` is `{"answers":[...]}`. If the exact event is not
observed in the window, nothing is submitted. Do not reuse a `clientId` from a
closed listing connection or guess an event ID.

A successful result RPC can be a stale no-op if the request has already
settled. The helper therefore reports `status:"submitted"` with
`confirmation:"unconfirmed"`, not "approved" or "answered". Report that limit,
verify separately when needed, and never retry an uncertain submission
without checking state and authorization.

## Address subagent children

Read the direct-child catalog with `subagents/list`:

```sh
node scripts/rpc.mjs call subagents/list '{"parentSessionId":"<parent session ID>"}'
```

After approval, a continuable child's prompt uses a nested request with its own
required `requestId` and explicit `delivery`:

```sh
node scripts/rpc.mjs call subagents/prompt '{"request":{"requestId":"<fresh prompt UUID>","parentSessionId":"<parent session ID>","childSessionId":"<child session ID>","mode":"continuable","delivery":"queue","clientTimeZone":"America/Los_Angeles","content":[{"type":"text","text":"<exact approved message>"}]}}'
```

Use `delivery:"steer"` only for explicitly authorized steering. Prompt delivery
requires the exact live direct parent and a resumable child; naming a parent
is not a credential or a way around delegated authority. A returned `messageId`
means the child's inbox accepted the message, not that it finished.

Interrupt uses direct named arguments, not a nested request:

```sh
node scripts/rpc.mjs call subagents/interruptByParent '{"childSessionId":"<child session ID>","parentSessionId":"<parent session ID>","mode":"continuable"}'
```

It validates the parent address against a live child's ownership and can work
while the parent is offline. Absent or idle targets can be accepted no-ops;
`accepted` is not proof that a turn was interrupted or has settled. Do not send
child control through ordinary-session endpoints to avoid these checks.

## Validate without unrelated writes

Run `node --test tests/*.test.mjs` from the skill directory. For an authorized
live action, check the method's receipt and the relevant resulting state. Do
not create scratch sessions, change permissions, or answer pending requests
merely to rehearse a transport call.
