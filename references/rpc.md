# Authenticated local RPC

The Web Host authenticates unary RPCs, downloads, and Remote streams. Use the
normal launch-token exchange through the shared client. Loopback access and a
matching Host header are not authentication. Never read signing secrets,
synthesize cookies, extract Chrome credentials, disable authentication, or
restart the user's server to recover access.

## Select the running Host

The origin selection order is explicit `--base-url`, then `DSH_WEB_URL`, then
`http://127.0.0.1:3080`. Use the operator-confirmed origin of the existing Host;
the default is not port discovery. Only clean loopback HTTP(S) root origins are
accepted, without a query, fragment, or embedded credentials.

For example, a Host serving on port 8216 needs this setting. Replace it when the
operator identifies a different origin; 8216 is not a universal default.

```sh
export DSH_WEB_URL=http://127.0.0.1:8216
```

Use Node 22.19 or newer. Set `DSH_ROOT` to an existing DSH checkout when it is
not at `/Users/zhuoran/Programs/deepseek-harness`. The shared WebSocket resolver
loads `ws` through `DSH_ROOT/packages/api/gateway/package.json`. The reply reader
loads `fflate` through `DSH_ROOT/packages/session-query/session-log-export/package.json`.
The helpers do not launch a replacement Host.

## Login with approved launch output

Use only the matching startup URL from the explicitly identified current
process's stdout, captured in a file the operator authorizes, or a URL file the
operator provides. Establish that provenance before login. Do not scan arbitrary
diagnostic directories, historical logs, or credential stores for tokens.

```sh
node scripts/rpc.mjs login --base-url "$DSH_WEB_URL" \
  --from-log /path/to/approved-current-process-stdout.log

# Alternative: a file containing only the authorized startup URL.
node scripts/rpc.mjs login --base-url "$DSH_WEB_URL" \
  --launch-url-file /path/to/approved-launch-url.txt
```

The log reader selects the last `dsh web:` URL matching the exact configured
origin. It cannot establish from the text alone that the log belongs to the
current process. Inputs are limited to 1 MiB; symlinks are rejected. A URL for a
different origin is not usable for this login.

The client makes `GET /?token=...` without following redirects and requires
`303`, `Location: /`, and a server-issued `Set-Cookie` with a usable expiry. It
caches that cookie, not a self-signed replacement. Tokens, cookies, and
`Set-Cookie` headers are not printed. Missing or rejected input requires a new
operator-approved URL, not another authentication mechanism.

## Protect the cookie cache

The default cache is `~/.cache/dsh-thread-rpc/<sha256(origin)>.json`. Its directory
is private, mode `0700`, and its file is owner-only, mode `0600`. `--auth-file` or
`DSH_RPC_AUTH_FILE` can select another owner-only cache in a private directory.
The record must match the configured origin.

The cache authorizes the same Host API as the GUI, not just thread reads. Never
publish, attach, or paste it into a message. An unexpired cookie can survive a
server restart even when the old launch URL no longer works. A rejected or
expired cookie requires a fresh approved login.

No request is automatically replayed after a timeout, authentication error, or
other failure. A lost write receipt is an unknown outcome: inspect state before
considering another explicitly authorized action.

## Unary requests

Endpoints are slash-separated. The CLI takes the method's **named arguments**;
it adds the `payload.args` wrapper and a fresh transport `rpcId`:

```sh
node scripts/rpc.mjs call session/list '{"_request":{}}'
```

The request is `POST /api/session/list` with the issued Cookie and this body:

```json
{"type":"client-request","rpcId":"<fresh transport UUID>","method":"session/list","payload":{"args":{"_request":{}}}}
```

`session/list` names its argument `_request`. Methods such as `session/page`,
`session/prompt`, `session/rename`, and `workspace/unarchiveSession` name it
`request`. Other endpoints have different named arguments; do not wrap all
methods in `request` indiscriminately.

