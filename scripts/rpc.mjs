#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { RpcClient, RpcError } from './rpc-client.mjs'

let client
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'base-url': { type: 'string' }, 'auth-file': { type: 'string' },
      'timeout-ms': { type: 'string' }, 'from-log': { type: 'string' },
      'launch-url-file': { type: 'string' }, 'args-file': { type: 'string' },
      'max-items': { type: 'string' }, help: { type: 'boolean' },
    },
  })
  if (values.help || positionals.length === 0) {
    console.log(`Usage:
  rpc.mjs login (--from-log FILE | --launch-url-file FILE)
  rpc.mjs call ENDPOINT [NAMED_ARGS_JSON | --args-file FILE]
  rpc.mjs stream ENDPOINT [NAMED_ARGS_JSON | --args-file FILE] [--max-items 1]
  rpc.mjs probe

Options: --base-url ORIGIN --auth-file FILE --timeout-ms 30000
Default origin: DSH_WEB_URL, otherwise http://127.0.0.1:3080.
Only use operator-approved launch output. Credentials are never printed.
Every write still requires approval of the exact action and content.`)
  } else {
    client = new RpcClient({ baseUrl: values['base-url'], authFile: values['auth-file'],
      timeoutMs: Number(values['timeout-ms'] || 30_000) })
    const [action, endpoint, json] = positionals
    const print = value => console.log(client.redact(JSON.stringify(value ?? null)))
    if (action === 'login') {
      if (positionals.length !== 1 || Boolean(values['from-log']) === Boolean(values['launch-url-file'])) {
        throw new RpcError('BAD_ARGUMENTS', 'Login requires exactly one launch-URL file or approved launch-output file.')
      }
      const result = values['from-log']
        ? await client.loginFromLog(values['from-log'])
        : await client.loginFromFile(values['launch-url-file'])
      print({ authenticated: true, ...result })
    } else if (action === 'probe') {
      if (positionals.length !== 1) throw new RpcError('BAD_ARGUMENTS', 'Probe takes no positional arguments.')
      print({ running: await client.probe() })
    } else if (action === 'call' || action === 'stream') {
      if (!endpoint || positionals.length > 3 || (json && values['args-file'])) {
        throw new RpcError('BAD_ARGUMENTS', 'Supply an endpoint and at most one named-arguments input.')
      }
      const args = JSON.parse(values['args-file'] ? await readFile(values['args-file'], 'utf8') : json || '{}')
      if (action === 'call') print(await client.request(endpoint, args))
      else {
        const max = Number(values['max-items'] || 1)
        if (!Number.isSafeInteger(max) || max < 1) throw new RpcError('BAD_ARGUMENTS', 'max-items must be a positive integer.')
        let count = 0
        await client.streamUntil(endpoint, args, value => { print(value); return ++count >= max })
      }
    } else throw new RpcError('BAD_ARGUMENTS', 'Unknown command; use --help.')
  }
} catch (error) {
  const message = error instanceof RpcError ? `${error.code}: ${error.message}` : 'Invalid command or input; use --help.'
  console.error(client ? client.redact(message) : message)
  process.exitCode = 1
}
