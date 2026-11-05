/**
 * One-command verification of the HarnessMM mechanism without booting the harness.
 *
 * Every scenario below runs the plugin's real orchestration code (`tools.js` →
 * `bank.js` → `guard.js` → `admission.js` → `controller.js`) against a fake tool
 * registry and a fake live session. No model call, no process spawn, no network.
 *
 *   node scripts/selftest.mjs
 *
 * Exit code 0 means every scenario matched its expectation.
 *
 * @module dsh-harnessmm/scripts/selftest
 */

import { resolveConfig } from '../index.js'
import { Ledger } from '../ledger.js'
import { createSelectorFactory } from '../selector.js'
import { createTerminalTool } from '../tools.js'
import { candidate, liveSignal, makeCtx, makeSession, makeShell, planText } from '../test/harness.mjs'

const results = []

function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Build one mounted terminal tool over a fake registry and session. */
function setup({ text = '', responses = {}, llm, usage, sessions = true } = {}) {
  const shell = makeShell(responses)
  const session = makeSession({ text, usage })
  const ctx = makeCtx({ tools: [shell.tool], sessions: sessions ? new Map([['session-1', session]]) : new Map(), llm })
  const config = resolveConfig({})
  const ledger = new Ledger()
  const tool = createTerminalTool({
    ctx,
    config,
    ledger,
    toolName: 'terminal',
    shell: { resolve: () => 'pwsh', peek: () => 'pwsh' },
    selectFactory: createSelectorFactory(ctx, config.selector),
  })
  const exec = { callId: 'call_1', name: 'terminal', arguments: {}, agent: { id: 'session-1' }, signal: liveSignal() }
  return { tool, ledger, run: (args) => tool.execute(args, exec) }
}

const render = (value) => (typeof value === 'object' ? JSON.stringify(value) : String(value))

