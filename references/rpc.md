# Authenticated local RPC

The current Web Host authenticates every RPC and Remote stream. Use the normal launch-token exchange; neither loopback access nor a forged Host header grants authority. Do not read the signing secret, synthesize cookies, extract browser credentials, disable authentication, or restart the user's server to recover access.

## Login once

Use only a startup URL or captured launch output that the operator authorizes for this server. The login command reads it into memory, exchanges it with `GET /?token=...`, and saves the cookie issued by the server. It does not print tokens, cookies, or Set-Cookie headers. Inputs are bounded to 1 MiB; symlinks and foreign-origin startup URLs are rejected.

```sh
node scripts/rpc.mjs login --base-url http://127.0.0.1:8420 \
  --from-log /path/to/approved-captured-startup.log

# Alternative: a local file containing only the current startup URL.
node scripts/rpc.mjs login --base-url http://127.0.0.1:8420 \
  --launch-url-file /path/to/launch-url.txt
```

The log input must be the known current process's captured output, not an arbitrary diagnostic directory. The client selects the last matching `dsh web:` URL for the exact origin. A missing or rejected URL requires new operator-provided input, not a credential-store fallback.

`--base-url` wins over `DSH_WEB_URL`; the final default is `http://127.0.0.1:3080`. Only clean loopback origins are accepted. The default cache lives under `~/.cache/dsh-thread-rpc/`, separated by origin; its directory is mode 0700 and its file mode 0600. `--auth-file` or `DSH_RPC_AUTH_FILE` may select another owner-only cache in a private directory. Treat this cache as a credential: it authorizes the same complete Host API as the GUI, not just thread reads. Never publish or attach it.

A server restart can invalidate the launch URL without invalidating an existing unexpired cookie. A rejected or expired cookie requires login again. Requests are never automatically replayed, including after a timeout or authentication error.

## Current wire

Unary endpoints are slash-separated and take named arguments, not the old dotted API's direct payload:

```sh
node scripts/rpc.mjs call session/list '{"_request":{}}' \
  --base-url http://127.0.0.1:8420
```

The client posts this envelope to `/api/session/list` with its issued Cookie:

```json
{"type":"client-request","rpcId":"<fresh UUID>","method":"session/list","payload":{"args":{"_request":{}}}}
```

It returns `result.value`, or fails with the RPC error code. Use `--args-file FILE` instead of the positional JSON argument for larger requests. A lost receipt is an unknown outcome: inspect state rather than retrying a write blindly.

Remote streams use `/api/remote.mux`. Each client connection opens one logical stream with `{type:"open",streamId,endpoint,payload:{args}}`, then receives matching `item`, `error`, and `end` frames. Closing the connection cancels its stream.

```sh
node scripts/rpc.mjs stream workspace/follow '{}' \
  --base-url http://127.0.0.1:8420 --max-items 1
```

The Node module exports `RpcClient.request()` and `RpcClient.streamUntil()` for helpers that must retain a stream until a specific item arrives. It loads `ws` from the existing DSH checkout; set `DSH_ROOT` when that checkout is elsewhere. No replacement DSH instance is launched.

## Safety and verification

Every write still requires approval of the exact action and content. Authentication is not consent to prompt, cancel, rename, archive, unarchive, or answer another thread's pending question.

`rpc.mjs probe` reports any HTTP response, including 401/403, as a live server. Only a definite refused connection returns false. Timeouts and ambiguous network failures fail closed. No HTTP authentication failure is evidence that offline workspace edits are safe.

Run the client behavior tests with:

```sh
node --test tests/rpc-client.test.mjs
```

Live verification should use read-only methods on the existing authorized host. Never create scratch threads, send prompts, or answer pending interactions merely to verify the transport.
