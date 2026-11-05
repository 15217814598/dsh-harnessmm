/**
 * End-to-end: the terminal tool over a fake dsh registry and session.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveConfig } from '../index.js'
import { Ledger } from '../ledger.js'
import { createSelectorFactory, parseSelectorAnswer } from '../selector.js'
import { createTerminalTool } from '../tools.js'
import { candidate, liveSignal, makeCtx, makeSession, makeShell, planText } from './harness.mjs'

function setup({ text = '', plan, responses = {}, usage, sessions = true, selector, llm, previousCallId } = {}) {
  const shell = makeShell(responses)
  const session = makeSession({ text, usage, previousCallId })
  const ctx = makeCtx({ tools: [shell.tool], sessions: sessions ? new Map([['session-1', session]]) : new Map(), llm })
  const config = resolveConfig({})
  const ledger = new Ledger()
  const shellTarget = {
    resolve: () => 'pwsh',
    peek: () => 'pwsh',
  }
  const tool = createTerminalTool({
    ctx,
    config,
    ledger,
    toolName: 'terminal',
    shell: shellTarget,
    selectFactory: selector,
  })
  const exec = { callId: 'call_1', name: 'terminal', arguments: {}, agent: { id: 'session-1' }, signal: liveSignal() }
  const run = (args) => tool.execute(args, exec)
  return { tool, ledger, run, shell, ctx, config }
}

test('the selector accepts one label with punctuation and abstains on prose', () => {
  assert.equal(parseSelectorAnswer('B', ['A', 'B']), 'B')
  assert.equal(parseSelectorAnswer('  B. ', ['A', 'B']), 'B')
  assert.equal(parseSelectorAnswer('B!', ['A', 'B']), 'B')
  assert.equal(parseSelectorAnswer('maybe A', ['A', 'B']), '?')
  assert.equal(parseSelectorAnswer('A and B', ['A', 'B']), '?')
  assert.equal(parseSelectorAnswer('', ['A', 'B']), '?')
  assert.equal(parseSelectorAnswer('E', ['A', 'B']), '?')
})

test('a plain call runs the root command only', async () => {
  const { run, ledger } = setup({ responses: { 'echo root': { exitCode: 0, stdout: 'root-ok' } } })
  const value = await run({ command: 'echo root' })
  assert.equal(value.outcome, 'plain')
  assert.equal(value.substitutions, 0)
  assert.equal(value.bank, null)
  assert.equal(value.receipts.length, 1)
  assert.equal(value.receipts[0].label, 'root')
  assert.equal(value.receipts[0].stdout, 'root-ok')
  const events = ledger.events('session-1')
  assert.equal(events.some((event) => event.kind === 'sar/no-bank'), true)
  assert.equal(events.some((event) => event.kind === 'harnessmm/run' && event.outcome === 'plain'), true)
})

test('a text bank runs its guarded chain and certifies every substitution', async () => {
  const bank = [
    candidate({ candidate_id: 'A', arguments: { command: 'echo A' } }),
    candidate({
      candidate_id: 'B',
      predecessor_id: 'A',
      arguments: { command: 'echo B' },
      guard: { stdout_contains: 'ran: echo A' },
      required_receipt_fields: ['stdout'],
      dependency_ids: ['A'],
    }),
  ]
  const { run, ledger } = setup({
    text: planText(bank),
    responses: {
      'echo root': { exitCode: 0, stdout: 'root-ok' },
      'echo A': { exitCode: 0, stdout: 'ran: echo A' },
      'echo B': { exitCode: 0, stdout: 'ran: echo B' },
    },
  })
  const value = await run({ command: 'echo root' })
  assert.equal(value.outcome, 'completed')
  assert.equal(value.substitutions, 2)
  assert.deepEqual(value.receipts.map((item) => item.label), ['root', 'A', 'B'])
  assert.equal(value.bank.candidates, 2)
  assert.equal(value.bank.source, 'text')
  const events = ledger.events('session-1')
  const certificates = events.filter((event) => event.kind === 'sar/substitution-certificate')
  assert.equal(certificates.length, 2)
  assert.deepEqual(certificates.map((event) => event.candidate_id), ['A', 'B'])
  assert.equal(certificates[0].bypassed_slow_callback_id, 'call_1:omitted:1')
  assert.equal(certificates[1].bypassed_slow_callback_id, 'call_1:omitted:2')
  assert.equal(certificates[0].predecessor_callback_id, 'call_1')
  assert.equal(certificates[1].predecessor_callback_id, certificates[0].call_id)
})

test('the chisel_plan argument channel runs the same chain without the session log', async () => {
  const bank = [candidate({ candidate_id: 'A', arguments: { command: 'echo A' } })]
  const { run } = setup({
    sessions: false,
    responses: { 'echo root': { exitCode: 0, stdout: 'root-ok' }, 'echo A': { exitCode: 0, stdout: 'ran: echo A' } },
  })
  const value = await run({ command: 'echo root', chisel_plan: bank })
  assert.equal(value.bank.source, 'argument')
  assert.equal(value.substitutions, 1)
})

test('a guard that does not hold defers to the model', async () => {
  const bank = [candidate({ candidate_id: 'A', guard: { stdout_contains: 'NEVER' }, required_receipt_fields: ['stdout'] })]
  const { run } = setup({ text: planText(bank), responses: { 'echo root': { exitCode: 0, stdout: 'root-ok' } } })
  const value = await run({ command: 'echo root' })
  assert.equal(value.outcome, 'deferred')
  assert.equal(value.substitutions, 0)
  assert.equal(value.stop_reason, 'no_eligible_or_unexpected_receipt')
  assert.equal(value.receipts.length, 1)
})

test('an invalid bank still runs the root and reports the contract violation', async () => {
  const bank = [candidate({ candidate_id: 'A', arguments: { command: 'echo root' } })]
  const { run, ledger } = setup({ text: planText(bank), responses: { 'echo root': { exitCode: 0, stdout: 'root-ok' } } })
  const value = await run({ command: 'echo root' })
  assert.equal(value.outcome, 'invalid_bank')
  assert.match(value.bank_error, /repeat the already executed native root/)
  assert.equal(value.receipts.length, 1)
  assert.equal(ledger.events('session-1').some((event) => event.kind === 'jev/invalid-bank'), true)
})

test('a failing root stops before any successor', async () => {
  const bank = [candidate({ candidate_id: 'A' })]
  const { run } = setup({ text: planText(bank), responses: { 'echo root': { exitCode: 2, stdout: '', stderr: 'boom' } } })
  const value = await run({ command: 'echo root' })
  assert.equal(value.outcome, 'deferred')
  assert.equal(value.receipts[0].return_code, 2)
  assert.equal(value.stop_reason, 'no_eligible_or_unexpected_receipt')
})

test('a failing successor is certified and returns control', async () => {
  const bank = [candidate({ candidate_id: 'A', arguments: { command: 'boom' } })]
  const { run } = setup({ text: planText(bank), responses: { 'echo root': { exitCode: 0, stdout: 'root-ok' }, boom: { exitCode: 1, stdout: '', stderr: 'nope' } } })
  const value = await run({ command: 'echo root' })
  assert.equal(value.outcome, 'failed')
  assert.equal(value.substitutions, 1)
  assert.equal(value.stop_reason, 'native_error')
  assert.equal(value.receipts.at(-1).return_code, 1)
})

test('a missing dependency refuses admission', async () => {
  const bank = [
    candidate({ candidate_id: 'A', guard: { stdout_contains: 'NEVER' }, required_receipt_fields: ['stdout'] }),
    candidate({ candidate_id: 'B', dependency_ids: ['A'] }),
  ]
  const { run } = setup({ text: planText(bank), responses: { 'echo root': { exitCode: 0, stdout: 'root-ok' } } })
  const value = await run({ command: 'echo root' })
  assert.equal(value.outcome, 'deferred')
  assert.equal(value.substitutions, 0)
})

test('several eligible successors are chosen by the one-character selector', async () => {
  const bank = [
    candidate({ candidate_id: 'A', arguments: { command: 'echo A' } }),
    candidate({ candidate_id: 'B', arguments: { command: 'echo B' } }),
  ]
  const llm = {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: 'B' }
        yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 1, totalTokens: 41 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const selector = createSelectorFactory({ get: (name) => (name === 'llm' ? llm : undefined) }, { enabled: true, maxTokens: 1, temperature: 0, provider: '', model: '' })
  const { run, ledger } = setup({
    text: planText(bank),
    selector,
    responses: { 'echo root': { exitCode: 0, stdout: 'root-ok' }, 'echo A': { exitCode: 0, stdout: 'A' }, 'echo B': { exitCode: 0, stdout: 'B' } },
  })
  const value = await run({ command: 'echo root' })
  assert.equal(value.substitutions, 1)
  assert.deepEqual(value.receipts.map((item) => item.label), ['root', 'B'])
  assert.equal(value.selector_tokens, 41)
  assert.equal(ledger.events('session-1').some((event) => event.kind === 'jev/decision' && event.usage?.totalTokens === 41), true)
})

test('the selector abstains on anything that is not an offered label', async () => {
  const bank = [
    candidate({ candidate_id: 'A', arguments: { command: 'echo A' } }),
    candidate({ candidate_id: 'B', arguments: { command: 'echo B' } }),
  ]
  const llm = {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: 'maybe A' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const selector = createSelectorFactory({ get: (name) => (name === 'llm' ? llm : undefined) }, { enabled: true, maxTokens: 1, temperature: 0, provider: '', model: '' })
  const { run } = setup({ text: planText(bank), selector, responses: { 'echo root': { exitCode: 0, stdout: 'root-ok' } } })
  const value = await run({ command: 'echo root' })
  assert.equal(value.outcome, 'deferred')
  assert.equal(value.stop_reason, 'selector_abstained')
  assert.equal(value.substitutions, 0)
})

test('the rendered report names the outcome, the bank and every receipt', async () => {
  const bank = [candidate({ candidate_id: 'A', arguments: { command: 'echo A' } })]
  const { run, tool } = setup({ text: planText(bank), responses: { 'echo root': { exitCode: 0, stdout: 'root-ok' }, 'echo A': { exitCode: 0, stdout: 'ran: echo A' } } })
  const value = await run({ command: 'echo root' })
  const rendered = tool.output.render({}, value).map((block) => block.text).join('\n')
  assert.match(rendered, /harnessmm: completed; 1 substitution\(s\) certified/)
  assert.match(rendered, /bank: 1 candidate\(s\) from text/)
  assert.match(rendered, /receipts:/)
  assert.match(rendered, /A \{.*ran: echo A/)
})

test('receipts are clipped for the model while guards read the exact one', async () => {
  const big = 'x'.repeat(40000)
  const bank = [candidate({ candidate_id: 'A', arguments: { command: 'echo A' } })]
  const { run } = setup({
    text: planText(bank),
    responses: { 'echo root': { exitCode: 0, stdout: 'root-ok' }, 'echo A': { exitCode: 0, stdout: `${big}END` } },
  })
  const value = await run({ command: 'echo root' })
  assert.equal(value.substitutions, 1)
  const receipt = value.receipts.at(-1)
  assert.equal(receipt.return_code, 0)
  assert.match(receipt.stdout, /bytes omitted/)
  assert.match(receipt.stdout, /END$/)
})
