/**
 * Bank-contract and guard cases: the frozen shapes HarnessMM enforces.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseBank } from '../bank.js'
import { localGuard, receiptGuard } from '../guard.js'
import { POLICY, candidate, planText } from './harness.mjs'

const rootCallId = 'call_1'
const rootArguments = { command: 'echo root' }

function messageWith(text, toolCalls = [{ type: 'tool-call', id: rootCallId, name: 'terminal', arguments: JSON.stringify(rootArguments) }]) {
  return { role: 'assistant', content: [...(text ? [{ type: 'text', text }] : []), ...toolCalls] }
}

function parse(overrides = {}) {
  return parseBank({
    message: overrides.message ?? messageWith(planText(overrides.candidates ?? [candidate()])),
    plan: overrides.plan,
    policy: overrides.policy ?? POLICY,
    toolName: 'terminal',
    rootCallId,
    rootArguments,
  })
}

function rejects(fn, pattern) {
  assert.throws(fn, (error) => {
    assert.equal(error.name, 'BankContractError')
    assert.match(error.message, pattern)
    return true
  })
}

test('a turn without a bank parses as no bank', () => {
  assert.equal(parseBank({ message: messageWith('just reasoning'), policy: POLICY, toolName: 'terminal', rootCallId, rootArguments }), null)
})

test('a text bank parses and hashes stably', () => {
  const bank = parse()
  assert.equal(bank.source, 'text')
  assert.equal(bank.candidates.length, 1)
  assert.equal(bank.candidates[0].label, 'A')
  assert.equal(bank.candidates[0].after, 'root')
  assert.equal(bank.root.id, rootCallId)
  assert.match(bank.sha256, /^[a-f0-9]{64}$/)
  assert.equal(parse().sha256, bank.sha256)
})

test('the chisel_plan argument channel parses the same nodes', () => {
  const bank = parseBank({
    message: messageWith(''),
    plan: { candidates: [candidate({ arguments: { command: 'echo A' } })] },
    policy: POLICY,
    toolName: 'terminal',
    rootCallId,
    rootArguments,
  })
  assert.equal(bank.source, 'argument')
  assert.equal(bank.candidates[0].candidate_id, 'A')
})

test('both channels in one turn are rejected', () => {
  rejects(
    () => parseBank({ message: messageWith(planText([candidate()])), plan: [candidate()], policy: POLICY, toolName: 'terminal', rootCallId, rootArguments }),
    /exactly one channel/,
  )
})

test('two plan blocks in one turn are rejected', () => {
  rejects(() => parse({ message: messageWith(`${planText([candidate()])}${planText([])}`) }), /only one action bank/)
})

test('a malformed bank body is rejected', () => {
  rejects(() => parse({ message: messageWith('<CHISEL_PLAN>{not json</CHISEL_PLAN>'), candidates: [] }), /invalid JSON/)
})

test('candidate keys are closed', () => {
  rejects(() => parse({ candidates: [{ ...candidate(), extra: true }] }), /must contain exactly/)
})

test('labels are unique single letters', () => {
  rejects(() => parse({ candidates: [candidate(), candidate()] }), /Duplicate candidate_id/)
  rejects(() => parse({ candidates: [candidate({ candidate_id: 'AB' })] }), /candidate_id must be one of/)
})

test('predecessors and dependencies must already be declared', () => {
  rejects(() => parse({ candidates: [candidate({ predecessor_id: 'B' })] }), /predecessor_id/)
  rejects(() => parse({ candidates: [candidate({ dependency_ids: ['B'] })] }), /dependency_ids/)
})

test('guards are closed and every guard field must be declared', () => {
  rejects(() => parse({ candidates: [candidate({ guard: { code_correct: true } })] }), /guard must be a non-empty conjunction/)
  rejects(() => parse({ candidates: [candidate({ guard: { stdout_contains: 'PASS' } })] }), /must list stdout/)
  rejects(() => parse({ candidates: [candidate({ required_receipt_fields: ['exit'] })] }), /required_receipt_fields/)
})

test('candidate arguments are closed and may not repeat the root', () => {
  rejects(() => parse({ candidates: [candidate({ arguments: { command: 'echo A', env: {} } })] }), /fully literal/)
  rejects(() => parse({ candidates: [candidate({ arguments: { command: '' } })] }), /fully literal/)
  rejects(() => parse({ candidates: [candidate({ arguments: { command: 'echo ${SOMETHING}' } })] }), /unresolved placeholder/)
  rejects(() => parse({ candidates: [candidate({ arguments: { command: 'echo root' } })] }), /repeat the already executed native root/)
})

test('the candidate count is closed', () => {
  const many = Array.from({ length: 17 }, (_, index) => candidate({ candidate_id: 'ABCDEFGHIJKLMNOP'[index] }))
  rejects(() => parse({ candidates: many }), /closed candidate contract/)
})

test('the authoring turn needs exactly one root tool call', () => {
  const twoCalls = [
    { type: 'tool-call', id: rootCallId, name: 'terminal', arguments: JSON.stringify(rootArguments) },
    { type: 'tool-call', id: 'call_2', name: 'read', arguments: '{}' },
  ]
  rejects(() => parse({ message: messageWith(planText([candidate()]), twoCalls) }), /exactly one registered native root/)
})

test('localGuard reads only observed receipts', () => {
  const receipt = (value, isError = false) => ({ is_error: isError, value: { native_text: JSON.stringify(value) } })
  const node = { guard: { return_code: 0, stdout_contains: 'PASS' }, required_receipt_fields: ['return_code', 'stdout'] }
  assert.equal(localGuard(node, receipt({ return_code: 0, stdout: 'ok PASS', stderr: null })).eligible, true)
  assert.equal(localGuard(node, receipt({ return_code: 0, stdout: 'nope', stderr: null })).eligible, false)
  assert.equal(localGuard(node, receipt({ return_code: 0, stdout: 'nope', stderr: null })).reason, 'guard_false')
  assert.equal(localGuard(node, receipt({ return_code: 0, stdout: 'PASS' }, true)).known, true)
  assert.equal(localGuard(node, receipt({ return_code: 0, stdout: 'PASS' }, true)).reason, 'native_error')
  assert.equal(localGuard(node, { is_error: false, value: { native_text: 'not json' } }).known, false)
  assert.equal(localGuard(node, { is_error: false, value: { native_text: '{"return_code":0}' } }).known, false)
  assert.equal(localGuard(node, receipt({ return_code: 0, stdout: 'PASS', stderr: '' })).eligible, true)
})

test('stderr_empty and json_equals are conjunctive', () => {
  const receipt = (value) => ({ is_error: false, value: { native_text: JSON.stringify(value) } })
  const stderrNode = { guard: { stderr_empty: true }, required_receipt_fields: ['stderr'] }
  assert.equal(localGuard(stderrNode, receipt({ return_code: 0, stdout: '', stderr: '' })).eligible, true)
  assert.equal(localGuard(stderrNode, receipt({ return_code: 0, stdout: '', stderr: 'warn' })).eligible, false)
  const jsonNode = { guard: { json_equals: { path: ['result', 'ok'], value: true } }, required_receipt_fields: ['stdout'] }
  assert.equal(localGuard(jsonNode, receipt({ return_code: 0, stdout: '{"result":{"ok":true}}', stderr: null })).eligible, true)
  assert.equal(localGuard(jsonNode, receipt({ return_code: 0, stdout: '{"result":{"ok":false}}', stderr: null })).eligible, false)
  assert.equal(localGuard(jsonNode, receipt({ return_code: 0, stdout: '{"result":{"ok":true}}', stderr: null })).fields.stdout, '{"result":{"ok":true}}')
})

test('a v5 condition string guard still decodes', () => {
  const receipt = { is_error: false, value: { native_text: JSON.stringify({ return_code: 0, stdout: 'PASS' }) } }
  assert.equal(receiptGuard('{"return_code":0,"stdout_contains":"PASS"}', receipt).eligible, true)
  assert.equal(receiptGuard('{"return_code":1}', receipt).eligible, false)
  assert.equal(receiptGuard('not json', receipt).known, false)
})
