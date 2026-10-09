import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('../scripts/count-active-sessions.py', import.meta.url))

test('counting excludes archived/unowned logs and recognizes versioned generations once', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-count-test-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const registry = join(home, 'storages/workspace.json')
  await mkdir(dirname(registry), { recursive: true })
  await writeFile(registry, JSON.stringify({ global: { workspaceIds: ['a', 'b'], archivedSessionIds: ['archived', 'unowned-archive'] },
    tables: { workspaces: { a: { title: 'A', sessionIds: ['active', 'archived', 'not-yet-persisted'] },
      b: { title: 'B', sessionIds: ['active2'] } } } }))
  for (const [id, file] of [['active', 'session.jsonl.zst'], ['active', 'session.v3.jsonl.zst'],
    ['active2', 'session.v3.jsonl.zst'], ['archived', 'session.v3.jsonl.zst'], ['hidden-child', 'session.v3.jsonl.zst']]) {
    const path = join(home, 'sessions/workspace', id, file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '')
  }
  for (const [instant, expected] of [[Date.UTC(2026, 6, 1, 12), '2026-07-01 05:00:00 PDT'],
    [Date.UTC(2026, 0, 1, 12), '2026-01-01 04:00:00 PST']]) {
    await utimes(registry, instant / 1000, instant / 1000)
    const run = spawnSync('python3', [script, '--dsh-home', home, '--json'], {
      encoding: 'utf8', env: { ...process.env, TZ: 'UTC' },
    })
    assert.equal(run.status, 0, run.stderr)
    const result = JSON.parse(run.stdout)
    assert.equal(result.active, 3)
    assert.equal(result.owned, 4)
    assert.equal(result.archived_owned, 1)
    assert.equal(result.archived_without_owner, 1)
    assert.equal(result.logs_on_disk, 4)
    assert.equal(result.orphan_logs, 1)
    assert.equal(result.owned_without_log, 1)
    assert.equal(result.registry_mtime, expected)
  }
})
