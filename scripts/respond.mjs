#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { RpcClient, RpcError } from './rpc-client.mjs'

function parseAnswers(text) {
  let answers
  try { answers = JSON.parse(text) } catch {
    throw new RpcError('BAD_ARGUMENTS', '--answer must be a JSON array of explicit answers.')
  }
  if (!Array.isArray(answers) || answers.length === 0 || answers.some(answer => !answer
    || typeof answer.id !== 'string' || !answer.id.trim() || !Array.isArray(answer.selected)
    || answer.selected.some(label => typeof label !== 'string')
    || (answer.custom !== undefined && typeof answer.custom !== 'string')
    || Object.keys(answer).some(key => !['id', 'selected', 'custom'].includes(key)))
    || new Set(answers.map(answer => answer.id)).size !== answers.length) {
    throw new RpcError('BAD_ARGUMENTS', 'Each answer needs a distinct question id, selected string array, and optional custom text.')
  }
  return answers
}

async function observe(client, { sessionId, mode, eventId, outcome, answers, waitMs }) {
  const pending = new Map()
  const controller = new AbortController()
  let phase = 'ready'
  let clientId
  let submitted
  let timer = setTimeout(() => controller.abort(), client.timeoutMs)
  try {
    await client.streamUntil('$events', {}, async frame => {
      if (frame?.type === 'ready') {
        if (clientId !== undefined || typeof frame.clientId !== 'string' || !frame.clientId) {
          throw new RpcError('BAD_FRAME', 'Event stream did not provide one stable client generation.')
        }
        clientId = frame.clientId
        phase = 'observe'
        clearTimeout(timer)
        timer = setTimeout(() => controller.abort(), waitMs)
        return false
      }
      if (clientId === undefined) throw new RpcError('BAD_FRAME', 'Event stream did not begin with its ready frame.')
      if (frame?.type === 'cancel') {
        pending.delete(frame.eventId)
        return false
      }
      if (frame?.type !== 'waterfall' || frame.agentId !== sessionId
        || !['approval/request', 'user-questions/request'].includes(frame.event)) return false
      if (typeof frame.eventId !== 'string' || !frame.eventId || !frame.request
        || typeof frame.request !== 'object' || Array.isArray(frame.request)) {
        throw new RpcError('BAD_FRAME', 'Pending event did not contain a usable event ID and request.')
      }
      pending.set(frame.eventId, { eventId: frame.eventId, event: frame.event, request: frame.request })
      if (mode === 'list' || frame.eventId !== eventId) return false
      const expected = mode === 'approve' ? 'approval/request' : 'user-questions/request'
      if (frame.event !== expected) throw new RpcError('BAD_TARGET', 'The selected event has the wrong request type; no result was submitted.')
      if (mode === 'answer') {
        const questions = frame.request.questions
        if (!Array.isArray(questions) || questions.length !== answers.length
          || questions.some(question => !answers.some(answer => answer.id === question?.id))) {
          throw new RpcError('BAD_ARGUMENTS', 'Answers must name each question from the selected event exactly once.')
        }
      }
      clearTimeout(timer)
      phase = 'submit'
      await client.request('$events/result', {
        clientId, eventId, outcome: { kind: 'result', value: mode === 'approve' ? outcome : { answers } },
      })
      submitted = { status: 'submitted', confirmation: 'unconfirmed', sessionId, eventId, event: frame.event }
      return true
    }, { timeoutMs: client.timeoutMs * 2 + waitMs, signal: controller.signal })
    return submitted
  } catch (error) {
    if (error.code === 'ABORTED' && phase === 'observe') {
      if (mode === 'list') {
        return { status: 'observation-window', sessionId, observationMs: waitMs, complete: false, pending: [...pending.values()] }
      }
      throw new RpcError('EVENT_NOT_OBSERVED', 'The selected pending event was not observed during this window; no result was submitted.')
    }
    if (error.code === 'ABORTED' && phase === 'ready') {
      throw new RpcError('TIMEOUT', 'The event stream did not become ready within the connection deadline.')
    }
    if (phase === 'submit') {
      throw new RpcError(error.code || 'SUBMISSION_FAILED', `Submission outcome is unconfirmed. ${error.message} No retry was attempted.`, error.status)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

let client
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      list: { type: 'boolean' }, approve: { type: 'string' }, answer: { type: 'string' },
      'event-id': { type: 'string' }, 'wait-seconds': { type: 'string' },
      'base-url': { type: 'string' }, 'auth-file': { type: 'string' }, help: { type: 'boolean' },
    },
  })
  if (values.help) {
    console.log(`Usage:
  respond.mjs SESSION [--list] [--wait-seconds 3]
  respond.mjs SESSION --approve EVENT_ID [allowed-once|rejected]
  respond.mjs SESSION --answer '[{"id":"question-id","selected":["explicit choice"]}]' --event-id EVENT_ID
Options: --base-url ORIGIN --auth-file FILE --wait-seconds 3
Listings cover an observation window after ready, not an exhaustive replay.
Writes require the human's explicit approval of this event and exact response.
A submitted RPC receipt cannot confirm that a still-pending event was answered.`)
  } else {
    const [sessionId, selectedOutcome] = positionals
    const mode = values.approve !== undefined ? 'approve' : values.answer !== undefined ? 'answer' : 'list'
    const eventId = mode === 'approve' ? values.approve : values['event-id']
    const outcome = selectedOutcome ?? 'allowed-once'
    const waitMs = Number(values['wait-seconds'] ?? 3) * 1000
    if (!sessionId?.trim() || positionals.length > (mode === 'approve' ? 2 : 1)
      || (values.approve !== undefined && values.answer !== undefined)
      || (values.list && mode !== 'list') || (mode !== 'answer' && values['event-id'] !== undefined)
      || (mode !== 'list' && !eventId?.trim()) || !['allowed-once', 'rejected'].includes(outcome)
      || !Number.isFinite(waitMs) || waitMs < 1 || waitMs > 2_147_423_647) {
      throw new RpcError('BAD_ARGUMENTS', 'Specify one session and mode; writes need an explicit event ID and a positive, bounded observation window.')
    }
    const answers = mode === 'answer' ? parseAnswers(values.answer) : undefined
    client = new RpcClient({ baseUrl: values['base-url'], authFile: values['auth-file'] })
    const result = await observe(client, { sessionId, mode, eventId, outcome, answers, waitMs })
    console.log(client.redact(JSON.stringify(result)))
  }
} catch (error) {
  const message = error instanceof RpcError ? `${error.code}: ${error.message}` : 'BAD_ARGUMENTS: Invalid command or input; use --help.'
  console.error(client ? client.redact(message) : message)
  process.exitCode = error.code === 'TIMEOUT' ? 2 : error.code === 'STREAM_ENDED' ? 4
    : error.code === 'EVENT_NOT_OBSERVED' ? 1 : error.code === 'BAD_ARGUMENTS' || !(error instanceof RpcError) ? 5 : 3
}
