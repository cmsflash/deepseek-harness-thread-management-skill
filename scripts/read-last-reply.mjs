#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { RpcClient, RpcError } from './rpc-client.mjs'
import { readLastReply } from './thread-reader.mjs'

let client
try {
  const { values } = parseArgs({ options: {
    session: { type: 'string' }, parent: { type: 'string' }, 'base-url': { type: 'string' }, 'auth-file': { type: 'string' },
    'max-messages': { type: 'string', default: '8' }, 'through-seq': { type: 'string' },
    'timeout-ms': { type: 'string', default: '120000' },
    'max-download-mib': { type: 'string', default: '256' }, 'max-log-mib': { type: 'string', default: '768' },
    json: { type: 'boolean' }, help: { type: 'boolean' },
  } })
  if (values.help || !values.session) {
    console.log('Usage: read-last-reply.mjs --session ID [--parent PARENT_ID] [--json] [--base-url ORIGIN] [--auth-file FILE] [--through-seq N] [--max-messages 8]')
    if (!values.help) process.exitCode = 1
  } else {
    const maxMessages = Number(values['max-messages'])
    const throughSeq = values['through-seq'] === undefined ? undefined : Number(values['through-seq'])
    const maxDownloadBytes = Number(values['max-download-mib']) * 1024 * 1024
    const maxLogBytes = Number(values['max-log-mib']) * 1024 * 1024
    if (!Number.isSafeInteger(maxMessages) || maxMessages < 1
      || (throughSeq !== undefined && (!Number.isSafeInteger(throughSeq) || throughSeq < -1))
      || !Number.isSafeInteger(maxDownloadBytes) || maxDownloadBytes < 1
      || !Number.isSafeInteger(maxLogBytes) || maxLogBytes < 1) throw new RpcError('BAD_ARGUMENTS', 'Invalid history cursor or read limit.')
    client = new RpcClient({ baseUrl: values['base-url'], authFile: values['auth-file'], timeoutMs: Number(values['timeout-ms']) })
    const result = await readLastReply(client, values.session, { maxMessages, throughSeq, maxDownloadBytes, maxLogBytes, parentSessionId: values.parent })
    if (values.json) console.log(client.redact(JSON.stringify(result)))
    else {
      console.log(`session: ${result.sessionId}\ntitle: ${result.title || '(untitled)'}\nrunning: ${result.running}\nlatest turn: ${result.lastTurnStatus}`)
      console.log(`last interaction: ${result.lastInteractionAt ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'long' }).format(result.lastInteractionAt) : 'none'}\n`)
      if (result.lastPrompt) console.log(`Last human prompt:\n${result.lastPrompt.text || '[attachment-only prompt]'}\n`)
      if (result.newerPromptWithoutResponse) console.log('A newer human prompt has no response at this committed cut.\n')
      if (result.lastResponse) console.log(client.redact(`Last response (${result.lastResponse.kind}):\n${result.lastResponse.text}`))
      else console.log(result.note || 'No assistant text in this thread or bounded history window.')
      if (result.lastResponse?.kind !== 'final' && result.lastFinalReply) console.log(client.redact(`\nPrevious completed reply:\n${result.lastFinalReply.text}`))
    }
  }
} catch (error) {
  const message = error instanceof RpcError ? `${error.code}: ${error.message}` : 'Thread read failed; no partial result was accepted.'
  console.error(client ? client.redact(message) : message)
  process.exitCode = 1
}
