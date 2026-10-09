import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const INPUT_LIMIT = 1024 * 1024
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

export class RpcError extends Error {
  constructor(code, message, status) {
    super(message)
    this.code = code
    this.status = status
  }
}

function loopbackUrl(value) {
  let url
  try { url = new URL(value) } catch {
    throw new RpcError('BAD_URL', 'Expected a loopback HTTP(S) URL.')
  }
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK.has(url.hostname)
    || url.username || url.password || url.hash || url.pathname !== '/') {
    throw new RpcError('BAD_URL', 'Expected a loopback HTTP(S) root URL without userinfo or fragment.')
  }
  return url
}

export function resolveOrigin(value = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080') {
  const url = loopbackUrl(value)
  if (url.search) throw new RpcError('BAD_URL', 'The base URL must not contain credentials or a query.')
  return url.origin
}

function endpointName(endpoint) {
  if (endpoint !== '$events' && !/^[\w$-]+(?:\/[\w$-]+)+$/u.test(endpoint)) {
    throw new RpcError('BAD_ENDPOINT', 'Use a current slash-separated Remote endpoint, such as session/list.')
  }
  return endpoint
}

function privateFile(stat) {
  return stat.isFile() && (stat.mode & 0o077) === 0
    && (typeof process.getuid !== 'function' || stat.uid === process.getuid())
}

async function boundedText(path, privateOnly = false) {
  let file
  try {
    file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > INPUT_LIMIT || (privateOnly && !privateFile(stat))) {
      throw new RpcError('UNSAFE_FILE', 'Input must be a regular file under 1 MiB; auth caches must be owner-only.')
    }
    const buffer = Buffer.alloc(INPUT_LIMIT + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > INPUT_LIMIT) throw new RpcError('UNSAFE_FILE', 'Input exceeds 1 MiB.')
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch (error) {
    if (error instanceof RpcError || error.code === 'ENOENT') throw error
    throw new RpcError('UNSAFE_FILE', 'Cannot safely read the input file; symlinks are not accepted.')
  } finally {
    await file?.close()
  }
}

export function webSocketLibrary() {
  const root = process.env.DSH_ROOT || '/Users/zhuoran/Programs/deepseek-harness'
  try { return createRequire(join(root, 'packages/api/gateway/package.json'))('ws') } catch {
    throw new RpcError('WS_UNAVAILABLE', 'Cannot load ws; set DSH_ROOT to an existing DSH checkout.')
  }
}

export class RpcClient {
  constructor({ baseUrl, authFile, timeoutMs = 30_000 } = {}) {
    this.origin = resolveOrigin(baseUrl)
    this.authFile = authFile || process.env.DSH_RPC_AUTH_FILE || join(
      homedir(), '.cache', 'dsh-thread-rpc',
      createHash('sha256').update(this.origin).digest('hex') + '.json',
    )
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RpcError('BAD_TIMEOUT', 'Timeout must be positive.')
    this.timeoutMs = timeoutMs
    this.secrets = new Set()
  }