| Endpoint | Named arguments supplied to the CLI |
|---|---|
| `session/list` | `{ "_request": {} }` |
| `session/page` | `{ "request": { "address": { "kind": "session", "sessionId": "..." }, "throughSeq": 123, "maxMessages": 8, "stepDetail": "collapsed" } }` |
| `session/prompt` | `{ "request": { "requestId": "...", "sessionId": "...", "mode": "queue", "content": [...] } }` |
| `workspace/unarchiveSession` | `{ "request": { "sessionId": "..." } }` |
| `commands/execute` | `{ "agentId": "...", "line": "...", "submittedAttachments": [] }` |
| `subagents/list` | `{ "parentSessionId": "..." }` |
| `subagents/prompt` | `{ "request": { "requestId": "...", "parentSessionId": "...", "childSessionId": "...", "mode": "continuable", "delivery": "queue", "content": [...] } }` |
| `subagents/interruptByParent` | `{ "childSessionId": "...", "parentSessionId": "...", "mode": "continuable" }` |

The page cursor `123` is illustrative; supply an exact known committed cut.
Prompt `request.requestId` is required and separate from the outer `rpcId`.
Queue and steer delivery, lifecycle writes, and pending-event results are
covered in [Control actions](control-actions.md).

The client returns `result.value` or fails with the RPC error code. The CLI
prints `null` for an absent value. For `commands/execute`, an undefined value
means the line did not resolve to a command; a successful HTTP/RPC envelope
alone is not proof of command execution. Use `--args-file FILE` instead of
positional JSON for larger inputs.

## Remote streams

Streams use an authenticated WebSocket at `/api/remote.mux`. One logical stream
opens with:

```json
{"type":"open","streamId":"<stream UUID>","endpoint":"workspace/follow","payload":{"args":{}}}
```

Matching carrier frames have type `item`, `error`, or `end`. The endpoint's
application frame is inside `item.value`. Closing the connection cancels its
stream. This is not SSE and does not use `/api/events.mux`.

```sh
node scripts/rpc.mjs stream workspace/follow '{}' --max-items 1
```

The first application frame is
`{type:"baseline",value:{items,archivedSessionIds}}`. Use `items[].sessionIds`
for workspace ownership; there is no need to guess a `workspace/list` method.
The CLI defaults to one item and uses `--timeout-ms` to bound waiting.

[RpcClient](../scripts/rpc-client.mjs) exposes `request()`, `openDownload()`, and
`streamUntil()` for helpers. `streamUntil()` passes each application frame to
its callback and keeps the connection open until that callback accepts a frame.
This lets an interaction helper submit a result while the same `$events`
connection remains alive.

## Cold-safe history

[read-last-reply.mjs](../scripts/read-last-reply.mjs) discovers the committed cut
through authenticated
`GET /api/session.export?sessionId=...&includeDescendants=false`. It consumes the
first root JSONL entry of the ZIP to get the exact sequence, title, and
interaction timestamps, then cancels the download before bulk attachments. It
requests `session/page` at that cut with `stepDetail:"collapsed"` and a bounded
message window.

Export flushes already resident logs; it does not start turns or promote cold
Agents. `session/follow` can promote a cold Agent, so do not use it across idle
threads for an audit. The waiter uses it only after `session/list` reports a
running target.

Cached projection `asOfSeq` is a possibly stale prefix, not the current end of
the log. Do not use `Number.MAX_SAFE_INTEGER` as a cursor or assume clipping.
`--through-seq N` bypasses export only when the caller has an exact known cut.
The reader bounds download size, decoded log size, and observation time; a
limit or truncated export fails rather than accepting a partial cursor.

## Safety and verification

Every write requires approval of the exact target, action, and content.
Authentication alone does not authorize prompting, cancellation, lifecycle
changes, or answers to another thread's pending interaction.

`rpc.mjs probe` treats any HTTP response, including 401 or 403, as a live server.
Only a definite refused connection returns `running:false`; ambiguous network
failures fail closed. A probe is not authentication verification and does not
authorize offline state changes.

Run the offline helper suite from the skill directory:

```sh
node --test tests/*.test.mjs
```

Keep live verification read-only on the existing authorized Host unless the
human separately approves a write. Do not create scratch threads, change
permissions, or answer pending interactions just to prove the transport works.
