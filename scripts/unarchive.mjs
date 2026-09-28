#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { RpcClient, RpcError } from './rpc-client.mjs'

let client
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'base-url': { type: 'string' }, 'auth-file': { type: 'string' },
    commit: { type: 'boolean' }, all: { type: 'boolean' },
    'archive-original': { type: 'boolean' }, 'at-seq': { type: 'string' }, help: { type: 'boolean' },
  } })
  const [action, ...ids] = positionals
  if (values.help || !action) {
    console.log('Usage: unarchive.mjs list | restore ID... [--commit] | restore --all [--commit] | archive ID [--commit] | fork ID [--at-seq N] [--archive-original] [--commit]\nOptions: --base-url ORIGIN --auth-file FILE\nRestore uses native workspace/unarchiveSession; it never edits storage files or stops DSH.')
    if (!values.help) process.exitCode = 1
  } else {
    if (!['list', 'restore', 'archive', 'fork'].includes(action)) throw new RpcError('BAD_ARGUMENTS', 'Unknown recovery action.')
    client = new RpcClient({ baseUrl: values['base-url'], authFile: values['auth-file'] })
    const { value: baseline } = await client.streamUntil('workspace/follow', {}, item => item.type === 'baseline')
    const { items } = await client.request('session/list', { _request: {} })
    const index = new Map(items.map(item => [item.sessionId, item]))
    const owned = new Set(baseline.items.flatMap(workspace => workspace.sessionIds))
    const archived = new Set(baseline.archivedSessionIds)
    const describe = sessionId => ({ sessionId, title: index.get(sessionId)?.projections?.values?.title ?? null,
      workspaceOwned: owned.has(sessionId), available: index.has(sessionId), archived: archived.has(sessionId) })
    const print = value => console.log(client.redact(JSON.stringify(value)))
    if (action === 'list') {
      if (ids.length || values.commit || values.all || values['archive-original']) throw new RpcError('BAD_ARGUMENTS', 'List is read-only and takes no target arguments.')
      print({ archived: [...archived].map(describe) })
    } else {
      if (values.all && (action !== 'restore' || ids.length)) throw new RpcError('BAD_ARGUMENTS', 'Use --all only with restore and no explicit IDs.')
      if (values['archive-original'] && action !== 'fork') throw new RpcError('BAD_ARGUMENTS', '--archive-original is only for fork.')
      if (values['at-seq'] !== undefined && action !== 'fork') throw new RpcError('BAD_ARGUMENTS', '--at-seq is only for fork.')
      const targets = values.all ? [...archived] : [...new Set(ids)]
      if (!targets.length || (action !== 'restore' && targets.length !== 1)) throw new RpcError('BAD_ARGUMENTS', 'Select explicit target IDs, or restore --all.')
      const unavailable = targets.filter(id => !index.has(id) || !owned.has(id))
      const atSeq = values['at-seq'] === undefined ? undefined : Number(values['at-seq'])
      if (atSeq !== undefined && (!Number.isSafeInteger(atSeq) || atSeq < 0)) throw new RpcError('BAD_ARGUMENTS', 'at-seq must be a nonnegative integer.')
      print({ action: action === 'restore' ? 'unarchive' : action, dryRun: !values.commit,
        targets: targets.map(describe), archiveOriginal: Boolean(values['archive-original']),
        ...(atSeq === undefined ? {} : { atSeq }) })
      if (values.commit) {
        if (unavailable.length) throw new RpcError('UNRECOVERABLE', 'Some targets have no available session/workspace slot; select recoverable IDs explicitly.')
        for (const sessionId of targets) {
          if (action === 'fork') {
            const result = await client.request('session/fork', { request: { sessionId, ...(atSeq === undefined ? {} : { atSeq }) } })
            print({ action: 'fork', sourceSessionId: sessionId, result })
            if (values['archive-original']) {
              const receipt = await client.request('workspace/archiveSession', { request: { sessionId } })
              print({ action: 'archive', sessionId, archived: receipt.archivedSessionIds.includes(sessionId) })
            }
          } else {
            const endpoint = action === 'restore' ? 'workspace/unarchiveSession' : 'workspace/archiveSession'
            const result = await client.request(endpoint, { request: { sessionId } })
            const isArchived = result.archivedSessionIds.includes(sessionId)
            if (isArchived !== (action === 'archive')) throw new RpcError('BAD_RECEIPT', 'Archive-state receipt does not confirm the requested outcome.')
            print({ action: action === 'restore' ? 'unarchive' : action, sessionId, archived: isArchived })
          }
        }
      }
    }
  }
} catch (error) {
  const message = error instanceof RpcError ? `${error.code}: ${error.message}` : 'Recovery request failed; inspect state before retrying any write.'
  console.error(client ? client.redact(message) : message)
  process.exitCode = 1
}