  redact(text) {
    let safe = String(text)
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) {
      if (secret) safe = safe.replaceAll(secret, '[REDACTED]')
    }
    return safe.replace(/([?&]token=)[^\s&#"<>]+/giu, '$1[REDACTED]')
  }

  rememberCookie(cookie) {
    this.secrets.add(cookie)
    this.secrets.add(cookie.slice(cookie.indexOf('=') + 1))
  }

  launchUrl(value) {
    if (typeof value !== 'string' || Buffer.byteLength(value) > INPUT_LIMIT) {
      throw new RpcError('BAD_LAUNCH_URL', 'Startup URL must be text under 1 MiB.')
    }
    const url = loopbackUrl(value.trim())
    const tokens = url.searchParams.getAll('token')
    if (url.origin !== this.origin || tokens.length !== 1 || !tokens[0] || url.searchParams.size !== 1) {
      throw new RpcError('BAD_LAUNCH_URL', 'Use the current startup URL for this exact origin, with one token parameter.')
    }
    this.secrets.add(url.href)
    this.secrets.add(tokens[0])
    return url.href
  }

  async readAuth(allowExpired = false) {
    let record
    try { record = JSON.parse(await boundedText(this.authFile, true)) } catch (error) {
      if (error.code === 'ENOENT') throw new RpcError('AUTH_REQUIRED', 'No RPC login cached. Run rpc.mjs login first.')
      if (error instanceof RpcError) throw error
      throw new RpcError('BAD_CACHE', 'The RPC auth cache is not valid JSON.')
    }
    if (record?.version !== 1 || record.origin !== this.origin
      || typeof record.cookie !== 'string' || !/^dsh-auth-[\w-]+=[\w.~-]+$/u.test(record.cookie)
      || !Number.isSafeInteger(record.expiresAt)) {
      throw new RpcError('BAD_CACHE', 'The RPC auth cache is invalid or belongs to another origin.')
    }
    this.rememberCookie(record.cookie)
    if (!allowExpired && record.expiresAt <= Date.now()) {
      throw new RpcError('AUTH_REQUIRED', 'RPC login expired. Run rpc.mjs login with the current startup URL.')
    }
    return record
  }

  async saveAuth(record) {
    const directory = dirname(this.authFile)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const stat = await fs.lstat(directory)
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw new RpcError('UNSAFE_FILE', 'The auth-cache directory must be owner-only and not a symlink.')
    }
    try { await this.readAuth(true) } catch (error) {
      if (error.code !== 'AUTH_REQUIRED') throw error
    }
    const temporary = this.authFile + '.' + randomUUID() + '.tmp'
    try {
      await fs.writeFile(temporary, JSON.stringify(record) + '\n', { mode: 0o600, flag: 'wx' })
      await fs.rename(temporary, this.authFile)
    } finally {
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
  }

  async login(value) {
    const launchUrl = this.launchUrl(value)
    let response
    try {
      response = await fetch(launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) })
    } catch {
      throw new RpcError('CONNECTION_FAILED', `Could not reach the login endpoint at ${this.origin}.`)
    }
    const headers = response.headers.getSetCookie()
    const cookieHeader = headers.find(header => /^dsh-auth-/u.test(header))
    const location = response.headers.get('location')
    if (response.status !== 303 || location !== '/' || !cookieHeader || headers.length !== 1) {
      await response.body?.cancel()
      throw new RpcError('LOGIN_REJECTED', `Login exchange rejected (HTTP ${response.status}); use the current startup URL.`, response.status)
    }
    const cookie = cookieHeader.split(';', 1)[0]
    const maxAge = /(?:^|;)\s*Max-Age=(\d+)(?:;|$)/iu.exec(cookieHeader)
    const expiresAt = Date.now() + Number(maxAge?.[1]) * 1000
    if (!/^dsh-auth-[\w-]+=[\w.~-]+$/u.test(cookie) || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
      await response.body?.cancel()
      throw new RpcError('LOGIN_REJECTED', 'Login response did not contain a usable expiring DSH session cookie.')
    }
    this.rememberCookie(cookie)
    await response.body?.cancel()
    await this.saveAuth({ version: 1, origin: this.origin, cookie, expiresAt })
    return { origin: this.origin, authFile: this.authFile, expiresAt }
  }

  async loginFromFile(path) {
    return this.login(await boundedText(path))
  }

  async loginFromLog(path) {
    const text = await boundedText(path)
    let candidate
    for (const match of text.matchAll(/\bdsh web:\s+(https?:\/\/[^\s\x1b]+)/gu)) {
      try { candidate = this.launchUrl(match[1]) } catch (error) {
        if (!(error instanceof RpcError)) throw error
      }
    }
    if (!candidate) throw new RpcError('NO_LAUNCH_URL', 'No matching startup URL found; provide a launch-URL file instead.')
    return this.login(candidate)
  }

  async request(endpoint, args = {}) {
    endpointName(endpoint)
    const { cookie } = await this.readAuth()
    let response
    try {
      response = await fetch(`${this.origin}/api/${endpoint}`, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } }),
      })
    } catch {
      throw new RpcError('CONNECTION_FAILED', 'RPC delivery failed; outcome may be unknown. No retry was attempted.')
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new RpcError(response.status === 401 ? 'AUTH_REQUIRED' : 'HTTP_ERROR',
        `RPC returned HTTP ${response.status}. No retry was attempted.`, response.status)
    }
    let envelope
    try { envelope = await response.json() } catch {
      throw new RpcError('BAD_RESPONSE', 'RPC response was not JSON; outcome may be unknown. No retry was attempted.')
    }
    if (envelope?.result?.ok === false) {
      throw new RpcError(envelope.result.error?.code || 'RPC_ERROR', this.redact(envelope.result.error?.message || 'RPC failed.'))
    }
    if (envelope?.result?.ok !== true) throw new RpcError('BAD_RESPONSE', 'RPC response lacks a success/error receipt.')
    return envelope.result.value
  }

  async openDownload(path) {
    const url = new URL(path, this.origin)
    if (url.origin !== this.origin || !path.startsWith('/api/') || url.hash) {
      throw new RpcError('BAD_PATH', 'Downloads must use an API path on the configured origin.')
    }
    const { cookie } = await this.readAuth()
    let response
    try {
      response = await fetch(url, { headers: { cookie }, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) })
    } catch {
      throw new RpcError('CONNECTION_FAILED', 'Could not open the authenticated API download.')
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new RpcError(response.status === 401 ? 'AUTH_REQUIRED' : 'HTTP_ERROR', `API download returned HTTP ${response.status}.`, response.status)
    }
    return response
  }

  async probe() {
    try {
      const response = await fetch(this.origin, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) })
      await response.body?.cancel()
      return true
    } catch (error) {
      const cause = error.cause
      if (cause?.code === 'ECONNREFUSED'
        || (cause?.errors?.length && cause.errors.every(item => item.code === 'ECONNREFUSED'))) return false
      throw new RpcError('PROBE_UNCERTAIN', 'Cannot prove the host is stopped; refuse offline state changes.')
    }
  }

  async streamUntil(endpoint, args, accept, { timeoutMs = this.timeoutMs, signal } = {}) {
    endpointName(endpoint)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RpcError('BAD_TIMEOUT', 'Timeout must be positive.')
    const { cookie } = await this.readAuth()
    if (signal?.aborted) throw new RpcError('ABORTED', 'Remote stream observation cancelled.')
    const { WebSocket } = webSocketLibrary()
    const streamId = randomUUID()
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.origin.replace(/^http/u, 'ws') + '/api/remote.mux', {
        headers: { cookie }, followRedirects: false, handshakeTimeout: Math.min(timeoutMs, 10_000),
      })
      let settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', aborted)
        if (socket.readyState === WebSocket.CONNECTING) socket.terminate()
        else socket.close()
        if (error) reject(error)
        else resolve(value)
      }
      const aborted = () => finish(new RpcError('ABORTED', 'Remote stream observation cancelled.'))
      const timer = setTimeout(() => finish(new RpcError('TIMEOUT', 'Remote stream timed out before the expected item.')), timeoutMs)
      signal?.addEventListener('abort', aborted, { once: true })
      let processing = Promise.resolve()
      socket.on('open', () => {
        socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
      })
      socket.on('message', raw => {
        processing = processing.then(async () => {
          if (settled) return
          const frame = JSON.parse(raw.toString())
          if (frame.streamId !== streamId) return
          if (frame.type === 'error') finish(new RpcError(frame.error?.code || 'STREAM_ERROR', this.redact(frame.error?.message || 'Remote stream failed.')))
          else if (frame.type === 'end') finish(new RpcError('STREAM_ENDED', 'Remote stream ended before the expected item.'))
          else if (frame.type === 'item' && await accept(frame.value)) finish(undefined, frame.value)
        }).catch(error => {
          finish(error instanceof RpcError ? error : new RpcError('BAD_FRAME', 'Invalid Remote stream item or consumer failure.'))
        })
      })
      socket.on('unexpected-response', (request, response) => {
        response.resume()
        request.destroy()
        finish(new RpcError(response.statusCode === 401 ? 'AUTH_REQUIRED' : 'HTTP_ERROR',
          `Remote stream returned HTTP ${response.statusCode}.`, response.statusCode))
      })
      socket.on('error', () => finish(new RpcError('STREAM_ERROR', 'Remote WebSocket connection failed.')))
      socket.on('close', () => {
        processing.then(() => finish(new RpcError('STREAM_ENDED', 'Remote WebSocket closed before the expected item.')))
      })
    })
  }
}
