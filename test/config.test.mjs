/**
 * Config validation, prompt text and ledger reporting.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveConfig } from '../index.js'
import { Ledger, substitutions, summaryText } from '../ledger.js'
import { planInstruction } from '../policy.js'

test('the default configuration is the frozen v6 deterministic policy', () => {
  const config = resolveConfig({})
  assert.equal(config.enabled, true)
  assert.equal(config.policy.version, 6)
  assert.equal(config.policy.maximum_candidates, 16)
  assert.equal(config.policy.maximum_fast_steps, 8)
  assert.equal(config.policy.maximum_public_bytes, 65536)
  assert.equal(config.shellTool, '')
  assert.equal(config.maxReceiptBytes, 8192)
  assert.deepEqual(config.selector, { enabled: true, maxTokens: 256, temperature: 0, provider: '', model: '' })
  assert.equal(config.priors, null)
})

test('unknown keys and out-of-range limits are configuration errors', () => {
  assert.throws(() => resolveConfig({ nope: true }), /unknown config key/)
  assert.throws(() => resolveConfig({ selector: { nope: 1 } }), /unknown selector key/)
  assert.throws(() => resolveConfig({ policy: { version: 5, maximum_candidates: 16, maximum_fast_steps: 8, maximum_public_bytes: 65536 } }), /policy.version/)
  assert.throws(
    () => resolveConfig({ policy: { version: 6, maximum_candidates: 17, maximum_fast_steps: 8, maximum_public_bytes: 65536 } }),
    /maximum_candidates/,
  )
  assert.throws(() => resolveConfig({ maxReceiptBytes: 10 }), /maxReceiptBytes/)
  assert.throws(() => resolveConfig({ selector: { maxTokens: 0 } }), /selector.maxTokens/)
  assert.throws(() => resolveConfig({ priors: { phase: 'test', categories: {} } }), /phase/)
})

test('the authoring instruction names the tool, the letters and the guard keys', () => {
  const text = planInstruction(resolveConfig({}).policy, 'terminal')
  assert.match(text, /HarnessMM guarded decision reuse is active/)
  assert.match(text, /chisel_plan/)
  assert.match(text, /<CHISEL_PLAN>/)
  assert.match(text, /A\.\.P/)
  for (const key of ['return_code', 'stdout_contains', 'stdout_equals', 'stderr_empty', 'json_equals']) {
    assert.match(text, new RegExp(key))
  }
  assert.match(text, /may not repeat the root command/)
})

test('the ledger summarizes the upstream event kinds', () => {
  const ledger = new Ledger()
  ledger.record('s1', { kind: 'sar/slow-call', tokens: 1200 })
  ledger.record('s1', { kind: 'sar/bank-authored', bank_sha256: 'a'.repeat(64), candidates: 2 })
  ledger.record('s1', { kind: 'sar/substitution-certificate', candidate_id: 'A' })
  ledger.record('s1', { kind: 'sar/substitution-certificate', candidate_id: 'B' })
  ledger.record('s1', { kind: 'sar/defer', reason: 'bank_exhausted' })
  ledger.record('s1', { kind: 'jev/decision', usage: { totalTokens: 3 } })
  ledger.record('s1', { kind: 'jev/slow-fallback' })
  ledger.record('s1', { kind: 'harnessmm/run', outcome: 'completed' })
  const summary = ledger.summary('s1')
  assert.equal(summary.runs, 1)
  assert.equal(summary.banks_authored, 1)
  assert.equal(summary.certified_substitutions, 2)
  assert.equal(summary.deferred, 1)
  assert.equal(summary.selector_abstentions, 1)
  assert.equal(summary.slow_tokens, 1200)
  assert.equal(summary.selector_tokens, 3)
  assert.deepEqual(summary.last_candidates, ['A', 'B'])

  const text = summaryText(summary, resolveConfig({}).policy)
  assert.match(text, /harnessmm policy v6/)
  assert.match(text, /certified substitutions: 2/)

  const overview = ledger.overview()
  assert.equal(overview.sessions.length, 1)
  assert.equal(overview.totals.certified_substitutions, 2)
  ledger.clear('s1')
  assert.equal(ledger.sessionIds().length, 0)
})

test('the ledger is bounded per session', () => {
  const ledger = new Ledger({ limit: 3 })
  for (let index = 0; index < 10; index++) ledger.record('s1', { kind: 'sar/no-bank', index })
  assert.equal(ledger.events('s1').length, 3)
  assert.equal(ledger.events('s1').at(-1).index, 9)
})

test('the savings walk attributes selector spend to the substitution it enabled', () => {
  const ledger = new Ledger()
  ledger.record('s1', { kind: 'sar/slow-call', tokens: 5000 })
  ledger.record('s1', { kind: 'jev/decision', usage: { totalTokens: 120 } })
  ledger.record('s1', {
    kind: 'sar/substitution-certificate',
    candidate_id: 'A',
    exact_native_tool: 'terminal',
    exact_arguments: { command: 'npm test' },
    native_receipt: { observation: JSON.stringify({ return_code: 0, stdout: 'PASS\n2 tests', stderr: null }) },
    guard: { return_code: 0, stdout_contains: 'PASS' },
    bypassed_slow_callback_id: 'call_1:omitted:1',
  })
  ledger.record('s1', { kind: 'jev/decision', usage: { totalTokens: 80 } })
  ledger.record('s1', { kind: 'jev/slow-fallback' })
  ledger.record('s1', { kind: 'sar/slow-call', tokens: 4000 })
  ledger.record('s1', {
    kind: 'sar/substitution-certificate',
    candidate_id: 'B',
    exact_native_tool: 'terminal',
    exact_arguments: { command: 'node smoke.js' },
    native_receipt: { observation: JSON.stringify({ return_code: 0, stdout: 'ok', stderr: null }) },
    guard: { return_code: 0 },
    bypassed_slow_callback_id: 'call_1:omitted:2',
  })
  const summary = ledger.summary('s1')
  assert.equal(summary.estimated_saved_tokens, (5000 - 120) + 4000)
  assert.equal(summary.selector_tokens_lost, 80)
  assert.equal(summary.selector_tokens, 200)

  const rows = substitutions(ledger.events('s1'))
  assert.equal(rows.length, 2)
  assert.equal(rows[0].command, 'npm test')
  assert.equal(rows[0].return_code, 0)
  assert.match(rows[0].stdout, /PASS/)
  assert.equal(rows[0].slow_tokens, 5000)
  assert.equal(rows[0].selector_tokens, 120)
  assert.equal(rows[0].saved_tokens, 4880)
  assert.equal(rows[1].selector_tokens, 0)
  assert.equal(rows[1].saved_tokens, 4000)
})

test('the savings walk stays at zero without a session log instead of inventing numbers', () => {
  const ledger = new Ledger()
  ledger.record('s1', { kind: 'sar/slow-call', tokens: 0 })
  ledger.record('s1', { kind: 'sar/substitution-certificate', candidate_id: 'A' })
  const summary = ledger.summary('s1')
  assert.equal(summary.estimated_saved_tokens, 0)
  assert.equal(substitutions(ledger.events('s1'))[0].saved_tokens, 0)
})

test('a fallback before any certificate never counts as saved', () => {
  const ledger = new Ledger()
  ledger.record('s1', { kind: 'sar/slow-call', tokens: 9000 })
  ledger.record('s1', { kind: 'jev/decision', usage: { totalTokens: 60 } })
  ledger.record('s1', { kind: 'jev/slow-fallback' })
  const summary = ledger.summary('s1')
  assert.equal(summary.estimated_saved_tokens, 0)
  assert.equal(summary.selector_tokens_lost, 60)
})
