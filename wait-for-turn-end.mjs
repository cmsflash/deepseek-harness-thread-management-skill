#!/usr/bin/env node
/**
 * Wait for one DSH session's turn to end by watching the host's all-session
 * mux event stream (`/api/events.mux`, a WebSocket downlink).
 *
 * Exit codes: 0 = saw turn/end; 2 = timeout; 3 = stream error;
 * 4 = stream closed without the event. Each prints one actionable line.
 *
 * The `ws` dependency is resolved from the deepseek-harness repo's
 * node_modules; set DSH_ROOT to override the checkout location.
 */
import { createRequire } from 'module'
import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

const DSH_ROOT = process.env.DSH_ROOT ?? '/Users/zhuoran/Programs/deepseek-harness'
const WS_REQUIRE_PATH = join(DSH_ROOT, 'packages/client/connection/package.json')

function fail(message, code) {
  console.error(message)
  process.exit(code)
}

function parseArgs(argv) {
  const args = { session: undefined, timeoutMin: 30, url: 'ws://127.0.0.1:3080/api/events.mux' }
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--session') args.session = value
    else if (flag === '--timeout-min') args.timeoutMin = Number(value)
    else if (flag === '--url') args.url = value
    else fail(`unknown flag: ${flag}`, 5)
  }
  if (args.session === undefined) fail('usage: wait-for-turn-end.mjs --session <sessionId> [--timeout-min 30] [--url ws://...]', 5)
  if (!Number.isFinite(args.timeoutMin) || args.timeoutMin <= 0) fail('--timeout-min must be a positive number', 5)
  return args
}

/** Discover the web server's port from the running dsh process when the default is wrong. */
function discoverPort() {
  try {
    const out = execSync('lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep "node.*bin.js --profile web"', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const port = out.match(/:(\d+)\s+\(LISTEN\)/)?.[1]
    return port ?? null
  } catch {
    return null
  }
}

const args = parseArgs(process.argv.slice(2))

if (!existsSync(WS_REQUIRE_PATH)) {
  fail(`ws not found: ${WS_REQUIRE_PATH} does not exist (set DSH_ROOT)`, 3)
}
const { WebSocket } = createRequire(WS_REQUIRE_PATH)('ws')

let url = args.url
if (url === 'ws://127.0.0.1:3080/api/events.mux') {
  const port = discoverPort()
  if (port !== null && port !== '3080') url = `ws://127.0.0.1:${port}/api/events.mux`
}

const started = Date.now()
const timeoutMs = args.timeoutMin * 60_000

const ws = new WebSocket(url)
const timer = setTimeout(() => {
  console.log(`timeout after ${args.timeoutMin} min without turn/end for ${args.session}`)
  console.log('re-check the session running state before re-arming; the turn may have ended during the window')
  process.exit(2)
}, timeoutMs)

ws.on('open', () => {
  console.log(`watching ${args.session} on ${url}`)
})

ws.on('message', raw => {
  try {
    const frame = JSON.parse(raw.toString())
    const payload = frame.payload ?? frame
    if (payload.sessionId !== args.session || payload.type !== 'session/event') return
    const event = payload.event
    if (event?.type === 'turn/end') {
      clearTimeout(timer)
      console.log(`turn/end at ${new Date().toISOString()} (waited ${Math.round((Date.now() - started) / 1000)}s)`)
      ws.close()
      process.exit(0)
    }
  } catch {
    /* non-JSON control frame */
  }
})

ws.on('error', error => {
  clearTimeout(timer)
  console.error(`stream error: ${error.message}`)
  process.exit(3)
})

ws.on('close', () => {
  clearTimeout(timer)
  console.error('stream closed without turn/end')
  process.exit(4)
})
