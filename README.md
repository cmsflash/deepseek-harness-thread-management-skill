# deepseek-harness-thread-management

An agent skill for working with [DeepSeek Harness](https://github.com/deepseek-ai)
(DSH) threads other than the one you are in: reading them, prompting them,
controlling them, counting them, and waiting on them.

DSH exposes no model-facing tool that enumerates sessions, reads sibling threads,
acts on them, or notifies an agent about them. Every capability here therefore
comes from outside the harness — the host's local RPC API (the same
unauthenticated loopback surface the browser GUI uses) and DSH's own state files.

- **Reading** fetches another thread's last human prompt and final reply through
  `session.history`, small tail window first — intermediate turns and tool
  traffic are almost never what the question needs.
- **Prompting** sends any message — not just "continue" — through
  `session.prompt`, in `queue` or `steer` mode.
- **Controlling** covers the write surface: create, fork, rename, archive,
  cancel, queued-message edit/remove, remote slash commands (including
  `/permission`), answering pending approvals and questions, and subagent
  children over HTTP.
- **Recovering** gets an archived thread back. DSH archives one-way — no
  unarchive API, no archived-session view, and no session deletion anywhere —
  so the skill supplies both inverses: a live fork copy, or a true unarchive by
  editing the archive set with DSH stopped.
- **Counting** reads the workspace registry
  (`$DSH_HOME/storages/workspace.json`), not the `$DSH_HOME/sessions/`
  directory — logs on disk outnumber active sessions by roughly 4x, because
  subagent children each write a log without being filed into a workspace.
- **Waiting** watches the GUI's own WebSocket event stream (`/api/events.mux`)
  for a target session's `turn/end`, run as a background job so job settlement
  becomes the agent's notification. No polling.

Every write is indistinguishable from the owner's own input in the target's
durable log, so the skill puts all of them behind a propose-then-act rule: the
human approves the exact content first. Answering another thread's pending
approval or question needs an explicit instruction for that specific request.

Every recipe was validated against live threads — scratch sessions armed with
`/permission read-only` plus a file-write request, then answered through the
bundled script.

## Usage

```sh
scripts/count-active-sessions.py            # human-readable table
scripts/count-active-sessions.py --json     # machine-readable
scripts/count-active-sessions.py --dsh-home /path/to/.dsh

scripts/read-last-reply.py --session session-xxxx    # last prompt + final reply

scripts/wait-for-turn-end.mjs --session session-xxxx [--timeout-min 30]

scripts/respond.mjs <sessionId>                      # list pending approvals/questions
scripts/respond.mjs <sessionId> --approve <approvalId> [allowed-once|rejected]
scripts/respond.mjs <sessionId> --answer '[{"id":"color","selected":["Red"]}]'

scripts/unarchive.py list                    # archived threads: title, date, turns
scripts/unarchive.py fork <id> --commit      # live copy under a new id, no restart
scripts/unarchive.py archive <id> --commit   # undo: re-hide an unwanted fork
scripts/unarchive.py restore <id> --commit   # true unarchive; DSH must be stopped
scripts/unarchive.py restore --all --commit  # bulk restore
```

`unarchive.py` writes only with `--commit`, and `restore` refuses outright while
DSH is answering, because the registry owns `workspace.json` in memory and
republishes it wholesale — a live edit is silently reverted.

Everything else is one documented `curl` per action — see `SKILL.md` for the wire
envelope, discovery, reading, and prompting, and
`references/control-actions.md` for the control surface.

`count-active-sessions.py` requires Python 3.9+. The `.mjs` scripts require Node
and resolve their `ws` dependency from the deepseek-harness checkout (`DSH_ROOT`
env overrides; defaults to `/Users/zhuoran/Programs/deepseek-harness`). No other
dependencies.

## Install

Symlinked into the central skill store:

```sh
ln -s ~/Programs/skills/deepseek-harness-thread-management-skill ~/.agents/skills/deepseek-harness-thread-management
ln -s ~/.agents/skills/deepseek-harness-thread-management ~/.claude/skills/deepseek-harness-thread-management
```

`SKILL.md` carries the agent-facing instructions.

## Layout

| File | Purpose |
|---|---|
| `SKILL.md` | Agent instructions: the API, standing rules, finding, reading, prompting, waiting |
| `references/control-actions.md` | The write surface: lifecycle, cancel, queue, slash commands, approvals, subagents |
| `references/counting.md` | The registry counting method, the three populations, the traps |
| `references/unarchive.md` | Recovering an archived thread: the two recipes and their tradeoffs |
| `references/unarchive-discussion-draft.md` | Unposted upstream Ideas discussion on the missing unarchive |
| `scripts/count-active-sessions.py` | Session counting from the workspace registry |
| `scripts/read-last-reply.py` | Read another thread's last prompt and final reply |
| `scripts/wait-for-turn-end.mjs` | Background watcher for another thread's turn end |
| `scripts/respond.mjs` | List and answer a thread's pending approvals and questions |
| `scripts/unarchive.py` | List archived threads; recover one by fork or true unarchive |
