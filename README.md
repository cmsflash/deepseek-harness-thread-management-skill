# deepseek-harness-thread-management

An agent skill for finding and counting [DeepSeek Harness](https://github.com/deepseek-ai) (DSH)
sessions by lifecycle state: active, archived, or orphaned.

DSH exposes no model-facing tool that enumerates sessions, so counting means
reading DSH's own state. The key correction this skill encodes: count from the
**workspace registry** (`$DSH_HOME/storages/workspace.json`), not from the
`$DSH_HOME/sessions/` directory. Session logs on disk outnumber active sessions
by roughly 4x, because subagent children each write a log without being filed
into a workspace.

## Usage

```sh
./count-active-sessions.py            # human-readable table
./count-active-sessions.py --json     # machine-readable
./count-active-sessions.py --dsh-home /path/to/.dsh
```

Requires Python 3.9+. No third-party dependencies.

## Install as a skill

Symlink it into the centralized skills directory:

```sh
ln -s ~/Programs/deepseek-harness-thread-management ~/.agents/skills/deepseek-harness-thread-management
```

`SKILL.md` carries the agent-facing instructions.

## Layout

| File | Purpose |
|---|---|
| `SKILL.md` | Agent instructions: the formula, the three populations, the traps |
| `count-active-sessions.py` | The counting script |
