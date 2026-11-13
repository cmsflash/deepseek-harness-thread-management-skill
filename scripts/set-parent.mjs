#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { RpcClient, RpcError } from './rpc-client.mjs'

let client
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'base-url': { type: 'string' }, 'auth-file': { type: 'string' },
    parent: { type: 'string' }, clear: { type: 'boolean' }, help: { type: 'boolean' },
  } })
  if (values.help) {
    console.log(`Usage: set-parent.mjs CHILD_SESSION_ID [--parent SESSION_ID | --clear]
Nests CHILD under --parent in the thread list; without --parent, under this thread (DSH_SESSION_ID).
--clear puts CHILD back at the top level of its project.
Options: --base-url ORIGIN --auth-file FILE
Prints one line of JSON: status "nested", "cleared", or "unsupported" (the Host has no
workspace/setSessionParent; nothing changed). A Host refusal prints its code and message and exits 1.`)
  } else {
    const [sessionId] = positionals
    const parentSessionId = values.clear ? null : values.parent ?? process.env.DSH_SESSION_ID
    if (positionals.length !== 1 || !sessionId || (values.clear && values.parent !== undefined) || parentSessionId === undefined || parentSessionId === '') {
      throw new RpcError('BAD_ARGUMENTS', 'Name one child session ID, and either --parent SESSION_ID or --clear when DSH_SESSION_ID is not set; use --help.')
    }
    client = new RpcClient({ baseUrl: values['base-url'], authFile: values['auth-file'] })
    const print = value => console.log(client.redact(JSON.stringify(value)))
    let receipt
    let supported = true
    try {
      receipt = await client.request('workspace/setSessionParent', { request: { sessionId, parentSessionId } })
    } catch (error) {
      if (!(error instanceof RpcError) || error.code !== 'HTTP_ERROR' || error.status !== 404) throw error
      supported = false
    }
    if (!supported) {
      print({ status: 'unsupported', sessionId,
        note: 'This Host has no workspace/setSessionParent (HTTP 404). Nothing changed. Carry on without nesting and say so in your update.' })
    } else {
      const links = receipt?.sessionParents
      if (typeof links !== 'object' || links === null || (links[sessionId] ?? null) !== parentSessionId) {
        throw new RpcError('BAD_RECEIPT', 'The parent receipt does not confirm the requested outcome. Repeating the same call is safe.')
      }
      print(parentSessionId === null ? { status: 'cleared', sessionId } : { status: 'nested', sessionId, parentSessionId })
    }
  }
} catch (error) {
  const message = error instanceof RpcError ? `${error.code}: ${error.message}` : 'Invalid command or input; use --help.'
  console.error(client ? client.redact(message) : message)
  process.exitCode = 1
}
