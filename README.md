# deepseek-harness-thread-management

An agent skill for reading and managing DeepSeek Harness (DSH) threads through
its authenticated local Host API. It covers thread discovery, bounded reply
reads, prompting, lifecycle changes, pending interactions, session counts, and
waiting for a running turn to end.

**Propose, then act.** Before any write, get the human's approval of the exact
target, action, and content. Authentication grants API access, not permission to
act. Never answer a pending approval or question without explicit authorization
for that request. The helpers do not retry requests automatically.

## Setup

Use Node **22.19 or newer**. The Python compatibility launchers also require
Node; the file-based counting helper requires Python 3.9 or newer.

Choose the existing Host's actual origin and authenticate as described in
[Authenticated local RPC](references/rpc.md). Login exchanges an
operator-approved startup URL from the explicitly identified current process's
stdout, or an operator-provided URL file, for a private server-issued cookie.
It does not use Chrome, read signing secrets, forge cookies, disable auth, or
restart DSH.

All Node helpers use `--base-url`, then `DSH_WEB_URL`, then the default
`http://127.0.0.1:3080`. Set `DSH_ROOT` to an existing DSH checkout if it is not at
`/Users/zhuoran/Programs/deepseek-harness`. The shared client resolves `ws`
through `packages/api/gateway/package.json`; the reply reader resolves `fflate`
through `packages/session-query/session-log-export/package.json` in that checkout.

## Usage

Run these examples from the skill directory after selecting and authenticating
the correct Host:

```sh
node scripts/rpc.mjs call session/list '{"_request":{}}'
node scripts/rpc.mjs stream workspace/follow '{}' --max-items 1

node scripts/read-last-reply.mjs --session session-xxxx
node scripts/read-last-reply.mjs --session session-xxxx --json

node scripts/wait-for-turn-end.mjs --session session-xxxx --timeout-min 30
node scripts/respond.mjs session-xxxx --list

node scripts/unarchive.mjs list
node scripts/unarchive.mjs restore session-xxxx

python3 scripts/count-active-sessions.py
python3 scripts/count-active-sessions.py --json
```

- The reply reader scans the first root JSONL entry of an authenticated session
  export to establish the exact committed cursor, title, and interaction times.
  It cancels the download before bulk attachments, then reads a small collapsed
  `session/page` window. It labels final, progress, and interrupted responses and
  flags newer unanswered or attachment-only prompts. It does not promote cold
  Agents or print raw reasoning and streaming chunks.
- The waiter checks `session/list` first and follows only a running target. It
  matches the target turn across the opening snapshot and live events. Run it
  as a managed background job; job settlement is the notification.
- Pending-interaction listing observes a bounded window, three seconds by
  default. It is not an exhaustive replay. See [Control actions](references/control-actions.md)
  before answering any event.
- Recovery mutations are dry-run unless `--commit` is present. Native restore
  uses `workspace/unarchiveSession` on the running Host and preserves the
  original session ID. No storage edit or server restart is needed. See
  [Restoring archived threads](references/unarchive.md) for validation and fork
  trade-offs.
- Counts use workspace ownership minus the archive set, including blank
  sessions. That is neither a running-turn count nor an exact sidebar render
  count. Use [Counting sessions](references/counting.md) for the live baseline
  and local-file methods.

The existing [read-last-reply.py](scripts/read-last-reply.py) and
[unarchive.py](scripts/unarchive.py) entry points delegate to the Node helpers
with the same arguments. Report human-facing times in `America/Los_Angeles`,
labelled PST or PDT as appropriate; leave quoted log timestamps unchanged.

## Install

Symlink into the central skill store:

```sh
ln -s ~/Programs/skills/deepseek-harness-thread-management-skill ~/.agents/skills/deepseek-harness-thread-management
ln -s ~/.agents/skills/deepseek-harness-thread-management ~/.claude/skills/deepseek-harness-thread-management
```

[SKILL.md](SKILL.md) is the agent-facing entry point.

## Layout

| File | Purpose |
|---|---|
| [SKILL.md](SKILL.md) | Safety rules, discovery, reading, prompting, and waiting |
| [rpc.md](references/rpc.md) | Authentication, private cookie cache, named arguments, and Remote streams |
| [control-actions.md](references/control-actions.md) | Lifecycle, cancel, queue, commands, approvals, and subagents |
| [counting.md](references/counting.md) | Live and file-based counts, populations, and interpretation |
| [unarchive.md](references/unarchive.md) | Native restore, archive, fork, and dry-run safety |
| [unarchive-discussion-draft.md](references/unarchive-discussion-draft.md) | Historical unposted artifact; not current API guidance |
| [rpc-client.mjs](scripts/rpc-client.mjs) | Shared authenticated HTTP and Remote-stream client |
| [rpc.mjs](scripts/rpc.mjs) | Login, unary calls, bounded streams, and liveness probe |
| [read-last-reply.mjs](scripts/read-last-reply.mjs) | Cold-safe committed-cut reply reader |
| [wait-for-turn-end.mjs](scripts/wait-for-turn-end.mjs) | Running-target turn watcher |
| [respond.mjs](scripts/respond.mjs) | Bounded pending-event observation and explicitly authorized responses |
| [unarchive.mjs](scripts/unarchive.mjs) | Recovery preview and native lifecycle writes |
| [count-active-sessions.py](scripts/count-active-sessions.py) | Counts from the local workspace registry |

## Validation

Run the offline helper tests from the skill directory:

```sh
node --test tests/*.test.mjs
```

Do not create scratch threads, change permissions, send prompts, or answer
pending events merely to verify the transport. Any live verification must stay
within the separately authorized Host and action scope.
