/**
 * Persistence: the ledger store mirrors events to JSONL, hydrates a restarted
 * ledger, groups sessions by project and survives malformed lines.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveConfig } from '../index.js'
import { Ledger } from '../ledger.js'
import { LedgerStore, resolveStoragePath } from '../store.js'

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), 'harnessmm-store-'))
  return { dir, file: join(dir, 'ledger.jsonl') }
}

test('the storage path defaults under $DSH_HOME and expands ~', () => {
  const env = { DSH_HOME: 'C:/dsh-home' }
  assert.equal(resolveStoragePath('', env), join('C:/dsh-home', 'storages', 'harnessmm', 'ledger.jsonl'))
  assert.equal(resolveStoragePath('~/custom/l.jsonl', env), join('C:/dsh-home', 'custom', 'l.jsonl'))
  assert.equal(resolveStoragePath('~/l.jsonl', env), join('C:/dsh-home', 'l.jsonl'))
  assert.equal(resolveStoragePath('C:/absolute/l.jsonl', env), 'C:/absolute/l.jsonl')
})

test('config accepts persist/storagePath and rejects bad values', () => {
  assert.equal(resolveConfig({}).persist, true)
  assert.equal(resolveConfig({}).storagePath, '')
  assert.equal(resolveConfig({ persist: false }).persist, false)
  assert.equal(resolveConfig({ storagePath: 'C:/x.jsonl' }).storagePath, 'C:/x.jsonl')
  assert.throws(() => resolveConfig({ persist: 'yes' }), /persist/)
  assert.throws(() => resolveConfig({ storagePath: 3 }), /storagePath/)
})

test('events persist across store instances and skip malformed lines', () => {
  const { dir, file } = tempFile()
  try {
    const store = new LedgerStore({ filePath: file })
    store.append('s1', { at: 1, kind: 'sar/slow-call', tokens: 1000, project: 'E:/p' })
    store.append('s1', { at: 2, kind: 'sar/substitution-certificate', candidate_id: 'A' })
    store.append('s2', { at: 3, kind: 'sar/slow-call', tokens: 2000 })
    // A torn write is skipped, not fatal.
    writeFileSync(file, readFileSync(file, 'utf8') + '{"broken"\n', 'utf8')

    const loaded = new LedgerStore({ filePath: file }).load()
    assert.deepEqual([...loaded.keys()].sort(), ['s1', 's2'])
    assert.equal(loaded.get('s1').length, 2)
    assert.equal(loaded.get('s1')[0].tokens, 1000)
    assert.equal(loaded.get('s2')[0].kind, 'sar/slow-call')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a restarted ledger hydrates history and groups it by project', () => {
  const { dir, file } = tempFile()
  try {
    const first = new Ledger({ store: new LedgerStore({ filePath: file }) })
    first.record('s1', { kind: 'sar/slow-call', tokens: 5000, project: 'E:/proj/a' })
    first.record('s1', { kind: 'sar/substitution-certificate', candidate_id: 'A' })
    first.record('s2', { kind: 'sar/slow-call', tokens: 3000, project: 'E:/proj/a' })
    first.record('s2', { kind: 'sar/substitution-certificate', candidate_id: 'B' })
    first.record('s3', { kind: 'sar/slow-call', tokens: 4000, project: 'E:/proj/b' })
    first.record('s3', { kind: 'sar/substitution-certificate', candidate_id: 'C' })

    const second = new Ledger({ store: new LedgerStore({ filePath: file }) })
    assert.deepEqual(second.sessionIds().sort(), ['s1', 's2', 's3'])
    assert.equal(second.summary('s1').estimated_saved_tokens, 5000)
    assert.equal(second.project('s1'), 'E:/proj/a')

    const overview = second.overview()
    assert.equal(overview.sessions.length, 3)
    assert.equal(overview.totals.certified_substitutions, 3)
    assert.equal(overview.totals.estimated_saved_tokens, 12000)
    const projects = overview.projects
    assert.equal(projects.length, 2)
    const a = projects.find((row) => row.project === 'E:/proj/a')
    assert.equal(a.sessions, 2)
    assert.equal(a.estimated_saved_tokens, 8000)
    assert.equal(projects[0].project, 'E:/proj/a') // sorted by saved tokens (8000 > 4000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('clearing one session rewrites only that session on disk', () => {
  const { dir, file } = tempFile()
  try {
    const store = new LedgerStore({ filePath: file })
    const ledger = new Ledger({ store })
    ledger.record('s1', { kind: 'sar/slow-call', tokens: 1 })
    ledger.record('s2', { kind: 'sar/slow-call', tokens: 2 })
    ledger.clear('s1')

    const reloaded = new Ledger({ store: new LedgerStore({ filePath: file }) })
    assert.deepEqual(reloaded.sessionIds(), ['s2'])
    assert.equal(reloaded.events('s1').length, 0)

    ledger.clearAll()
    const empty = new Ledger({ store: new LedgerStore({ filePath: file }) })
    assert.equal(empty.sessionIds().length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a ledger without a store stays memory-only', () => {
  const ledger = new Ledger()
  ledger.record('s1', { kind: 'sar/slow-call', tokens: 7 })
  assert.equal(ledger.summary('s1').slow_tokens, 7)
  assert.equal(ledger.overview().projects.length, 1)
})
