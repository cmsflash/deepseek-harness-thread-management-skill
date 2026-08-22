# deepseek-harness-thread-management

An agent skill for finding, counting, and waiting on [DeepSeek Harness](https://github.com/deepseek-ai) (DSH)
sessions by lifecycle state: active, archived, or orphaned.

DSH exposes no model-facing tool that enumerates sessions or notifies an agent
about sibling threads, so both capabilities come from reading DSH's own state
and event stream:

- **Counting** reads the workspace registry
  (`$DSH_HOME/storages/workspace.json`), not the `$DSH_HOME/sessions/`
  directory — session logs on disk outnumber active sessions by roughly 4x,
  because subagent children each write a log without being filed into a
  workspace.
- **Waiting** watches the GUI's own WebSocket event stream (`/api/events.mux`)
  for a target session's `turn/end`, run as a background job so job settlement
  becomes the agent's notification. No polling.

## Usage

```sh
./count-active-sessions.py            # human-readable table
./count-active-sessions.py --json     # machine-readable
./count-active-sessions.py --dsh-home /path/to/.dsh

./wait-for-turn-end.mjs --session session-xxxx [--timeout-min 30]
```

`count-active-sessions.py` requires Python 3.9+. `wait-for-turn-end.mjs`
requires Node and resolves its `ws` dependency from the deepseek-harness
checkout (`DSH_ROOT` env overrides; defaults to
`/Users/zhuoran/Programs/deepseek-harness`). No other dependencies.

## Install as a skill

Symlink it into the centralized skills directory:

```sh
ln -s ~/Programs/deepseek-harness-thread-management ~/.agents/skills/deepseek-harness-thread-management
```

`SKILL.md` carries the agent-facing instructions.

## Layout

| File | Purpose |
|---|---|
| `SKILL.md` | Agent instructions: counting, waiting, the traps |
| `count-active-sessions.py` | Session counting from the workspace registry |
| `wait-for-turn-end.mjs` | Background watcher for another thread's turn end |
