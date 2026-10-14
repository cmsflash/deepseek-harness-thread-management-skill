import { RpcError } from './rpc-client.mjs'

function outgoing(endpoint, request) {
  if (endpoint === 'session/prompt') return [request?.sessionId, request?.content]
  if (endpoint === 'subagents/prompt') return [request?.childSessionId, request?.content]
  if (endpoint === 'session/updateQueue' && request?.action?.kind === 'edit') return [request.sessionId, request.action.content]
  return undefined
}

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

export async function checkAgentHeader(client, endpoint, args, sourceId) {
  const message = outgoing(endpoint, args?.request)
  if (!message || !sourceId) return
  const [targetId, content] = message
  const { items } = await client.request('session/list', { _request: {} })
  if (!items.some(item => item.sessionId === targetId)) {
    throw new RpcError('UNKNOWN_TARGET', `Nothing was sent. ${targetId} is not in this Host's session/list.`)
  }
  const titleOf = id => items.find(item => item.sessionId === id)?.projections?.values?.title || undefined
  const [sourceTitle, targetTitle] = [titleOf(sourceId), titleOf(targetId)]
  const [line1 = '', line2, line3 = ''] = content?.[0]?.type === 'text' ? content[0].text.split('\n') : []
  const match = new RegExp(`^\\[agent-drafted: (.+) \\(${escape(sourceId)}\\) -> (.+) \\(${escape(targetId)}\\)\\]$`, 'u').exec(line1)
  // session/list has no title for an untitled thread or a source thread on another Host; any non-empty text passes there.
  const fits = (got, want) => got.trim() !== '' && (want === undefined || got === want)
  if (!match || !fits(match[1], sourceTitle) || !fits(match[2], targetTitle) || line2 !== '' || line3.trim() === '') {
    const expected = `[agent-drafted: ${sourceTitle ?? '<your thread title>'} (${sourceId}) -> ${targetTitle ?? '<target title>'} (${targetId})]`
    throw new RpcError('BAD_HEADER', `Nothing was sent. Line 1 of the first content block must be exactly\n${expected}\nLine 2 must be empty, and the message starts on line 3.`)
  }
}
