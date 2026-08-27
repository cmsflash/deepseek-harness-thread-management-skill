#!/usr/bin/env node
import { createRequire } from 'module'
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const DSH_ROOT = process.env.DSH_ROOT ?? '/Users/zhuoran/Programs/deepseek-harness'
const WS_REQUIRE_PATH = join(DSH_ROOT, 'packages/client/connection/package.json')

function fail(message, code) {
  console.error(message)
  process.exit(code)
}

function usage() {
  fail(
    'usage: respond.mjs <sessionId> [--list] [--wait-seconds 3] [--url ws://...]\n'
    + '       respond.mjs <sessionId> --approve <approvalId> [allowed-once|rejected]\n'
    + '       respond.mjs <sessionId> --answer \'<answers json>\'   # e.g. \'[{"id":"color","selected":["Red"]}]\'\n'
    + '\n'
    + 'Connects to the mux stream, collects still-pending approval/question frames\n'
    + 'replayed on open (the refresh-recovery baseline), prints them, and optionally\n'
    + 'answers one through POST /api/respond.',
    5,
  )
}

const argv = process.argv.slice(2)
const sessionId = argv.shift()
if (sessionId === undefined || sessionId.startsWith('-')) usage()

let mode = 'list'
let approvalId = undefined
let outcome = 'allowed-once'
let answerJson = undefined
let waitSeconds = 3
let url = 'ws://127.0.0.1:3080/api/events.mux'
for (let i = 0; i < argv.length; i += 1) {
  const flag = argv[i]
  const next = argv[i + 1]
  if (flag === '--list') mode = 'list'
  else if (flag === '--wait-seconds') { waitSeconds = Number(next); i += 1 }
  else if (flag === '--url') { url = next; i += 1 }
  else if (flag === '--approve') { mode = 'approve'; approvalId = next; i += 1; const o = argv[i + 1]; if (o === 'allowed-once' || o === 'rejected') { outcome = o; i += 1 } }
  else if (flag === '--answer') { mode = 'answer'; answerJson = next; i += 1 }
  else fail(`unknown flag: ${flag}`, 5)
}

function discoverPort() {
  try {
    const out = execSync('lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep "node.*bin.js --profile web"', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.match(/:(\d+)\s+\(LISTEN\)/)?.[1] ?? null
  } catch {
    return null
  }
}

if (url === 'ws://127.0.0.1:3080/api/events.mux') {
  const port = discoverPort()
  if (port !== null && port !== '3080') url = `ws://127.0.0.1:${port}/api/events.mux`
}

if (!existsSync(WS_REQUIRE_PATH)) fail(`ws not found: ${WS_REQUIRE_PATH} does not exist (set DSH_ROOT)`, 3)
const { WebSocket } = createRequire(WS_REQUIRE_PATH)('ws')

const ws = new WebSocket(url)
const approvals = []
const questions = []
let answered = false

const timer = setTimeout(async () => {
  if (answered) return
  finish()
}, waitSeconds * 1000)

async function finish() {
  clearTimeout(timer)
  ws.close()
  if (mode === 'list') {
    if (approvals.length === 0 && questions.length === 0) {
      console.log(`no pending approvals or questions for ${sessionId}`)
      process.exit(1)
    }
    for (const a of approvals) {
      console.log(`approval  rpcId=${a.rpcId}  approvalId=${a.approvalId}  tool=${a.toolName ?? '?'}${a.reason ? `\n  reason: ${a.reason}` : ''}`)
    }
    for (const q of questions) {
      console.log(`question  rpcId=${q.rpcId}  ${q.questions.length} question(s)`)
      for (const item of q.questions) {
        const options = (item.options ?? []).map(option => option.label).join(' | ')
        console.log(`  id=${item.id}${item.multiSelect ? ' (multi)' : ''} ${item.question ?? ''}\n    options: ${options}`)
      }
    }
    process.exit(0)
  }
  if (mode === 'approve') {
    const target = approvals.find(a => a.approvalId === approvalId)
    if (target === undefined) fail(`no pending approval ${approvalId} for ${sessionId} (is it still pending?)`, 1)
    const body = JSON.stringify({
      type: 'client-response',
      rpcId: target.rpcId,
      result: { ok: true, value: { sessionId, approvalId, outcome } },
    })
    const response = await fetch(url.replace(/^ws/, 'http').replace(/\/events\.mux$/, '/respond'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    })
    const receipt = await response.json()
    console.log(`respond receipt: ${JSON.stringify(receipt)}`)
    process.exit(receipt.accepted === true ? 0 : 1)
  }
  if (mode === 'answer') {
    const target = questions[0]
    if (target === undefined) fail(`no pending question for ${sessionId}`, 1)
    let answers
    try {
      answers = JSON.parse(answerJson)
    } catch (error) {
      fail(`--answer is not valid JSON: ${error.message}`, 5)
    }
    const body = JSON.stringify({
      type: 'client-response',
      rpcId: target.rpcId,
      result: { ok: true, value: { sessionId, answer: { answers } } },
    })
    const response = await fetch(url.replace(/^ws/, 'http').replace(/\/events\.mux$/, '/respond'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    })
    const receipt = await response.json()
    console.log(`respond receipt: ${JSON.stringify(receipt)}`)
    process.exit(receipt.accepted === true ? 0 : 1)
  }
}

ws.on('message', raw => {
  try {
    const frame = JSON.parse(raw.toString())
    const payload = frame.payload ?? frame
    if (payload.sessionId !== sessionId) return
    if (payload.type === 'approval/requested') {
      approvals.push({ rpcId: frame.rpcId, approvalId: payload.approvalId, toolName: payload.toolName, reason: payload.reason })
      if (mode === 'approve' && payload.approvalId === approvalId) { answered = true; finish() }
    } else if (payload.type === 'question/requested') {
      questions.push({ rpcId: frame.rpcId, questions: payload.questions ?? [] })
      if (mode === 'answer') { answered = true; finish() }
    }
  } catch {
    /* control frame */
  }
})
ws.on('error', error => { clearTimeout(timer); fail(`stream error: ${error.message}`, 3) })
ws.on('close', () => { if (!answered) { clearTimeout(timer) } })