async function main() {
  console.log('dsh-harnessmm self-test\n')

  // ── 1. A text-authored bank runs a guarded chain and certifies each step ──
  {
    const bank = [
      candidate({ candidate_id: 'A', arguments: { command: 'echo A' } }),
      candidate({
        candidate_id: 'B',
        predecessor_id: 'A',
        arguments: { command: 'echo B' },
        guard: { return_code: 0, stdout_contains: 'ran: echo A' },
        required_receipt_fields: ['return_code', 'stdout'],
        dependency_ids: ['A'],
      }),
    ]
    const { run, ledger } = setup({
      text: planText(bank),
      responses: { 'echo root': { exitCode: 0, stdout: 'root-ok' }, 'echo A': { exitCode: 0, stdout: 'ran: echo A' }, 'echo B': { exitCode: 0, stdout: 'ran: echo B' } },
    })
    const value = await run({ command: 'echo root' })
    const certificates = ledger.events('session-1').filter((event) => event.kind === 'sar/substitution-certificate')
    check('text bank: chain executed', value.outcome === 'completed' && value.substitutions === 2, `outcome=${value.outcome} substitutions=${value.substitutions}`)
    check('text bank: one certificate per successor', certificates.length === 2, `certificates=${certificates.length}`)
    check(
      'text bank: certificate names the bypassed callback',
      certificates[1]?.bypassed_slow_callback_id === 'call_1:omitted:2' && certificates[1]?.slow_requests_at_boundary === 0,
      `${certificates[1]?.bypassed_slow_callback_id} / slow_requests_at_boundary=${certificates[1]?.slow_requests_at_boundary}`,
    )
  }

  // ── 2. The chisel_plan argument channel works without a session log ──
  {
    const { run } = setup({ sessions: false, responses: { 'echo root': { exitCode: 0, stdout: 'root-ok' }, 'echo A': { exitCode: 0, stdout: 'ran: echo A' } } })
    const value = await run({ command: 'echo root', chisel_plan: [candidate({ candidate_id: 'A', arguments: { command: 'echo A' } })] })
    check('argument channel: no session log needed', value.bank?.source === 'argument' && value.substitutions === 1, `source=${value.bank?.source} substitutions=${value.substitutions}`)
  }

  // ── 3. A guard that does not hold returns control to the model ──
  {
    const bank = [candidate({ candidate_id: 'A', guard: { stdout_contains: 'NEVER' }, required_receipt_fields: ['stdout'] })]
    const { run } = setup({ text: planText(bank), responses: { 'echo root': { exitCode: 0, stdout: 'root-ok' } } })
    const value = await run({ command: 'echo root' })
    check('false guard: deferred, nothing executed', value.outcome === 'deferred' && value.substitutions === 0 && value.stop_reason === 'no_eligible_or_unexpected_receipt', `outcome=${value.outcome} stop=${value.stop_reason}`)
  }

  // ── 4. A contract-violating bank still runs the root and reports why ──
  {
    const bank = [candidate({ candidate_id: 'A', arguments: { command: 'echo root' } })]
    const { run, ledger } = setup({ text: planText(bank), responses: { 'echo root': { exitCode: 0, stdout: 'root-ok' } } })
    const value = await run({ command: 'echo root' })
    check('invalid bank: root ran, violation reported', value.outcome === 'invalid_bank' && /repeat the already executed native root/.test(value.bank_error ?? ''), value.bank_error)
    check('invalid bank: ledger records the rejection', ledger.events('session-1').some((event) => event.kind === 'jev/invalid-bank'), 'jev/invalid-bank')
  }

  // ── 5. Several eligible successors go through the one-character selector ──
  {
    const bank = [candidate({ candidate_id: 'A', arguments: { command: 'echo A' } }), candidate({ candidate_id: 'B', arguments: { command: 'echo B' } })]
    const llm = {
      stream() {
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: 'B' }
          yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 1, totalTokens: 41 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
    const { run, ledger } = setup({ text: planText(bank), llm, responses: { 'echo root': { exitCode: 0, stdout: 'root-ok' }, 'echo A': { exitCode: 0, stdout: 'A' }, 'echo B': { exitCode: 0, stdout: 'B' } } })
    const value = await run({ command: 'echo root' })
    const decision = ledger.events('session-1').find((event) => event.kind === 'jev/decision')
    check('selector: judge picks a declared label', value.substitutions === 1 && value.receipts.at(-1).label === 'B', `picked=${value.receipts.at(-1).label}`)
    check('selector: usage is metered', value.selector_tokens === 41 && decision?.usage?.totalTokens === 41, `selector_tokens=${value.selector_tokens}`)
  }

  // ── 6. The model-facing report names the outcome and every receipt ──
  {
    const bank = [candidate({ candidate_id: 'A', arguments: { command: 'echo A' } })]
    const { run, tool } = setup({ text: planText(bank), responses: { 'echo root': { exitCode: 0, stdout: 'root-ok' }, 'echo A': { exitCode: 0, stdout: 'ran: echo A' } } })
    const value = await run({ command: 'echo root' })
    const text = tool.output.render({}, value).map((block) => block.text).join('\n')
    check('report: names outcome, bank and receipts', /harnessmm: completed; 1 substitution\(s\) certified/.test(text) && /receipts:/.test(text), text.split('\n')[0])
    console.log(`\n--- model-facing report ---\n${text}\n---------------------------\n`)
  }

  // ── 7. Receipts are clipped for the model, exact for guards ──
  {
    const big = 'x'.repeat(40000)
    const bank = [candidate({ candidate_id: 'A', arguments: { command: 'echo A' } })]
    const { run } = setup({ text: planText(bank), responses: { 'echo root': { exitCode: 0, stdout: 'root-ok' }, 'echo A': { exitCode: 0, stdout: `${big}END` } } })
    const value = await run({ command: 'echo root' })
    const receipt = value.receipts.at(-1)
    check('clipping: model sees a bounded tail', value.substitutions === 1 && /bytes omitted/.test(receipt.stdout) && /END$/.test(receipt.stdout), `stdout bytes=${receipt.stdout.length}`)
  }

  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) {
    console.log(`failed: ${failed.map((result) => `${result.name} (${render(result.detail)})`).join('; ')}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('self-test crashed:', error)
  process.exitCode = 1
})
