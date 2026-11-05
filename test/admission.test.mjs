/**
 * Admission arithmetic and substitution certificates.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { admit, deterministicAdmission, normalizePriors } from '../admission.js'
import { SubstitutionController } from '../controller.js'
import { POLICY } from './harness.mjs'

const receiptValue = (value) => ({ call_id: 'call_1', is_error: false, status: 'PARSED', value: { native_text: JSON.stringify(value) } })
const okReceipt = receiptValue({ return_code: 0, stdout: 'PASS done', stderr: null })

function candidateNode(label, overrides = {}) {
  const node = {
    candidate_id: label,
    predecessor_id: 'root',
    tool: 'terminal',
    arguments: { command: `echo ${label}` },
    guard: { return_code: 0 },
    required_receipt_fields: ['return_code'],
    expected_local_cost: { selector_upper_tokens: 2048 },
    dependency_ids: [],
    ...overrides,
  }
  return { ...node, label, after: 'root', condition: JSON.stringify(node.guard), node }
}

function state(candidates, results = [okReceipt]) {
  return { public_user_requests: [{ role: 'user', content: [{ type: 'text', text: 'run the checks' }] }], candidates, public_results: results }
}

test('a single eligible candidate is admitted deterministically', () => {
  const result = deterministicAdmission(state([candidateNode('A')]), 12000, true)
  assert.equal(result.eligible.length, 1)
  assert.equal(result.eligible[0].reason, 'admitted')
  assert.equal(result.eligible[0].estimated_net_saving, 12000)
  assert.equal(result.threshold_tokens, 1024)
})

test('the net-saving threshold refuses a fast path that cannot pay for itself', () => {
  const result = deterministicAdmission(state([candidateNode('A')]), 500, true)
  assert.equal(result.eligible.length, 0)
  assert.equal(result.rejected[0].reason, 'net_saving_threshold')
})

test('a false guard and a failing receipt both refuse admission', () => {
  const falseGuard = deterministicAdmission(
    state([candidateNode('A', { guard: { stdout_contains: 'NEVER' }, required_receipt_fields: ['stdout'] })]),
    12000,
    true,
  )
  assert.equal(falseGuard.rejected[0].reason, 'guard_false')
  const errorReceipt = {
    call_id: 'call_1',
    is_error: true,
    status: 'PARSED',
    value: { native_text: JSON.stringify({ return_code: 1, stdout: '', stderr: 'boom' }) },
  }
  const failed = deterministicAdmission(state([candidateNode('A')], [errorReceipt]), 12000, true)
  assert.equal(failed.rejected[0].reason, 'native_error')
})

test('an unexecuted dependency refuses admission', () => {
  const first = candidateNode('A')
  const dependent = candidateNode('B', { predecessor_id: 'A', dependency_ids: ['A'] })
  const result = deterministicAdmission(state([first, dependent]), 12000, true)
  assert.equal(result.rejected.find((item) => item.candidate.label === 'B').reason, 'dependency_missing')
})

test('version 6 commits the one eligible successor without a selector', async () => {
  const events = []
  const controller = new SubstitutionController({ policy: { ...POLICY, version: 6 }, record: (event) => events.push(event) })
  const bank = { sha256: 'a'.repeat(64), root: { id: 'call_1' }, candidates: [] }
  controller.ownSlowCall('call_1', 12000)
  controller.noteBank(bank, 'call_1')
  controller.beginBoundary('call_1', undefined)
  controller.precede('call_1')
  const decision = await controller.decide(bank, state([candidateNode('A')]))
  assert.equal(decision.kind, 'commit')
  assert.equal(decision.deterministic, true)
  assert.equal(decision.candidate.label, 'A')
  assert.equal(decision.call.id, `chisel_${'a'.repeat(24)}_A`)
  assert.equal(events.some((event) => event.kind === 'sar/deterministic-commit'), true)

  controller.observeTool({
    call_id: decision.call.id,
    name: decision.call.name,
    arguments: JSON.parse(decision.call.arguments),
    result: { observation: JSON.stringify({ return_code: 0, stdout: 'ok', stderr: null }) },
  })
  const certificate = events.find((event) => event.kind === 'sar/substitution-certificate')
  assert.equal(certificate.schema, 'certified-native-substitution/v1')
  assert.equal(certificate.candidate_id, 'A')
  assert.equal(certificate.bypassed_slow_callback_id, 'call_1:omitted:1')
  assert.equal(certificate.predecessor_callback_id, 'call_1')
  assert.equal(certificate.valid_substitution, true)
  assert.equal(certificate.slow_requests_at_boundary, 0)
})

test('several eligible successors need a selector, and an abstention returns to slow', async () => {
  const events = []
  const controller = new SubstitutionController({ policy: POLICY, record: (event) => events.push(event) })
  const bank = { sha256: 'b'.repeat(64), root: { id: 'call_1' }, candidates: [] }
  controller.beginBoundary('call_1', undefined)
  const abstained = await controller.decide(bank, state([candidateNode('A'), candidateNode('B')]))
  assert.equal(abstained.kind, 'slow')
  assert.equal(abstained.reason, 'selector_unavailable')
})

test('the selector may only pick a label it was given', async () => {
  const events = []
  const controller = new SubstitutionController({
    policy: POLICY,
    record: (event) => events.push(event),
    select: async (input) => ({ label: input.labels.includes('B') ? 'B' : '?', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }),
  })
  const bank = { sha256: 'c'.repeat(64), root: { id: 'call_1' }, candidates: [] }
  controller.beginBoundary('call_1', undefined)
  const decision = await controller.decide(bank, state([candidateNode('A'), candidateNode('B')]))
  assert.equal(decision.kind, 'commit')
  assert.equal(decision.candidate.label, 'B')
  assert.equal(decision.deterministic, false)
  assert.equal(events.some((event) => event.kind === 'jev/request'), true)
  assert.equal(events.some((event) => event.kind === 'jev/decision'), true)
})

test('an intervening slow request invalidates a substitution', async () => {
  const controller = new SubstitutionController({ policy: POLICY, record: () => {} })
  const bank = { sha256: 'd'.repeat(64), root: { id: 'call_1' }, candidates: [] }
  controller.beginBoundary('call_1', undefined)
  const decision = await controller.decide(bank, state([candidateNode('A')]))
  controller.ownSlowCall('call_2', 10)
  assert.throws(
    () =>
      controller.observeTool({
        call_id: decision.call.id,
        name: decision.call.name,
        arguments: JSON.parse(decision.call.arguments),
        result: { observation: '{}' },
      }),
    /intervening slow request/,
  )
})

test('an oversized public state defers instead of paying for a selector', async () => {
  const events = []
  const controller = new SubstitutionController({ policy: { ...POLICY, version: 8, maximum_public_bytes: 1024 }, record: (event) => events.push(event), priors: null })
  const bank = { sha256: 'e'.repeat(64), root: { id: 'call_1' }, candidates: [] }
  const big = candidateNode('A', { arguments: { command: `echo ${'x'.repeat(2000)}` } })
  const decision = await controller.decide(bank, state([big]))
  assert.equal(decision.kind, 'slow')
  assert.equal(events.some((event) => event.kind === 'sar/defer' && event.reason === 'public_state_too_large'), true)
})

test('the priors path fails closed without a frozen TRAIN median', () => {
  const withoutPriors = admit(state([candidateNode('A', { arguments: { command: 'ls -la' } })]), null, 'task', true)
  assert.equal(withoutPriors.eligible.length, 0)
  assert.equal(withoutPriors.rejected[0].reason, 'missing_train_estimate')
})

test('the priors path admits a literal inspect action under the quarter rule', () => {
  const priors = normalizePriors({ phase: 'train', categories: { inspect: { phase: 'train', median_tokens: 20000 } } })
  const result = admit(state([candidateNode('A', { arguments: { command: 'ls -la' } })]), priors, 'task', true)
  assert.equal(result.eligible.length, 1)
  assert.equal(result.eligible[0].type, 'inspect')
  assert.equal(result.fastUpper * 4 <= 20000, true)
})

test('priors validation is closed', () => {
  assert.equal(normalizePriors(null), null)
  assert.throws(() => normalizePriors({ phase: 'test', categories: {} }), /phase must be "train"/)
  assert.throws(() => normalizePriors({ phase: 'train', categories: { inspect: { phase: 'train', median_tokens: 0 } } }), /median_tokens/)
})
