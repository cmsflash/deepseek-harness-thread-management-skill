#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { RpcClient, RpcError } from './rpc-client.mjs'

function turnOf(event) {
  const turn = event?.data?.turn
  return Number.isSafeInteger(turn) && turn >= 0 ? turn : undefined
}

function turnMatcher(sessionId, requestId) {
  let opened = false
  let cursor = -1
  let currentTurn
  let targetTurn
  let awaitingTurn = false
  let result
  const completed = new Map()

  function observe(event, snapshot) {
    if (!event || typeof event.type !== 'string' || !Number.isSafeInteger(event.seq) || event.seq < 0) {
      throw new RpcError('BAD_FRAME', 'Follow stream contained an invalid Session event.')
    }
    const turn = turnOf(event)
    if ((event.type === 'turn/start' || event.type === 'turn/end') && turn === undefined) {
      throw new RpcError('BAD_FRAME', 'Turn boundary did not identify its turn.')
    }
    if (turn !== undefined) {
      if (awaitingTurn) {
        if (event.type === 'turn/start') {
          throw new RpcError('TURN_UNIDENTIFIED', 'The requested message has no recoverable turn context in the observed window.')
        }
        targetTurn = turn
        awaitingTurn = false
      }
      currentTurn = turn
      if (snapshot && !requestId) targetTurn = turn
    }
    if (requestId && event.type === 'user/message' && event.data?.source?.rpcId === requestId) {
      if (targetTurn !== undefined && currentTurn !== targetTurn) {
        throw new RpcError('TURN_UNIDENTIFIED', 'The request identifier appeared in conflicting turn contexts.')
      }
      targetTurn = currentTurn
      awaitingTurn = targetTurn === undefined
    }
    if (snapshot && event.type === 'turn/end') completed.set(turn, event)
  }

  function ended(event, observed) {
    result = {
      status: 'turn/end', sessionId, turn: targetTurn, reason: event.data.reason,
      seq: event.seq, observed, ...(requestId ? { requestId } : {}),
    }
    return true
  }

  return {
    accept(frame) {
      if (frame?.type === 'snapshot') {
        if (opened || !Array.isArray(frame.records) || !Number.isSafeInteger(frame.cursor) || frame.cursor < -1
          || (frame.header?.id !== undefined && frame.header.id !== sessionId)) {
          throw new RpcError('BAD_FRAME', 'Follow stream supplied an invalid opening snapshot.')
        }
        opened = true
        cursor = frame.cursor
        for (const record of frame.records) {
          if (record?.type !== 'event' || record.event?.seq > cursor) {
            throw new RpcError('BAD_FRAME', 'Follow snapshot contained an invalid history record.')
          }
          observe(record.event, true)
        }
        if ((!requestId && targetTurn === undefined) || awaitingTurn) {
          throw new RpcError('TURN_UNIDENTIFIED', 'No target turn can be recovered from the bounded snapshot; no completion was inferred.')
        }
        const end = completed.get(targetTurn)
        return end ? ended(end, 'snapshot') : false
      }
      if (!opened) throw new RpcError('BAD_FRAME', 'Follow stream did not start with a snapshot.')
      if (frame?.type !== 'event') return false
      const event = frame.event
      if (Number.isSafeInteger(event?.seq) && event.seq <= cursor) return false
      observe(event, false)
      cursor = event.seq
      return targetTurn !== undefined && event.type === 'turn/end' && turnOf(event) === targetTurn
        ? ended(event, 'live') : false
    },
    result: () => result,
  }
}

let client
try {
  const { values } = parseArgs({
    options: {
      session: { type: 'string' }, 'request-id': { type: 'string' },
      'base-url': { type: 'string' }, 'auth-file': { type: 'string' },
      'timeout-min': { type: 'string' }, help: { type: 'boolean' },
    },
  })
  if (values.help) {
    console.log('Usage: wait-for-turn-end.mjs --session ID [--request-id ID] [--timeout-min 30] [--base-url ORIGIN] [--auth-file FILE]\nObserves an already-running session only. Never sends a prompt or follows an idle session.')
  } else {
    const sessionId = values.session
    const requestId = values['request-id']
    const timeoutMs = Number(values['timeout-min'] ?? 30) * 60_000
    if (!sessionId?.trim() || (requestId !== undefined && !requestId.trim())
      || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
      throw new RpcError('BAD_ARGUMENTS', 'Supply --session and a positive, bounded --timeout-min; request IDs must be non-empty.')
    }
    client = new RpcClient({ baseUrl: values['base-url'], authFile: values['auth-file'], timeoutMs: Math.min(30_000, timeoutMs) })
    const listing = await client.request('session/list', { _request: {} })
    if (!Array.isArray(listing?.items)) throw new RpcError('BAD_RESPONSE', 'Session list did not contain its items array.')
    const target = listing.items.find(item => item?.sessionId === sessionId)
    if (!target) throw new RpcError('SESSION_NOT_FOUND', 'The requested session is not in the visible session list; nothing was followed.')
    let result
    if (target.running === false) {
      result = { status: 'idle', sessionId, ...(requestId ? { requestId, requestCompletionConfirmed: false } : {}) }
    } else {
      if (target.running !== true) throw new RpcError('BAD_RESPONSE', 'The target session did not report a definite running state.')
      const matcher = turnMatcher(sessionId, requestId)
      await client.streamUntil('session/follow', {
        request: { address: { kind: 'session', sessionId }, maxMessages: 8, stepDetail: 'collapsed' },
      }, frame => matcher.accept(frame), { timeoutMs })
      result = matcher.result()
    }
    console.log(client.redact(JSON.stringify(result)))
  }
} catch (error) {
  let message = error instanceof RpcError ? `${error.code}: ${error.message}` : 'BAD_ARGUMENTS: Invalid command or input; use --help.'
  if (error.code === 'TIMEOUT') message += ' Re-check the running state and request correlation before re-arming; no prompt was sent.'
  console.error(client ? client.redact(message) : message)
  process.exitCode = error.code === 'TIMEOUT' ? 2 : error.code === 'STREAM_ENDED' ? 4
    : error.code === 'SESSION_NOT_FOUND' ? 1 : error.code === 'BAD_ARGUMENTS' || !(error instanceof RpcError) ? 5 : 3
}
