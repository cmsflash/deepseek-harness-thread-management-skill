import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { RpcClient } from '../scripts/rpc-client.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const dshRoot = process.env.DSH_ROOT || '/Users/zhuoran/Programs/deepseek-harness'
const { WebSocketServer, WebSocket } = createRequire(join(dshRoot, 'packages/api/gateway/package.json'))('ws')
const sessionId = 'session-fixture-target'
const cookie = 'dsh-auth-control=fixture-control-cookie-secret'
const token = 'fixture-control-launch-token'
const ready = { type: 'ready', clientId: 'fixture-client-generation', host: { home: '/fixture/home' } }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function json(response, value) {
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result: { ok: true, value } }))
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-thread-control-test-'))
  const authFile = join(directory, 'auth.json')
  const requests = []
  const handshakes = []
  const opens = []
  const failures = []
  const sockets = new Set()
  const timers = new Set()
  const children = new Set()
  const wsServer = new WebSocketServer({ noServer: true })
  function later(delay, callback) {
    const timer = setTimeout(() => {
      timers.delete(timer)
      try { callback() } catch (error) { failures.push(error) }
    }, delay)
    timers.add(timer)
  }
  const server = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const record = { method: request.method, url: request.url, headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8') }
      requests.push(record)
      if (request.method === 'GET' && request.url === `/?token=${token}`) {
        response.writeHead(303, { location: '/', 'set-cookie': `${cookie}; HttpOnly; Path=/; Max-Age=3600` }).end()
        return
      }
      assert.equal(request.method, 'POST')
      assert.equal(request.headers.cookie, cookie)
      const envelope = JSON.parse(record.body)
      assert.equal(envelope.type, 'client-request')
      assert.match(envelope.rpcId, uuid)
      if (request.url === '/api/session/list') {
        assert.equal(envelope.method, 'session/list')
        assert.deepEqual(envelope.payload, { args: { _request: {} } })
        json(response, options.list ?? { items: [{ sessionId, running: true }] })
      } else if (request.url === '/api/$events/result') {
        assert.equal(envelope.method, '$events/result')
        if (options.result) await options.result(envelope.payload.args, response, { wsServer, later })
        else json(response, undefined)
      } else if (options.rpc) {
        await options.rpc(envelope, response)
      } else {
        throw new Error(`unexpected endpoint: ${request.url}`)
      }
    } catch (error) {
      failures.push(error)
      response.writeHead(500).end()
    }
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (request, socket, head) => {
    handshakes.push({ url: request.url, headers: request.headers })
    if (options.upgradeStatus) {
      socket.end(`HTTP/1.1 ${options.upgradeStatus} Rejected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
      return
    }
    wsServer.handleUpgrade(request, socket, head, ws => {
      ws.on('error', error => failures.push(error))
      ws.on('message', raw => {
        try {
          const frame = JSON.parse(raw.toString())
          opens.push(frame)
          assert.equal(frame.type, 'open')
          assert.match(frame.streamId, uuid)
          assert.equal(request.url, '/api/remote.mux')
          assert.equal(request.headers.cookie, cookie)
          const send = value => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value }))
          }
          const carrier = { ws, send, frame, later }
          if (frame.endpoint === 'session/follow') {
            assert.deepEqual(frame.payload, {
              args: { request: { address: { kind: 'session', sessionId }, maxMessages: 8, stepDetail: 'collapsed' } },
            })
            options.follow?.(carrier)
          } else if (frame.endpoint === '$events') {
            assert.deepEqual(frame.payload, { args: {} })
            if (options.events) options.events(carrier)
            else send(ready)
          } else if (frame.endpoint === 'workspace/follow' && options.workspace) {
            assert.deepEqual(frame.payload, { args: {} })
            send({ type: 'baseline', value: options.workspace })
          } else throw new Error(`unexpected stream: ${frame.endpoint}`)
        } catch (error) {
          failures.push(error)
          ws.terminate()
        }
      })
    })
  })
  t.after(async () => {
    for (const child of children) {
      const closed = new Promise(resolve => child.once('close', resolve))
      child.kill('SIGKILL')
      await closed
    }
    for (const timer of timers) clearTimeout(timer)
    const stopped = new Promise(resolve => server.close(resolve))
    for (const ws of wsServer.clients) ws.terminate()
    for (const socket of sockets) socket.destroy()
    server.closeAllConnections()
    try {
      await Promise.all([stopped, new Promise(resolve => wsServer.close(resolve))])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    assert.deepEqual(failures, [], 'the synthetic host observed an invalid request or fixture failure')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  if (options.authenticate !== false) {
    await new RpcClient({ baseUrl: origin, authFile, timeoutMs: 1_000 }).login(`${origin}/?token=${token}`)
    requests.length = 0
  }
  return { origin, authFile, directory, requests, opens, handshakes, wsServer, children }
}

async function run(env, script, args) {
  const child = spawn(process.execPath, [join(root, 'scripts', script), ...args,
    '--base-url', env.origin, '--auth-file', env.authFile], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: env.directory, DSH_ROOT: dshRoot,
      DSH_WEB_URL: env.origin, DSH_RPC_AUTH_FILE: env.authFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  env.children.add(child)
  let stdout = ''
  let stderr = ''
  let timedOut = false
  let spawnError
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.on('error', error => { spawnError = error })
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 5_000)
  try {
    const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
    if (spawnError) throw spawnError
    assert.equal(timedOut, false, `CLI did not settle: ${stdout}\n${stderr}`)
    assert.equal(result.signal, null, `CLI was killed: ${stdout}\n${stderr}`)
    for (const secret of [token, cookie, cookie.split('=')[1]]) assert.ok(!(stdout + stderr).includes(secret))
    return { ...result, stdout, stderr }
  } finally {
    clearTimeout(timer)
    env.children.delete(child)
  }
}

function report(result) {
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stderr, '')
  return JSON.parse(result.stdout)
}

function event(seq, type, data) {
  return { seq, type, time: 1_000 + seq, data }
}

function snapshot(events, cursor = events.at(-1)?.seq ?? -1) {
  return { type: 'snapshot', header: { id: sessionId }, cursor,
    records: events.map(item => ({ type: 'event', event: item })), hasMore: false,
    projections: { asOfSeq: cursor, values: {} } }
}

function user(seq, requestId) {
  return event(seq, 'user/message', { id: `fixture-message-${seq}`, role: 'user',
    content: [{ type: 'text', text: 'synthetic input only' }], source: { kind: 'user', rpcId: requestId } })
}

function end(seq, turn, kind = 'completed') {
  return event(seq, 'turn/end', { turn, reason: { kind } })
}

function pending(eventId, kind = 'approval/request', agentId = sessionId) {
  return { type: 'waterfall', event: kind, eventId, agentId,
    request: kind === 'approval/request' ? { toolName: 'fixture-tool', reason: 'synthetic approval' }
      : { questions: [{ id: 'choice', question: 'Synthetic choice?', options: [{ label: 'Red' }, { label: 'Blue' }] }] } }
}

const wait = (env, args = []) => run(env, 'wait-for-turn-end.mjs', ['--session', sessionId, '--timeout-min', '0.02', ...args])
const respond = (env, args = []) => run(env, 'respond.mjs', [sessionId, '--wait-seconds', '0.08', ...args])

test('waiter reports an idle target without following or prompting it', { timeout: 10_000 }, async t => {
  const env = await fixture(t, { list: { items: [{ sessionId, running: false }, { sessionId: 'other', running: true }] } })
  assert.deepEqual(report(await wait(env)), { status: 'idle', sessionId })
  assert.equal(env.requests.length, 1)
  assert.deepEqual(env.opens, [])
  assert.deepEqual(env.handshakes, [])
  assert.deepEqual(report(await wait(env, ['--request-id', 'not-verified'])), {
    status: 'idle', sessionId, requestId: 'not-verified', requestCompletionConfirmed: false,
  })
  assert.deepEqual(env.handshakes, [])
})

test('waiter refuses missing or indeterminate sessions without follow side effects', { timeout: 10_000 }, async t => {
  for (const [list, code] of [
    [{ items: [] }, 'SESSION_NOT_FOUND'], [{ items: [{ sessionId }] }, 'BAD_RESPONSE'], [{ sessions: [] }, 'BAD_RESPONSE'],
  ]) await t.test(code, async t => {
    const env = await fixture(t, { list })
    const result = await wait(env)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, new RegExp(code))
    assert.equal(result.stdout, '')
    assert.deepEqual(env.handshakes, [])
  })
})

test('waiter ignores historical and unrelated turn ends and follows only the current target turn', { timeout: 10_000 }, async t => {
  const env = await fixture(t, {
    follow({ send }) {
      send(snapshot([event(0, 'turn/start', { turn: 1 }), end(1, 1), event(2, 'turn/start', { turn: 2 })]))
      send({ type: 'event', event: end(1, 2, 'blocked') })
      send({ type: 'event', event: end(3, 1, 'blocked') })
      send({ type: 'event', event: end(4, 2) })
    },
  })
  assert.deepEqual(report(await wait(env)), {
    status: 'turn/end', sessionId, turn: 2, reason: { kind: 'completed' }, seq: 4, observed: 'live',
  })
  assert.equal(env.requests.length, 1)
  assert.equal(env.opens.length, 1)
  assert.equal(env.wsServer.clients.size, 0)
})

test('waiter can recover the turn from a tail event when turn/start is outside the snapshot', { timeout: 10_000 }, async t => {
  const env = await fixture(t, { follow({ send }) {
    send(snapshot([event(35, 'step/start', { turn: 9, step: 3 })]))
    send({ type: 'event', event: end(36, 9) })
  } })
  assert.equal(report(await wait(env)).turn, 9)
})

test('waiter notices a target that ended between list and the opening snapshot', { timeout: 10_000 }, async t => {
  const env = await fixture(t, { follow({ send }) {
    send(snapshot([event(7, 'turn/start', { turn: 4 }), end(8, 4)]))
  } })
  assert.deepEqual(report(await wait(env)), {
    status: 'turn/end', sessionId, turn: 4, reason: { kind: 'completed' }, seq: 8, observed: 'snapshot',
  })
})

test('waiter correlates an explicit request ID rather than a different running turn', { timeout: 10_000 }, async t => {
  const env = await fixture(t, { follow({ send }) {
    send(snapshot([event(0, 'turn/start', { turn: 1 }), user(1, 'other-request')]))
    send({ type: 'event', event: end(2, 1) })
    send({ type: 'event', event: event(3, 'turn/start', { turn: 2 }) })
    send({ type: 'event', event: user(4, 'requested-input') })
    send({ type: 'event', event: end(5, 2) })
  } })
  assert.deepEqual(report(await wait(env, ['--request-id', 'requested-input'])), {
    status: 'turn/end', sessionId, turn: 2, reason: { kind: 'completed' }, seq: 5, observed: 'live', requestId: 'requested-input',
  })
})

test('waiter can identify an explicitly requested completed turn in the snapshot', { timeout: 10_000 }, async t => {
  const env = await fixture(t, { follow({ send }) {
    send(snapshot([event(0, 'turn/start', { turn: 1 }), user(1, 'requested-input'), end(2, 1), event(3, 'turn/start', { turn: 2 })]))
  } })
  const result = report(await wait(env, ['--request-id', 'requested-input']))
  assert.equal(result.turn, 1)
  assert.equal(result.observed, 'snapshot')
  assert.equal(result.requestId, 'requested-input')
})

test('waiter fails explicitly when the bounded snapshot cannot identify a target turn', { timeout: 10_000 }, async t => {
  for (const requestId of [undefined, 'unscoped-request']) await t.test(requestId ?? 'current turn', async t => {
    const env = await fixture(t, { follow({ send }) {
      send(snapshot(requestId ? [user(0, requestId)] : []))
      send({ type: 'event', event: end(1, 9) })
    } })
    const result = await wait(env, requestId ? ['--request-id', requestId] : [])
    assert.equal(result.code, 3)
    assert.match(result.stderr, /TURN_UNIDENTIFIED/u)
    assert.equal(result.stdout, '')
  })
})

test('waiter does not claim completion on timeout or a prematurely closed follow stream', { timeout: 10_000 }, async t => {
  for (const close of [false, true]) await t.test(close ? 'stream close' : 'timeout', async t => {
    const env = await fixture(t, { follow({ send, ws, later }) {
      send(snapshot([event(0, 'turn/start', { turn: 1 })]))
      if (close) later(20, () => ws.close())
    } })
    const result = await wait(env, ['--timeout-min', '0.004'])
    assert.equal(result.code, close ? 4 : 2)
    assert.match(result.stderr, close ? /STREAM_ENDED/u : /TIMEOUT/u)
    assert.equal(result.stdout, '')
    assert.equal(env.wsServer.clients.size, 0)
    assert.equal(env.requests.length, 1)
  })
})

test('waiter rejects malformed snapshots instead of inferring a turn', { timeout: 10_000 }, async t => {
  for (const frame of [
    { type: 'event', event: end(0, 1) },
    { type: 'snapshot', cursor: '0', records: [] },
    { ...snapshot([event(0, 'turn/start', { turn: 1 })]), header: { id: 'another-session' } },
  ]) await t.test(JSON.stringify(frame), async t => {
    const env = await fixture(t, { follow: ({ send }) => send(frame) })
    const result = await wait(env)
    assert.equal(result.code, 3)
    assert.match(result.stderr, /BAD_FRAME/u)
  })
})

test('responder lists a post-ready observation window, filtering sessions and cancellations', { timeout: 10_000 }, async t => {
  const keep = pending('keep-question', 'user-questions/request')
  const env = await fixture(t, { events({ send, later }) {
    later(120, () => {
      send(ready)
      send(pending('cancel-approval'))
      send(pending('another-session-event', 'approval/request', 'session-other'))
      send({ type: 'cancel', eventId: 'cancel-approval' })
      send({ type: 'emit', event: 'unrelated-notification', args: [] })
      later(20, () => send(keep))
    })
  } })
  assert.deepEqual(report(await respond(env)), {
    status: 'observation-window', sessionId, observationMs: 80, complete: false,
    pending: [{ eventId: keep.eventId, event: keep.event, request: keep.request }],
  })
  assert.deepEqual(env.requests, [])
  assert.equal(env.opens.length, 1)
  assert.equal(env.wsServer.clients.size, 0)
})

test('an empty responder window makes no exhaustive absence claim and sends no next result', { timeout: 10_000 }, async t => {
  const env = await fixture(t)
  assert.deepEqual(report(await respond(env)), {
    status: 'observation-window', sessionId, observationMs: 80, complete: false, pending: [],
  })
  assert.deepEqual(env.requests, [])
})

test('responder submits only the selected approval and keeps its generation live through HTTP receipt', { timeout: 10_000 }, async t => {
  const submitted = []
  const env = await fixture(t, {
    events({ send }) {
      send(ready)
      send(pending('not-selected'))
      send(pending('selected-event'))
      send(pending('selected-event'))
    },
    result(args, response, { wsServer, later }) {
      submitted.push(args)
      assert.equal([...wsServer.clients].filter(ws => ws.readyState === WebSocket.OPEN).length, 1)
      later(150, () => {
        assert.equal([...wsServer.clients].filter(ws => ws.readyState === WebSocket.OPEN).length, 1)
        json(response, undefined)
      })
    },
  })
  assert.deepEqual(report(await respond(env, ['--approve', 'selected-event'])), {
    status: 'submitted', confirmation: 'unconfirmed', sessionId, eventId: 'selected-event', event: 'approval/request',
  })
  assert.deepEqual(submitted, [{
    clientId: ready.clientId, eventId: 'selected-event', outcome: { kind: 'result', value: 'allowed-once' },
  }])
  assert.equal(env.requests.length, 1)
  assert.equal(env.wsServer.clients.size, 0)
})

test('responder preserves an explicit rejection instead of defaulting to approval', { timeout: 10_000 }, async t => {
  const env = await fixture(t, { events({ send }) { send(ready); send(pending('selected-event')) } })
  const result = report(await respond(env, ['--approve', 'selected-event', 'rejected']))
  assert.equal(result.confirmation, 'unconfirmed')
  assert.equal(JSON.parse(env.requests[0].body).payload.args.outcome.value, 'rejected')
})

test('responder sends explicit answers for the selected event, never the first observed question', { timeout: 10_000 }, async t => {
  const env = await fixture(t, { events({ send }) {
    send(ready)
    send(pending('first-question', 'user-questions/request'))
    send(pending('selected-question', 'user-questions/request'))
  } })
  const answers = [{ id: 'choice', selected: ['Blue'], custom: 'Human-supplied detail' }]
  const result = report(await respond(env, ['--answer', JSON.stringify(answers), '--event-id', 'selected-question']))
  assert.equal(result.eventId, 'selected-question')
  assert.equal(result.status, 'submitted')
  assert.equal(result.confirmation, 'unconfirmed')
  assert.deepEqual(JSON.parse(env.requests[0].body).payload.args, {
    clientId: ready.clientId, eventId: 'selected-question', outcome: { kind: 'result', value: { answers } },
  })
  assert.equal(env.requests.length, 1)
})

test('responder never submits an unobserved ID or an event belonging to another session', { timeout: 10_000 }, async t => {
  for (const otherSession of [false, true]) await t.test(otherSession ? 'wrong session' : 'stale event', async t => {
    const env = await fixture(t, { events({ send }) {
      send(ready)
      if (otherSession) send(pending('selected-event', 'approval/request', 'session-other'))
      else send({ type: 'cancel', eventId: 'selected-event' })
      send(pending('unselected-event'))
    } })
    const result = await respond(env, ['--approve', 'selected-event'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /EVENT_NOT_OBSERVED/u)
    assert.deepEqual(env.requests, [])
  })
})

test('responder refuses a mismatched event type or question IDs without writing', { timeout: 10_000 }, async t => {
  const env = await fixture(t, { events({ send }) { send(ready); send(pending('selected-event', 'user-questions/request')) } })
  const wrongType = await respond(env, ['--approve', 'selected-event'])
  assert.match(wrongType.stderr, /BAD_TARGET/u)
  assert.notEqual(wrongType.code, 0)
  const wrongAnswers = await respond(env, ['--answer', '[{"id":"different","selected":["Blue"]}]', '--event-id', 'selected-event'])
  assert.equal(wrongAnswers.code, 5)
  assert.match(wrongAnswers.stderr, /BAD_ARGUMENTS/u)
  assert.deepEqual(env.requests, [])
})

test('responder treats incomplete or replaced event generations as errors, not successful listings', { timeout: 10_000 }, async t => {
  for (const frames of [
    [pending('too-early')],
    [ready, { ...ready, clientId: 'replacement-generation' }],
  ]) await t.test(JSON.stringify(frames), async t => {
    const env = await fixture(t, { events: ({ send }) => frames.forEach(send) })
    const result = await respond(env)
    assert.equal(result.code, 3)
    assert.match(result.stderr, /BAD_FRAME/u)
    assert.equal(result.stdout, '')
    assert.deepEqual(env.requests, [])
  })
})

test('responder does not turn a premature close into a completed observation window', { timeout: 10_000 }, async t => {
  const env = await fixture(t, { events({ send, ws, later }) { send(ready); later(20, () => ws.close()) } })
  const result = await respond(env)
  assert.equal(result.code, 4)
  assert.match(result.stderr, /STREAM_ENDED/u)
  assert.equal(result.stdout, '')
  assert.deepEqual(env.requests, [])
})

test('both control scripts reject invalid flags and incomplete write selection before network access', { timeout: 20_000 }, async t => {
  const env = await fixture(t)
  const cases = [
    ['wait-for-turn-end.mjs', []],
    ['wait-for-turn-end.mjs', ['--session', sessionId, '--timeout-min', '0']],
    ['wait-for-turn-end.mjs', ['--session', sessionId, '--timeout-min', 'NaN']],
    ['wait-for-turn-end.mjs', ['--session', sessionId, '--request-id', '']],
    ['wait-for-turn-end.mjs', ['--session', sessionId, '--url', 'ws://localhost/']],
    ['respond.mjs', []],
    ['respond.mjs', [sessionId, '--answer', '[{"id":"choice","selected":["Red"]}]']],
    ['respond.mjs', [sessionId, '--answer', '{', '--event-id', 'selected-event']],
    ['respond.mjs', [sessionId, '--answer', '[]', '--event-id', 'selected-event']],
    ['respond.mjs', [sessionId, '--answer', '[{"id":"choice","selected":"Red"}]', '--event-id', 'selected-event']],
    ['respond.mjs', [sessionId, '--approve', 'selected-event', 'allowed-always']],
    ['respond.mjs', [sessionId, '--approve', 'selected-event', '--answer', '[]']],
    ['respond.mjs', [sessionId, '--list', '--approve', 'selected-event']],
    ['respond.mjs', [sessionId, '--wait-seconds', '0']],
    ['respond.mjs', [sessionId, '--wait-seconds', 'Infinity']],
    ['respond.mjs', [sessionId, '--url', 'ws://localhost/']],
  ]
  for (const [script, args] of cases) {
    const result = await run(env, script, args)
    assert.equal(result.code, 5, `${script}: ${result.stderr}`)
    assert.match(result.stderr, /BAD_ARGUMENTS/u)
    assert.equal(result.stdout, '')
  }
  assert.deepEqual(env.requests, [])
  assert.deepEqual(env.handshakes, [])
})

test('both scripts fail on missing auth without visiting the synthetic host', { timeout: 10_000 }, async t => {
  const env = await fixture(t, { authenticate: false })
  for (const invoke of [wait, respond]) {
    const result = await invoke(env)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /AUTH_REQUIRED/u)
  }
  assert.deepEqual(env.requests, [])
  assert.deepEqual(env.handshakes, [])
})

test('forbidden WebSocket handshakes are not retried or treated as successful observations', { timeout: 10_000 }, async t => {
  for (const invoke of [wait, respond]) await t.test(invoke === wait ? 'waiter' : 'responder', async t => {
    const env = await fixture(t, { upgradeStatus: 403 })
    const result = await invoke(env)
    assert.equal(result.code, 3)
    assert.match(result.stderr, /HTTP_ERROR.*403/u)
    assert.equal(result.stdout, '')
    assert.equal(env.handshakes.length, 1)
  })
})

function archivedWorkspace() {
  return { items: [{ workspaceId: 'fixture-workspace', sessionIds: [sessionId] }], archivedSessionIds: [sessionId] }
}

test('restore is a read-only dry run unless commit is explicit', { timeout: 10_000 }, async t => {
  const env = await fixture(t, { workspace: archivedWorkspace() })
  const result = report(await run(env, 'unarchive.mjs', ['restore', sessionId]))
  assert.equal(result.action, 'unarchive')
  assert.equal(result.dryRun, true)
  assert.equal(result.targets[0].archived, true)
  assert.deepEqual(env.requests.map(request => request.url), ['/api/session/list'])
  assert.deepEqual(env.opens.map(frame => frame.endpoint), ['workspace/follow'])
})

test('committed restore uses native unarchive rather than forking or offline writes', { timeout: 10_000 }, async t => {
  const writes = []
  const env = await fixture(t, { workspace: archivedWorkspace(), rpc(envelope, response) {
    writes.push(envelope.method)
    assert.equal(envelope.method, 'workspace/unarchiveSession')
    assert.deepEqual(envelope.payload, { args: { request: { sessionId } } })
    json(response, { archivedSessionIds: [] })
  } })
  const result = await run(env, 'unarchive.mjs', ['restore', sessionId, '--commit'])
  assert.equal(result.code, 0, result.stderr)
  const receipts = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(receipts.at(-1), { action: 'unarchive', sessionId, archived: false })
  assert.deepEqual(writes, ['workspace/unarchiveSession'])
})

test('restore refuses missing or unowned targets before any write', { timeout: 10_000 }, async t => {
  const env = await fixture(t, { workspace: { items: [], archivedSessionIds: [sessionId] } })
  const result = await run(env, 'unarchive.mjs', ['restore', sessionId, '--commit'])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /UNRECOVERABLE/u)
  assert.deepEqual(env.requests.map(request => request.url), ['/api/session/list'])
})

test('a protected host cannot cause restore to fall back to offline editing', { timeout: 10_000 }, async t => {
  for (const status of [401, 403]) await t.test(String(status), async t => {
    const env = await fixture(t, { upgradeStatus: status, workspace: archivedWorkspace() })
    const result = await run(env, 'unarchive.mjs', ['restore', sessionId, '--commit'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, new RegExp(String(status)))
    assert.deepEqual(env.requests, [])
    assert.equal(env.handshakes.length, 1)
  })
})

test('fork with archive-original fails when the archive receipt does not list the original', { timeout: 10_000 }, async t => {
  for (const archived of [true, false]) await t.test(archived ? 'confirmed' : 'unconfirmed', async t => {
    const writes = []
    const env = await fixture(t, { workspace: archivedWorkspace(), rpc(envelope, response) {
      writes.push(envelope.method)
      if (envelope.method === 'session/fork') json(response, { sessionId: 'session-fork-fixture' })
      else json(response, { archivedSessionIds: archived ? [sessionId] : [] })
    } })
    const result = await run(env, 'unarchive.mjs', ['fork', sessionId, '--archive-original', '--commit'])
    assert.deepEqual(writes, ['session/fork', 'workspace/archiveSession'])
    if (archived) {
      assert.equal(result.code, 0, result.stderr)
      const receipts = result.stdout.trim().split('\n').map(line => JSON.parse(line))
      assert.deepEqual(receipts.at(-1), { action: 'archive', sessionId, archived: true })
    } else {
      assert.notEqual(result.code, 0)
      assert.match(result.stderr, /BAD_RECEIPT/u)
    }
  })
})
