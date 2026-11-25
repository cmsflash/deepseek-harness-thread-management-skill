#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { RpcClient, RpcError, defaultTimeoutMs } from './rpc-client.mjs'

const endpoint = 'workspace/setSessionAttachment'
const isMap = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const isIds = value => Array.isArray(value) && value.every(id => typeof id === 'string' && id.length > 0)
let client
let target = {}
let writeAttempted = false
let reconciliation

async function observe() {
  const baseline = await client.streamUntil('workspace/follow', {}, item => {
    if (item?.type !== 'baseline' || !isMap(item.value)
      || !Array.isArray(item.value.items) || !isMap(item.value.sessionParents)
      || !item.value.items.every(item => isIds(item?.sessionIds))
      || !Object.values(item.value.sessionParents).every(id => typeof id === 'string' && id.length > 0)
      || (item.value.detachedSessionIds !== undefined && !isIds(item.value.detachedSessionIds))) {
      throw new RpcError('BAD_BASELINE', 'Cannot verify workspace ownership, parent links, or attachment markers.')
    }
    return true
  })
  const value = baseline.value
  const owned = value.items.some(item => item.sessionIds.includes(target.sessionId))
  const parentSessionId = value.sessionParents[target.sessionId] ?? null
  return {
    owned, parentSessionId,
    attachment: value.detachedSessionIds === undefined ? 'unavailable'
      : value.detachedSessionIds.includes(target.sessionId) ? 'detached' : parentSessionId === null ? 'none' : 'attached',
  }
}

function matches(observed) {
  return observed.owned && observed.parentSessionId === target.parentSessionId && observed.attachment === target.attachment
}

function errorFields(error) {
  return { code: error instanceof RpcError ? error.code : 'UNEXPECTED_ERROR',
    message: error instanceof RpcError ? error.message : 'Unexpected helper failure.',
    ...(error instanceof RpcError && error.status !== undefined ? { httpStatus: error.status } : {}) }
}

function print(value) {
  const text = JSON.stringify({ action: 'set-attachment', ...target, ...value })
  console.log(client ? client.redact(text) : text)
}

async function reconcile(failure) {
  reconciliation ??= observe().then(observed => ({ observed }), error => ({ observationError: errorFields(error) }))
  const { observed, observationError } = await reconciliation
  if (observed && matches(observed) && (!failure || failure instanceof RpcError)) {
    print({ status: target.attachment, writeAttempted: true, verification: failure ? 'reconciled' : 'receipt-and-baseline',
      observed, ...(failure ? { writeError: errorFields(failure) } : {}) })
  } else {
    print({ status: 'unknown', writeAttempted: true, ...(observed ? { observed } : { observationError }),
      ...(failure ? { writeError: errorFields(failure) } : {}),
      message: 'The exact requested parent and marker are not confirmed. No retry was attempted. Reconcile fresh Host state and current human instruction before any retry; an in-flight write may still settle.' })
    process.exitCode = 1
  }
}

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'base-url': { type: 'string' }, 'auth-file': { type: 'string' }, 'timeout-ms': { type: 'string' },
    parent: { type: 'string' }, attach: { type: 'boolean' }, detach: { type: 'boolean' }, help: { type: 'boolean' },
  } })
  if (values.help) {
    console.log(`Usage: set-attachment.mjs CHILD_SESSION_ID --parent EXPECTED_PARENT_ID (--attach | --detach)
Changes only the Report's Host marker, on the human's instruction through its Manager.
--parent is required: a changed or missing current parent refuses the write.
Options: --base-url ORIGIN --auth-file FILE --timeout-ms MILLISECONDS
Prints one JSON receipt: attached/detached, unsupported, refused, or unknown.
Exit 0: verified marker or unsupported endpoint; exit 1: refused/unknown; exit 5: invalid arguments.
No prompt or registry update is sent. No write is retried; unknown outcomes are read back before returning.`)
  } else {
    const [sessionId] = positionals
    if (positionals.length !== 1 || !sessionId?.trim() || !values.parent?.trim()
      || Boolean(values.attach) === Boolean(values.detach) || sessionId === values.parent) {
      throw new RpcError('BAD_ARGUMENTS', 'Name one child, an explicit --parent expected current parent, and exactly one of --attach or --detach; use --help.')
    }
    target = { sessionId, parentSessionId: values.parent, attachment: values.detach ? 'detached' : 'attached' }
    client = new RpcClient({ baseUrl: values['base-url'], authFile: values['auth-file'],
      timeoutMs: defaultTimeoutMs(values['timeout-ms']) })
    target.origin = client.origin
    const before = await observe()
    if (!before.owned || before.parentSessionId !== target.parentSessionId) {
      print({ status: 'refused', writeAttempted: false, observed: before, code: 'PARENT_MISMATCH',
        message: 'The owned target must still have the expected parent. Resolve the target and authority before acting.' })
      process.exitCode = 1
    } else {
      let failure
      try {
        writeAttempted = true
        const receipt = await client.request(endpoint, { request: { sessionId, parentSessionId: target.parentSessionId, attachment: target.attachment } })
        if (!isIds(receipt?.detachedSessionIds)
          || receipt.detachedSessionIds.includes(sessionId) !== Boolean(values.detach)) {
          throw new RpcError('BAD_RECEIPT', 'The attachment receipt does not confirm the requested marker.')
        }
      } catch (error) {
        failure = error
      }
      if (failure instanceof RpcError && failure.code === 'HTTP_ERROR' && failure.status === 404
        && before.attachment === 'unavailable') {
        print({ status: 'unsupported', writeAttempted: true, code: failure.code, httpStatus: 404,
          message: 'The Host has no attachment endpoint (HTTP 404) and exposes no attachment markers. Keep the human instruction and record marker sync as unsupported.' })
      } else if (failure instanceof RpcError && typeof failure.code === 'string' && (failure.code.startsWith('workspace/')
        || failure.code.startsWith('session/') || failure.code === 'AUTH_REQUIRED'
        || failure.code === 'CONNECTION_REFUSED' || (failure.code === 'HTTP_ERROR' && failure.status === 403))) {
        print({ status: 'refused', writeAttempted: true, ...errorFields(failure) })
        process.exitCode = 1
      } else {
        await reconcile(failure)
      }
    }
  }
} catch (error) {
  if (writeAttempted) {
    await reconcile(error)
  } else {
    const invalid = typeof error?.code === 'string'
      && (error.code.startsWith('ERR_PARSE_ARGS') || ['BAD_ARGUMENTS', 'BAD_TIMEOUT'].includes(error.code))
    print({ status: 'refused', writeAttempted: false, ...(invalid
      ? { code: 'BAD_ARGUMENTS', message: 'Invalid command or input; use --help.' } : errorFields(error)) })
    process.exitCode = invalid ? 5 : 1
  }
}
