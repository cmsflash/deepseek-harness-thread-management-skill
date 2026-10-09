import { createRequire } from 'node:module'
import { join } from 'node:path'
import { RpcError } from './rpc-client.mjs'

const textOf = blocks => Array.isArray(blocks)
  ? blocks.filter(block => block.type === 'text').map(block => block.text || '').join('\n') : ''

export function exportCursorDecoder(sessionId, { maxLogBytes = 768 * 1024 * 1024, maxLineBytes = 64 * 1024 * 1024 } = {}) {
  const root = process.env.DSH_ROOT || '/Users/zhuoran/Programs/deepseek-harness'
  const { Unzip, UnzipInflate } = createRequire(join(root, 'packages/session-query/session-log-export/package.json'))('fflate')
  let first = true, complete = false, header, title, cursor = -1, bytes = 0, pending = ''
  let lastInteractionAt = null, lastPromptAt = null, lastPromptSeq = null, lastTurnStart = null, lastTurnEnd = null
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const line = value => {
    if (!value.trim()) return
    const event = JSON.parse(value)
    if (!header) {
      if (event?.type !== 'session' || event.id !== sessionId) throw new RpcError('BAD_EXPORT', 'Export header does not match the requested session.')
      header = event
      return
    }
    if (!Number.isSafeInteger(event.seq) || event.seq <= cursor) throw new RpcError('BAD_EXPORT', 'Export event sequence is not increasing.')
    cursor = event.seq
    const data = event.data || {}
    if (event.type === 'session/title') title = data.title
    if (event.type === 'turn/start') lastTurnStart = { seq: event.seq, time: event.time, turn: data.turn }
    if (event.type === 'turn/end') lastTurnEnd = { seq: event.seq, time: event.time, turn: data.turn, reason: { kind: data.reason?.kind } }
    if (event.type === 'user/message' && data.source?.kind === 'user') {
      lastPromptAt = event.time
      lastPromptSeq = event.seq
      lastInteractionAt = Math.max(lastInteractionAt || 0, event.time)
    } else if (event.type === 'assistant/message' && textOf(data.message?.content)) {
      lastInteractionAt = Math.max(lastInteractionAt || 0, event.time)
    }
  }
  const unzip = new Unzip(file => {
    if (!first) return
    first = false
    if (!/^session(?:\.v\d+)?\.jsonl$/u.test(file.name)) throw new RpcError('BAD_EXPORT', 'The first ZIP entry is not the root session log.')
    file.ondata = (error, chunk, final) => {
      if (error) throw error instanceof RpcError ? error : new RpcError('BAD_EXPORT', 'Cannot decode the root session log.')
      bytes += chunk.length
      if (bytes > maxLogBytes) throw new RpcError('EXPORT_LIMIT', 'Session log exceeds the configured decoded-byte limit.')
      pending += decoder.decode(chunk, { stream: !final })
      let newline
      while ((newline = pending.indexOf('\n')) !== -1) {
        const value = pending.slice(0, newline)
        if (Buffer.byteLength(value) > maxLineBytes) throw new RpcError('EXPORT_LIMIT', 'Session log line exceeds the configured limit.')
        line(value)
        pending = pending.slice(newline + 1)
      }
      if (Buffer.byteLength(pending) > maxLineBytes) throw new RpcError('EXPORT_LIMIT', 'Session log line exceeds the configured limit.')
      if (final) {
        if (pending.trim()) line(pending)
        if (!header) throw new RpcError('BAD_EXPORT', 'Session log header is absent.')
        complete = true
      }
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  return {
    push(chunk, final = false) {
      try { unzip.push(chunk, final) } catch (error) {
        throw error instanceof RpcError ? error : new RpcError('BAD_EXPORT', 'Invalid or truncated session export.')
      }
      if (final && !complete) throw new RpcError('BAD_EXPORT', 'Export ended before its complete root log.')
    },
    get complete() { return complete },
    result() {
      if (!complete) throw new RpcError('BAD_EXPORT', 'Root log is not complete.')
      return { header, title, cursor, decodedBytes: bytes, lastInteractionAt, lastPromptAt, lastPromptSeq, lastTurnStart, lastTurnEnd }
    },
  }
}

export async function committedCursor(client, sessionId, { maxDownloadBytes = 256 * 1024 * 1024, ...limits } = {}) {
  const query = new URLSearchParams({ sessionId, includeDescendants: 'false' })
  const response = await client.openDownload('/api/session.export?' + query)
  if (!response.headers.get('content-type')?.includes('application/zip') || !response.body) {
    await response.body?.cancel()
    throw new RpcError('BAD_EXPORT', 'Session export did not return a ZIP stream.')
  }
  const reader = response.body.getReader()
  const decoder = exportCursorDecoder(sessionId, limits)
  let downloadedBytes = 0
  try {
    while (!decoder.complete) {
      const { done, value } = await reader.read()
      if (done) { decoder.push(new Uint8Array(), true); break }
      downloadedBytes += value.length
      if (downloadedBytes > maxDownloadBytes) throw new RpcError('EXPORT_LIMIT', 'Session export exceeds the configured download limit.')
      decoder.push(value)
    }
    return { ...decoder.result(), downloadedBytes }
  } finally {
    await reader.cancel()
  }
}

export function describePage(records, metadata, summary = {}) {
  let lastPrompt = null, lastResponse = null, lastFinalReply = null
  const events = records.map(record => record.event).filter(Boolean).sort((a, b) => a.seq - b.seq)
  const ends = new Map(events.filter(event => event.type === 'turn/end').map(event => [event.data.turn, event.data.reason?.kind]))
  if (metadata.lastTurnEnd) ends.set(metadata.lastTurnEnd.turn, metadata.lastTurnEnd.reason?.kind)
  for (const event of events) {
    const data = event.data || {}
    if (event.type === 'user/message' && data.source?.kind === 'user') {
      lastPrompt = { seq: event.seq, time: event.time, text: textOf(data.content), hasAttachments: data.content?.some(b => b.type !== 'text') || false }
    } else if (event.type === 'assistant/message') {
      const text = textOf(data.message?.content)
      if (!text) continue
      const toolCall = data.message.content.some(block => block.type === 'tool-call')
      const end = ends.get(data.turn)
      const kind = data.interrupted || (end && end !== 'completed') ? 'interrupted'
        : !toolCall && end === 'completed' ? 'final' : 'progress'
      lastResponse = { seq: event.seq, time: event.time, turn: data.turn, text, kind }
      if (kind === 'final') lastFinalReply = lastResponse
    }
  }
  const unfinished = metadata.lastTurnStart && (!metadata.lastTurnEnd || metadata.lastTurnStart.seq > metadata.lastTurnEnd.seq)
  const newestPromptAt = metadata.lastPromptAt ?? lastPrompt?.time ?? summary.projections?.values?.sessionListMetadata?.lastPromptAt ?? null
  const newestPromptSeq = metadata.lastPromptSeq ?? lastPrompt?.seq ?? null
  // Event times share milliseconds, so order by seq whenever the prompt's seq is known.
  const newerPrompt = newestPromptSeq !== null ? !lastResponse || newestPromptSeq > lastResponse.seq
    : newestPromptAt !== null && (!lastResponse || newestPromptAt > lastResponse.time)
  return {
    sessionId: summary.sessionId || metadata.header?.id,
    title: metadata.title ?? summary.projections?.values?.title ?? null,
    running: summary.running === true, blank: summary.blank === true,
    throughSeq: metadata.cursor,
    lastInteractionAt: (metadata.lastInteractionAt ?? Math.max(newestPromptAt || 0, lastResponse?.time || 0)) || null,
    lastPromptAt: newestPromptAt, lastPrompt, lastResponse, lastFinalReply,
    newerPromptWithoutResponse: newerPrompt,
    lastTurnStatus: unfinished ? (summary.running ? 'running' : 'unfinished') : metadata.lastTurnEnd?.reason?.kind || 'unknown',
    lastTurnEnd: metadata.lastTurnEnd || null,
  }
}

async function childAddress(client, parentSessionId, childSessionId) {
  const listing = await client.request('subagents/list', { parentSessionId })
  const entry = listing.entries?.find(item => item.kind === 'child' && item.id === childSessionId)
  if (!entry) throw new RpcError('NOT_FOUND', 'Session is not a direct subagent child of the named parent.')
  return {
    address: { kind: 'subagent', parentSessionId, childSessionId, mode: entry.mode },
    summary: { sessionId: childSessionId, running: entry.activity === 'running', blank: false,
      projections: { values: { title: entry.label ?? null } } },
  }
}

export async function readLastReply(client, sessionId, { maxMessages = 8, throughSeq, summary, parentSessionId, maxPages = 16, ...limits } = {}) {
  let address = { kind: 'session', sessionId }
  if (parentSessionId !== undefined) {
    ({ address, summary } = await childAddress(client, parentSessionId, sessionId))
  } else {
    if (!summary) {
      const listing = await client.request('session/list', { _request: {} })
      summary = listing.items.find(item => item.sessionId === sessionId)
    }
    if (!summary) throw new RpcError('NOT_FOUND', 'Session is absent from the current host list.')
    if (summary.origin === 'subagent') throw new RpcError('SUBAGENT_ADDRESS', 'Pass the parent session ID to read a subagent child.')
    if (summary.blank) return { sessionId, title: summary.projections?.values?.title ?? null, running: summary.running,
      blank: true, lastInteractionAt: null, lastPrompt: null, lastResponse: null, lastFinalReply: null, lastTurnStatus: 'blank' }
  }
  const metadata = throughSeq === undefined ? await committedCursor(client, sessionId, limits) : { cursor: throughSeq }
  if (parentSessionId !== undefined && metadata.header && metadata.header.parentSession !== parentSessionId) {
    throw new RpcError('BAD_EXPORT', 'Exported child log names a different parent session.')
  }
  const records = []
  let beforeSeq
  for (let page = 0; page < maxPages; page++) {
    const result = await client.request('session/page', { request: {
      address, throughSeq: metadata.cursor, maxMessages, stepDetail: 'collapsed',
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
    } })
    records.unshift(...result.records)
    const described = describePage(records, metadata, summary)
    if (described.lastFinalReply || !result.hasMore || result.records.length === 0) {
      return { ...described, cursorSource: throughSeq === undefined ? 'committed-export' : 'explicit-cut',
        snapshotAt: Date.now(), downloadedBytes: metadata.downloadedBytes, decodedBytes: metadata.decodedBytes }
    }
    const first = Math.min(...result.records.map(record => record.covers?.from ?? record.event.seq))
    if (beforeSeq !== undefined && first >= beforeSeq) throw new RpcError('BAD_PAGE', 'History cursor did not advance.')
    beforeSeq = first
  }
  return { ...describePage(records, metadata, summary), cursorSource: throughSeq === undefined ? 'committed-export' : 'explicit-cut',
    snapshotAt: Date.now(), note: records.some(record => record.event?.type === 'assistant/message')
      ? 'No completed reply found within the bounded history search.'
      : 'No assistant text found within the bounded history search.' }
}
