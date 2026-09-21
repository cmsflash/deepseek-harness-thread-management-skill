import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RpcClient, RpcError, resolveOrigin } from '../scripts/rpc-client.mjs';

const { WebSocketServer } = createRequire(join(
  process.env.DSH_ROOT || '/Users/zhuoran/Programs/deepseek-harness',
  'packages/api/gateway/package.json',
))('ws');

const token = 'fixture-launch-token-do-not-disclose';
const cookie = 'dsh-auth-fixture=fixture-session-secret-do-not-disclose';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function fixture(t, { http, websocket, upgrade } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-rpc-client-test-'));
  const requests = [];
  const handshakes = [];
  const frames = [];
  const failures = [];
  const sockets = new Set();
  const wsServer = websocket ? new WebSocketServer({ noServer: true }) : undefined;
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const record = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(record);
      if (http) await http(record, response, request);
      else response.writeHead(404).end();
    } catch (error) {
      failures.push(error);
      response.destroy();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  if (upgrade) {
    server.on('upgrade', (request, socket) => {
      handshakes.push({ url: request.url, headers: request.headers });
      upgrade(request, socket);
    });
  }
  if (wsServer) {
    server.on('upgrade', (request, socket, head) => {
      handshakes.push({ url: request.url, headers: request.headers });
      wsServer.handleUpgrade(request, socket, head, (ws) => {
        ws.on('error', (error) => failures.push(error));
        ws.on('message', (data) => {
          try {
            const frame = JSON.parse(data.toString());
            frames.push(frame);
            websocket(ws, frame);
          } catch (error) {
            failures.push(error);
            ws.terminate();
          }
        });
      });
    });
  }
  let closing;
  const close = () => {
    closing ??= (async () => {
      const stopped = new Promise((resolve, reject) => {
        server.close((error) => {
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
          else resolve();
        });
      });
      for (const ws of wsServer?.clients ?? []) ws.terminate();
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await Promise.all([
        stopped,
        wsServer && new Promise((resolve) => wsServer.close(resolve)),
      ]);
    })();
    return closing;
  };
  t.after(async () => {
    try {
      await close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    assert.deepEqual(failures, [], 'the loopback fixture encountered an unexpected error');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    authFile: join(directory, 'auth.json'),
    directory,
    requests,
    handshakes,
    frames,
    server,
    wsServer,
    close,
  };
}

function clientFor(env, options = {}) {
  return new RpcClient({ baseUrl: env.origin, authFile: env.authFile, timeoutMs: 1_000, ...options });
}

function issueCookie(response, { status = 303, location = '/', cookies = [
  `${cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600`,
] } = {}) {
  response.writeHead(status, { location, 'set-cookie': cookies }).end();
}

function json(response, envelope, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(envelope));
}

async function authenticated(t, options = {}) {
  const env = await fixture(t, {
    ...options,
    http(request, response, rawRequest) {
      if (request.method === 'GET' && request.url === `/?token=${token}`) issueCookie(response);
      else if (options.http) return options.http(request, response, rawRequest);
      else json(response, { result: { ok: true, value: 'fixture-result' } });
    },
  });
  const client = clientFor(env);
  await client.login(`${env.origin}/?token=${token}`);
  env.requests.length = 0;
  return { ...env, client };
}

function assertNoSecrets(value, secrets = [token, cookie, cookie.split('=')[1]]) {
  const text = String(value);
  for (const secret of secrets) assert.ok(!text.includes(secret), `exposed fixture secret: ${secret}`);
}

function errorCode(code, status) {
  return (error) => {
    assert.ok(error instanceof RpcError, `expected RpcError, received ${error}`);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    assertNoSecrets(`${error}\n${JSON.stringify(error)}`);
    return true;
  };
}

async function cachedAuth(env) {
  return JSON.parse(await readFile(env.authFile, 'utf8'));
}

test('resolveOrigin accepts clean loopback HTTP(S) origins only', () => {
  for (const [input, expected] of [
    ['http://127.0.0.1:43210/', 'http://127.0.0.1:43210'],
    ['https://localhost:443/', 'https://localhost'],
    ['http://[::1]:43210/', 'http://[::1]:43210'],
  ]) assert.equal(resolveOrigin(input), expected);

  for (const input of [
    'not a URL', 'https://example.invalid/', 'http://0.0.0.0:43210/',
    'file:///tmp/auth.json', 'ws://localhost:43210/',
    'http://user:password@localhost:43210/', 'http://localhost:43210/api/',
    `http://localhost:43210/?token=${token}`, 'http://localhost:43210/#fragment',
  ]) assert.throws(() => resolveOrigin(input), errorCode('BAD_URL'));
});

test('a launch URL exchanges a token once for a private, reusable cookie cache', { timeout: 5_000 }, async (t) => {
  const env = await fixture(t, { http: (_request, response) => issueCookie(response) });
  const client = clientFor(env);
  const before = Date.now();
  const metadata = await client.login(`${env.origin}/?token=${token}`);
  const after = Date.now();

  assert.deepEqual(env.requests.map(({ method, url }) => ({ method, url })), [
    { method: 'GET', url: `/?token=${token}` },
  ]);
  assert.equal(env.requests[0].headers.cookie, undefined);
  assert.deepEqual(Object.keys(metadata).sort(), ['authFile', 'expiresAt', 'origin']);
  assert.equal(metadata.origin, env.origin);
  assert.equal(metadata.authFile, env.authFile);
  assertNoSecrets(JSON.stringify(metadata));
  assert.ok(metadata.expiresAt >= before + 3_600_000 && metadata.expiresAt <= after + 3_600_000);
  assert.deepEqual(await cachedAuth(env), {
    version: 1, origin: env.origin, cookie, expiresAt: metadata.expiresAt,
  });
  assert.equal((await stat(env.authFile)).mode & 0o777, 0o600);
  assert.equal((await stat(env.directory)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(env.directory), ['auth.json']);
});

test('authenticated RPC uses named args and a distinct UUID for every request', { timeout: 5_000 }, async (t) => {
  const env = await authenticated(t, {
    http(request, response) {
      json(response, { result: { ok: true, value: JSON.parse(request.body).payload.args } });
    },
  });
  const client = clientFor(env);
  const calls = [
    ['session/list', { workspacePath: '/fixture/workspace', includeArchived: false }],
    ['session/history', { sessionId: 'fixture-session', limit: 2 }],
    ['session/list', undefined],
  ];
  for (const [endpoint, args] of calls) assert.deepEqual(await client.request(endpoint, args), args ?? {});

  assert.equal(env.requests.length, calls.length);
  const ids = new Set();
  for (let i = 0; i < calls.length; i++) {
    const request = env.requests[i];
    const [endpoint, args] = calls[i];
    const envelope = JSON.parse(request.body);
    assert.equal(request.method, 'POST');
    assert.equal(request.url, `/api/${endpoint}`);
    assert.equal(request.headers.cookie, cookie);
    assert.match(request.headers['content-type'], /^application\/json/u);
    assert.match(envelope.rpcId, uuid);
    ids.add(envelope.rpcId);
    assert.deepEqual(envelope, {
      type: 'client-request', rpcId: envelope.rpcId, method: endpoint, payload: { args: args ?? {} },
    });
    assertNoSecrets(request.body);
  }
  assert.equal(ids.size, calls.length);
  assert.equal(client.redact(cookie.split('=')[1]), '[REDACTED]');
});

test('missing auth and legacy endpoints fail before network access', { timeout: 5_000 }, async (t) => {
  const env = await fixture(t);
  const client = clientFor(env);
  await assert.rejects(client.request('session/list'), errorCode('AUTH_REQUIRED'));
  await assert.rejects(client.streamUntil('$events', {}, () => true), errorCode('AUTH_REQUIRED'));
  for (const endpoint of ['session.list', '/session/list', 'session/../list', 'session/list?token=x']) {
    await assert.rejects(client.request(endpoint), errorCode('BAD_ENDPOINT'));
  }
  for (const timeoutMs of [0, -1, NaN, Infinity]) {
    assert.throws(() => clientFor(env, { timeoutMs }), errorCode('BAD_TIMEOUT'));
    await assert.rejects(client.streamUntil('$events', {}, () => true, { timeoutMs }), errorCode('BAD_TIMEOUT'));
  }
  assert.deepEqual(env.requests, []);
  assert.deepEqual(env.handshakes, []);
});

test('unsafe, expired, and malformed caches are never used for HTTP or WS', { timeout: 10_000 }, async (t) => {
  const cases = [
    { name: 'expired', code: 'AUTH_REQUIRED', change: (record) => ({ ...record, expiresAt: Date.now() - 1 }) },
    { name: 'wrong origin', code: 'BAD_CACHE', change: (record) => ({ ...record, origin: 'http://127.0.0.1:1' }) },
    { name: 'wrong version', code: 'BAD_CACHE', change: (record) => ({ ...record, version: 2 }) },
    { name: 'invalid cookie', code: 'BAD_CACHE', change: (record) => ({ ...record, cookie: 'other=secret' }) },
    { name: 'fractional expiry', code: 'BAD_CACHE', change: (record) => ({ ...record, expiresAt: Date.now() + 0.5 }) },
    { name: 'non-JSON', code: 'BAD_CACHE', raw: '{' },
    { name: 'null', code: 'BAD_CACHE', raw: 'null' },
    { name: 'over byte limit', code: 'UNSAFE_FILE', raw: 'x'.repeat(1024 * 1024 + 1) },
    { name: 'group-readable', code: 'UNSAFE_FILE', mode: 0o640 },
    { name: 'world-readable', code: 'UNSAFE_FILE', mode: 0o644 },
    { name: 'symlink', code: 'UNSAFE_FILE', link: true },
  ];
  for (const item of cases) await t.test(item.name, async (t) => {
    const env = await authenticated(t);
    const record = await cachedAuth(env);
    if (item.change || item.raw) {
      await writeFile(env.authFile, item.raw ?? JSON.stringify(item.change(record)));
    }
    if (item.mode) await chmod(env.authFile, item.mode);
    if (item.link) {
      const target = join(env.directory, 'auth-target.json');
      await writeFile(target, JSON.stringify(record), { mode: 0o600 });
      await rm(env.authFile);
      await symlink(target, env.authFile);
    }
    const client = clientFor(env);
    await assert.rejects(client.request('session/list'), errorCode(item.code));
    await assert.rejects(client.streamUntil('$events', {}, () => true), errorCode(item.code));
    assert.deepEqual(env.requests, []);
    assert.deepEqual(env.handshakes, []);
  });
});

test('a cache cannot authenticate or be overwritten by a different origin', { timeout: 5_000 }, async (t) => {
  const first = await authenticated(t);
  const second = await fixture(t, { http: (_request, response) => issueCookie(response) });
  const original = await readFile(first.authFile, 'utf8');
  const client = clientFor(second, { authFile: first.authFile });
  await assert.rejects(client.request('session/list'), errorCode('BAD_CACHE'));
  assert.deepEqual(second.requests, []);
  await assert.rejects(client.login(`${second.origin}/?token=${token}`), errorCode('BAD_CACHE'));
  assert.equal(await readFile(first.authFile, 'utf8'), original);
  assert.deepEqual(first.requests, []);
});

test('login refreshes an expired cache without loosening its permissions', { timeout: 5_000 }, async (t) => {
  const env = await authenticated(t);
  await writeFile(env.authFile, JSON.stringify({ ...await cachedAuth(env), expiresAt: Date.now() - 1 }));
  const result = await env.client.login(`${env.origin}/?token=${token}`);
  assert.ok(result.expiresAt > Date.now());
  assert.equal((await stat(env.authFile)).mode & 0o777, 0o600);
  assertNoSecrets(JSON.stringify(result));
});

test('login refuses permissive and symlinked cache destinations', { timeout: 5_000 }, async (t) => {
  for (const kind of ['directory mode', 'directory symlink', 'file mode', 'file symlink']) {
    await t.test(kind, async (t) => {
      const env = await authenticated(t);
      const original = await readFile(env.authFile, 'utf8');
      let authFile = env.authFile;
      if (kind === 'directory mode') await chmod(env.directory, 0o755);
      if (kind === 'directory symlink') {
        await symlink(env.directory, join(env.directory, 'alias'));
        authFile = join(env.directory, 'alias', 'auth.json');
      }
      if (kind === 'file mode') await chmod(env.authFile, 0o644);
      if (kind === 'file symlink') {
        const target = join(env.directory, 'auth-target.json');
        await writeFile(target, original, { mode: 0o600 });
        await rm(env.authFile);
        await symlink(target, env.authFile);
      }
      await assert.rejects(clientFor(env, { authFile }).login(`${env.origin}/?token=${token}`), errorCode('UNSAFE_FILE'));
      assert.equal(await readFile(env.authFile, 'utf8'), original);
    });
  }
});

test('launch URLs must match the configured origin and contain exactly one token', { timeout: 5_000 }, async (t) => {
  const env = await fixture(t);
  const foreign = await fixture(t);
  const client = clientFor(env);
  for (const input of [
    `${foreign.origin}/?token=${token}`, `${env.origin}/`,
    `${env.origin}/?token=`, `${env.origin}/?token=${token}&token=second`,
    `${env.origin}/?token=${token}&other=value`,
  ]) await assert.rejects(client.login(input), errorCode('BAD_LAUNCH_URL'));
  for (const input of [`${env.origin}/nested?token=${token}`, `${env.origin}/?token=${token}#fragment`]) {
    await assert.rejects(client.login(input), errorCode('BAD_URL'));
  }
  assert.deepEqual(env.requests, []);
  assert.deepEqual(foreign.requests, []);
});

test('direct login enforces its byte limit and rejects non-text before network access', { timeout: 5_000 }, async (t) => {
  const env = await fixture(t, { http: (_request, response) => issueCookie(response) });
  const client = clientFor(env);
  const launch = `${env.origin}/?token=${token}`;
  const boundary = launch + ' '.repeat(1024 * 1024 - Buffer.byteLength(launch));
  for (const input of [boundary + ' ', 'é'.repeat(1024 * 512) + 'x', undefined, null, 42, {}, Buffer.from(launch)]) {
    await assert.rejects(client.login(input), errorCode('BAD_LAUNCH_URL'));
  }
  assert.deepEqual(env.requests, []);
  assertNoSecrets(JSON.stringify(await client.login(boundary)));
  assert.equal(env.requests.length, 1);
  assert.equal(env.requests[0].url, `/?token=${token}`);
});

test('login rejects foreign redirects without visiting their destination', { timeout: 5_000 }, async (t) => {
  const foreign = await fixture(t);
  const env = await fixture(t, {
    http: (_request, response) => issueCookie(response, { location: `${foreign.origin}/?token=${token}` }),
  });
  await assert.rejects(clientFor(env).login(`${env.origin}/?token=${token}`), errorCode('LOGIN_REJECTED', 303));
  assert.equal(env.requests.length, 1);
  assert.deepEqual(foreign.requests, []);
  await assert.rejects(stat(env.authFile), { code: 'ENOENT' });
});

test('only a 303 with one usable expiring DSH cookie completes login', { timeout: 10_000 }, async (t) => {
  const cases = [
    ...[200, 302, 307, 401, 403].map((status) => ({ name: `HTTP ${status}`, status, expectedStatus: status })),
    { name: 'no cookie', cookies: [], expectedStatus: 303 },
    { name: 'unrelated cookie', cookies: ['other=secret; Max-Age=3600'], expectedStatus: 303 },
    { name: 'multiple cookies', cookies: [`${cookie}; Max-Age=3600`, 'other=secret'], expectedStatus: 303 },
    { name: 'missing expiry', cookies: [cookie] },
    { name: 'expired cookie', cookies: [`${cookie}; Max-Age=0`] },
    { name: 'unsafe expiry', cookies: [`${cookie}; Max-Age=99999999999999999999`] },
    { name: 'nested redirect', location: '/nested', expectedStatus: 303 },
  ];
  for (const item of cases) await t.test(item.name, async (t) => {
    const env = await fixture(t, { http: (_request, response) => issueCookie(response, item) });
    await assert.rejects(clientFor(env).login(`${env.origin}/?token=${token}`), errorCode('LOGIN_REJECTED', item.expectedStatus));
    assert.equal(env.requests.length, 1);
    await assert.rejects(stat(env.authFile), { code: 'ENOENT' });
  });
});

test('loginFromFile reads a launch URL, including input exactly at the byte limit', { timeout: 5_000 }, async (t) => {
  const env = await fixture(t, { http: (_request, response) => issueCookie(response) });
  const path = join(env.directory, 'launch.txt');
  const launch = `${env.origin}/?token=${token}\n`;
  await writeFile(path, launch + ' '.repeat(1024 * 1024 - Buffer.byteLength(launch)));
  const metadata = await clientFor(env).loginFromFile(path);
  assertNoSecrets(JSON.stringify(metadata));
  assert.equal(env.requests[0].url, `/?token=${token}`);
});

test('loginFromLog selects only the last matching startup URL for this origin', { timeout: 5_000 }, async (t) => {
  const env = await fixture(t, { http: (_request, response) => issueCookie(response) });
  const foreign = await fixture(t);
  const path = join(env.directory, 'startup.log');
  await writeFile(path, [
    `dsh web: ${env.origin}/?token=old-fixture-token`,
    `not a startup line: ${env.origin}/?token=ignored-fixture-token`,
    `dsh web: ${env.origin}/?token=${token}`,
    `dsh web: ${foreign.origin}/?token=foreign-fixture-token`,
    `dsh web: ${env.origin}/?token=invalid-fixture-token&other=value`,
    '',
  ].join('\n'));
  const client = clientFor(env);
  const metadata = await client.loginFromLog(path);
  assert.equal(env.requests.length, 1);
  assert.equal(env.requests[0].url, `/?token=${token}`);
  assert.deepEqual(foreign.requests, []);
  assertNoSecrets(JSON.stringify(metadata));
  assert.equal(client.redact('old-fixture-token'), '[REDACTED]');
});

test('auth input files reject over-limit bytes and symlinks without network access', { timeout: 5_000 }, async (t) => {
  for (const method of ['loginFromFile', 'loginFromLog']) await t.test(method, async (t) => {
    const env = await fixture(t);
    const path = join(env.directory, 'input.txt');
    await writeFile(path, 'é'.repeat(1024 * 512) + 'x');
    const client = clientFor(env);
    await assert.rejects(client[method](path), errorCode('UNSAFE_FILE'));
    const link = join(env.directory, 'link.txt');
    await writeFile(path, `dsh web: ${env.origin}/?token=${token}\n`);
    await symlink(path, link);
    await assert.rejects(client[method](link), errorCode('UNSAFE_FILE'));
    assert.deepEqual(env.requests, []);
  });
});

test('a log without a matching startup URL fails without disclosing its tokens', { timeout: 5_000 }, async (t) => {
  const env = await fixture(t);
  const path = join(env.directory, 'startup.log');
  await writeFile(path, `not a startup line: ${env.origin}/?token=${token}\n`);
  await assert.rejects(clientFor(env).loginFromLog(path), errorCode('NO_LAUNCH_URL'));
  assert.deepEqual(env.requests, []);
});

test('HTTP failures do not retry a write or disclose server response bodies', { timeout: 5_000 }, async (t) => {
  for (const status of [401, 403, 500, 503]) await t.test(`HTTP ${status}`, async (t) => {
    const env = await authenticated(t, {
      http: (_request, response) => response.writeHead(status).end(`${token} ${cookie}`),
    });
    await assert.rejects(env.client.request('session/prompt', { sessionId: 'fixture-session', message: 'once' }),
      errorCode(status === 401 ? 'AUTH_REQUIRED' : 'HTTP_ERROR', status));
    assert.equal(env.requests.length, 1);
  });
});

test('an ambiguous write delivery is attempted once, never retried', { timeout: 5_000 }, async (t) => {
  const env = await authenticated(t, { http: (_request, _response, rawRequest) => rawRequest.socket.destroy() });
  await assert.rejects(env.client.request('session/prompt', { sessionId: 'fixture-session', message: 'once' }),
    (error) => {
      errorCode('CONNECTION_FAILED')(error);
      assert.match(error.message, /outcome may be unknown/u);
      assert.match(error.message, /No retry/u);
      return true;
    });
  assert.equal(env.requests.length, 1);
});

test('RPC application errors preserve their code and redact active credentials', { timeout: 5_000 }, async (t) => {
  const env = await authenticated(t, {
    http: (_request, response) => json(response, {
      result: { ok: false, error: { code: 'FIXTURE_FAILURE', message: `Denied ${token}; ${cookie}; ${cookie.split('=')[1]}` } },
    }),
  });
  await assert.rejects(env.client.request('session/prompt', { message: 'once' }), (error) => {
    errorCode('FIXTURE_FAILURE')(error);
    assert.match(error.message, /^Denied \[REDACTED\]/u);
    return true;
  });
  assert.equal(env.requests.length, 1);
});

test('malformed RPC receipts fail with a typed error and never retry', { timeout: 5_000 }, async (t) => {
  for (const body of ['{', 'null', '[]', '{}', '{"result":null}', '{"result":{"ok":"true"}}']) {
    await t.test(body, async (t) => {
      const env = await authenticated(t, { http: (_request, response) => response.end(body) });
      await assert.rejects(env.client.request('session/prompt', { message: 'once' }), errorCode('BAD_RESPONSE'));
      assert.equal(env.requests.length, 1);
    });
  }
});

test('WebSocket sends the cookie and named-args mux frame, filtering unrelated streams', { timeout: 5_000 }, async (t) => {
  const start = { type: 'turn/start', sessionId: 'fixture-session' };
  const end = { type: 'turn/end', sessionId: 'fixture-session' };
  let closed;
  const env = await authenticated(t, {
    websocket(ws, frame) {
      closed = once(ws, 'close');
      for (const value of [
        { type: 'error', streamId: 'another-stream', error: { code: 'UNRELATED' } },
        { type: 'end', streamId: 'another-stream' },
        { type: 'item', streamId: 'another-stream', value: end },
        { type: 'opened', streamId: frame.streamId },
        { type: 'item', streamId: frame.streamId, value: start },
        { type: 'item', streamId: frame.streamId, value: end },
      ]) ws.send(JSON.stringify(value));
    },
  });
  const seen = [];
  const args = { sessionId: 'fixture-session' };
  assert.deepEqual(await env.client.streamUntil('$events', args, (item) => {
    seen.push(item);
    return item.type === 'turn/end';
  }), end);
  assert.deepEqual(seen, [start, end]);
  assert.equal(env.handshakes.length, 1);
  assert.equal(env.handshakes[0].url, '/api/remote.mux');
  assert.equal(env.handshakes[0].headers.cookie, cookie);
  assert.equal(env.frames.length, 1);
  assert.match(env.frames[0].streamId, uuid);
  assert.deepEqual(env.frames[0], { type: 'open', streamId: env.frames[0].streamId, endpoint: '$events', payload: { args } });
  assertNoSecrets(JSON.stringify(env.frames));
  await closed;
  assert.equal(env.wsServer.clients.size, 0);
});

test('WebSocket error, end, bad-frame, and close paths reject and close their socket', { timeout: 10_000 }, async (t) => {
  const cases = [
    { name: 'Remote error', code: 'FIXTURE_STREAM_ERROR', send: (ws, frame) => ws.send(JSON.stringify({
      type: 'error', streamId: frame.streamId,
      error: { code: 'FIXTURE_STREAM_ERROR', message: `${token} ${cookie}` },
    })) },
    { name: 'end', code: 'STREAM_ENDED', send: (ws, frame) => ws.send(JSON.stringify({ type: 'end', streamId: frame.streamId })) },
    { name: 'invalid JSON', code: 'BAD_FRAME', send: (ws) => ws.send('{') },
    { name: 'null frame', code: 'BAD_FRAME', send: (ws) => ws.send('null') },
    { name: 'socket closed', code: 'STREAM_ENDED', send: (ws) => ws.close() },
    { name: 'consumer error', code: 'BAD_FRAME', consumerError: true, send: (ws, frame) => ws.send(JSON.stringify({
      type: 'item', streamId: frame.streamId, value: 'fixture-value',
    })) },
  ];
  for (const item of cases) await t.test(item.name, async (t) => {
    let closed;
    const env = await authenticated(t, {
      websocket(ws, frame) {
        closed = once(ws, 'close');
        item.send(ws, frame);
      },
    });
    await assert.rejects(env.client.streamUntil('$events', {}, () => {
      if (item.consumerError) throw new Error(token);
      return false;
    }), errorCode(item.code));
    assert.equal(env.handshakes.length, 1);
    assert.equal(env.frames.length, 1);
    await closed;
    assert.equal(env.wsServer.clients.size, 0);
  });
});

test('WebSocket timeout overrides the client deadline and closes the stream without retry', { timeout: 5_000 }, async (t) => {
  let closed;
  const env = await authenticated(t, {
    websocket(ws, frame) {
      closed = once(ws, 'close');
      ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { accepted: false } }));
    },
  });
  await assert.rejects(env.client.streamUntil('$events', {}, (item) => item.accepted, { timeoutMs: 100 }), errorCode('TIMEOUT'));
  assert.equal(env.frames.length, 1);
  await closed;
  assert.equal(env.wsServer.clients.size, 0);
});

test('WebSocket auth failures retain HTTP status and are not retried', { timeout: 5_000 }, async (t) => {
  for (const status of [401, 403]) await t.test(`HTTP ${status}`, async (t) => {
    const env = await authenticated(t, {
      upgrade(_request, socket) {
        socket.end(`HTTP/1.1 ${status} Rejected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      },
    });
    await assert.rejects(env.client.streamUntil('$events', {}, () => true),
      errorCode(status === 401 ? 'AUTH_REQUIRED' : 'HTTP_ERROR', status));
    assert.equal(env.handshakes.length, 1);
    assert.equal(env.handshakes[0].headers.cookie, cookie);
  });
});

test('a missing ws dependency fails with a typed error before opening a connection', { timeout: 5_000 }, async (t) => {
  const env = await authenticated(t);
  const previous = process.env.DSH_ROOT;
  try {
    process.env.DSH_ROOT = join(env.directory, 'missing-checkout');
    await assert.rejects(env.client.streamUntil('$events', {}, () => true), errorCode('WS_UNAVAILABLE'));
  } finally {
    if (previous === undefined) delete process.env.DSH_ROOT;
    else process.env.DSH_ROOT = previous;
  }
  assert.deepEqual(env.requests, []);
  assert.deepEqual(env.handshakes, []);
});

test('WebSocket redirects never forward cookies to another origin', { timeout: 5_000 }, async (t) => {
  const foreign = await fixture(t);
  const env = await authenticated(t, {
    upgrade(_request, socket) {
      socket.end(`HTTP/1.1 302 Found\r\nLocation: ${foreign.origin}/api/remote.mux\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    },
  });
  await assert.rejects(env.client.streamUntil('$events', {}, () => true), errorCode('HTTP_ERROR', 302));
  assert.equal(env.handshakes.length, 1);
  assert.deepEqual(foreign.requests, []);
  assert.deepEqual(foreign.handshakes, []);
});

test('probe treats every HTTP status, including 401 and 403, as a live server', { timeout: 5_000 }, async (t) => {
  for (const status of [200, 302, 401, 403, 404, 500, 503]) await t.test(`HTTP ${status}`, async (t) => {
    const env = await fixture(t, { http: (_request, response) => response.writeHead(status).end() });
    await writeFile(env.authFile, '{invalid cache', { mode: 0o644 });
    assert.equal(await clientFor(env).probe(), true);
    assert.equal(env.requests.length, 1);
    assert.equal(env.requests[0].method, 'HEAD');
    assert.equal(env.requests[0].url, '/');
    assert.equal(env.requests[0].headers.cookie, undefined);
  });
});

test('probe returns false only for a refused connection', { timeout: 5_000 }, async (t) => {
  const env = await fixture(t);
  await env.close();
  assert.equal(await clientFor(env).probe(), false);
});

test('reset and timed-out probes remain uncertain rather than claiming the host stopped', { timeout: 5_000 }, async (t) => {
  for (const reset of [true, false]) await t.test(reset ? 'reset' : 'timeout', async (t) => {
    const env = await fixture(t, {
      http(_request, _response, rawRequest) {
        if (reset) rawRequest.socket.destroy();
      },
    });
    await assert.rejects(clientFor(env, { timeoutMs: 100 }).probe(), errorCode('PROBE_UNCERTAIN'));
    assert.equal(env.requests.length, 1);
  });
});

test('redact removes launch URLs, active cookie values, and token query parameters', { timeout: 5_000 }, async (t) => {
  const env = await authenticated(t);
  const text = [
    'context', `${env.origin}/?token=${token}`, token, cookie, cookie.split('=')[1],
    '?token=unseen-fixture-secret&keep=yes', '&token=second-fixture-secret#fragment', 'tail',
  ].join(' ');
  const redacted = env.client.redact(text);
  assertNoSecrets(redacted);
  assertNoSecrets(redacted, ['unseen-fixture-secret', 'second-fixture-secret']);
  assert.match(redacted, /^context /u);
  assert.match(redacted, /\?token=\[REDACTED\]&keep=yes/u);
  assert.match(redacted, /&token=\[REDACTED\]#fragment tail$/u);
  assert.equal(env.client.redact(42), '42');
});
