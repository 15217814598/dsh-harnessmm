/**
 * The `terminal` tool: one root command plus the guarded successors of the literal
 * action bank authored for it.
 *
 * This is the dsh host adapter for HarnessMM's Guarded Decision Reuse (GDR) and
 * Certified Callback Substitution (CCS). The tool never executes a process itself:
 * every command — the root and each admitted successor — is dispatched through the
 * configured native shell tool, so the harness's own policy, approval and sandbox
 * decisions apply to each one.
 *
 * @module dsh-harnessmm/tools
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BankContractError } from './policy.js'
import { parseBank } from './bank.js'
import { SubstitutionController } from './controller.js'
import { clip, modelReceipt, receiptText } from './receipt.js'
import { lookupSession, projectOf, readAuthoringTurn } from './session.js'
import { describeCommand, dispatchShell } from './shell.js'
import { resolveStoragePath } from './store.js'

/** Tool parameters: the frozen root contract plus the bank argument channel. */
export const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['command'],
  properties: {
    command: {
      type: 'string',
      description: 'Shell command to run as the root action of this call.',
    },
    cwd: {
      type: 'string',
      description: 'Working directory for this command; defaults to the session workspace.',
    },
    timeout_sec: {
      type: 'integer',
      description: 'Kill the command after this many seconds (the executor may cap it).',
    },
    chisel_plan: {
      type: 'array',
      description:
        'HarnessMM literal continuation bank: candidate nodes executed after the root command, each only when its guard holds on the immediately preceding native receipt. Omit when no successor has literal arguments.',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['candidate_id', 'predecessor_id', 'tool', 'arguments', 'guard', 'required_receipt_fields', 'expected_local_cost'],
        properties: {
          candidate_id: { type: 'string', description: 'Unique single letter A..P.' },
          predecessor_id: { type: 'string', description: '"root" or an earlier candidate_id.' },
          tool: { type: 'string', description: 'The terminal tool name for this call.' },
          arguments: { type: 'object', additionalProperties: true, description: 'Fully literal {command, cwd?, timeout_sec?}.' },
          guard: { type: 'object', additionalProperties: true, description: 'Conjunction over {return_code, stdout, stderr}.' },
          required_receipt_fields: { type: 'array', items: { type: 'string' }, description: 'Receipt fields the guard reads.' },
          expected_local_cost: { type: 'object', additionalProperties: true, description: '{selector_upper_tokens: integer}.' },
          dependency_ids: { type: 'array', items: { type: 'string' }, description: '"root" or already declared candidate ids.' },
        },
      },
    },
  },
}

/**
 * Build one terminal tool definition.
 *
 * @param {object} options
 * @param {object} options.ctx plugin context
 * @param {{
 *   policy: object, priors: object|null, maxReceiptBytes: number,
 * }} options.config resolved plugin config
 * @param {import('./ledger.js').Ledger} options.ledger
 * @param {string} options.toolName
 * @param {{resolve: () => string, peek: () => string|undefined}} options.shell
 * @param {(authoring: object|null) => undefined | ((input: object) => Promise<{label:string, usage?:object}>)} options.selectFactory
 */
export function createTerminalTool({ ctx, config, ledger, toolName, shell, selectFactory }) {
  return {
    name: toolName,
    description: buildDescription(toolName, shell.peek()),
    parameters: PARAMETERS,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
    },
    /** Never schedule a banked call beside another tool call. */
    isConcurrencySafe: () => false,
    presentCall(args) {
      return {
        card: 'terminal',
        title: String(args?.command ?? ''),
        ...(typeof args?.cwd === 'string' ? { cwd: args.cwd } : {}),
        ...(Array.isArray(args?.chisel_plan) && args.chisel_plan.length > 0 ? { description: `HarnessMM bank: ${args.chisel_plan.length} candidate(s)` } : {}),
      }
    },
    async execute(args, exec) {
      try {
        return await runTerminal({ ctx, config, ledger, toolName, shell, selectFactory, args, exec })
      } catch (error) {
        // The harness collapses a thrown tool error into "Tool batch execution
        // failed"; keep the real cause in a local log and in the model-visible
        // report so a broken dispatch is diagnosable from the conversation.
        const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
        logToolFailure(detail)
        console.error('[dsh-harnessmm] terminal failed:', error)
        return {
          outcome: 'error',
          substitutions: 0,
          slow_tokens: 0,
          selector_tokens: 0,
          stop_reason: 'error',
          receipts: [],
          bank: null,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }
}

/** Model-facing description; names the native shell it dispatches through. */
function buildDescription(toolName, shellTool) {
  const target = shellTool ? `\`${shellTool}\`` : 'the session\'s native shell tool'
  return [
    `Run one shell command and return its native receipt {return_code, stdout, stderr}.`,
    `Optionally carry a literal action bank in \`chisel_plan\` (or one <CHISEL_PLAN>{"candidates":[...]}</CHISEL_PLAN> block in the same assistant text): after the root command, each successor whose guard holds on the immediately preceding receipt executes through this same tool without another model call.`,
    `Use \`${toolName}\` when you can already name the dependent follow-up commands, and ${target} for one-off commands, background jobs, or when you must read a result before deciding.`,
    `Each call runs in a fresh shell: pass \`cwd\` instead of \`cd\`. Non-zero exits are reported, not treated as tool failures. Every dispatched command still goes through the harness's tool policy, approvals and sandbox settings.`,
  ].join(' ')
}

/** Append one failed dispatch to the local diagnostic log (never throws). */
function logToolFailure(detail) {
  try {
    const file = join(dirname(resolveStoragePath('')), 'errors.log')
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `[${new Date().toISOString()}] ${detail}\n`)
  } catch {
    /* diagnostics are best effort */
  }
}

/** Frozen root arguments out of the tool input. */
function literalArguments(args) {
  if (!args || typeof args !== 'object') throw new Error('harnessmm: terminal arguments must be an object')
  const command = args.command
  if (typeof command !== 'string' || command.trim().length === 0) throw new Error('harnessmm: command must be a non-empty string')
  if (command.includes('\0')) throw new Error('harnessmm: command must not contain NUL')
  const request = { command }
  if (args.cwd !== undefined) {
    if (typeof args.cwd !== 'string' || args.cwd.length === 0 || args.cwd.includes('\0')) throw new Error('harnessmm: cwd must be a non-empty string')
    request.cwd = args.cwd
  }
  if (args.timeout_sec !== undefined) {
    if (!Number.isSafeInteger(args.timeout_sec) || args.timeout_sec <= 0) throw new Error('harnessmm: timeout_sec must be a positive integer')
    request.timeout_sec = args.timeout_sec
  }
  return request
}

/** Run the root call, then the admitted successors, then report one outcome. */
async function runTerminal({ ctx, config, ledger, toolName, shell, selectFactory, args, exec }) {
  const policy = config.policy
  const callId = String(exec?.callId ?? 'unknown')
  const sessionId = exec?.agent?.id ? String(exec.agent.id) : 'unknown'
  const rootRequest = literalArguments(args)

  const session = lookupSession(ctx, exec?.agent)
  const project = projectOf(session)
  const authoring = readAuthoringTurn(session, callId)
  const slowTokens = authoring?.usageTokens ?? 0

  const events = []
  const record = (event) => {
    events.push(event)
    // Tag the persisted/ledger copy with the session's project (its cwd) so a
    // restarted profile can group history; the in-memory event stays unchanged
    // for the controller's own bookkeeping.
    ledger.record(sessionId, project ? { ...event, project } : event)
  }

  let bank = null
  let bankError = null
  try {
    bank = parseBank({
      message: authoring?.message ?? null,
      plan: args?.chisel_plan,
      policy,
      toolName,
      rootCallId: callId,
      rootArguments: rootRequest,
    })
  } catch (error) {
    if (!(error instanceof BankContractError)) throw error
    bankError = error.message
    record({ kind: 'jev/invalid-bank', error: bankError, call_id: callId })
  }

  const dispatch = (request, id, label) => dispatchShell(ctx, shell.resolve(exec?.agent), request, exec ?? {}, id, describeCommand(request.command, label))

  if (!bank || bank.candidates.length === 0) {
    const mapped = await dispatch(rootRequest, `${callId}:root`, 'root')
    record({ kind: 'sar/no-bank', root_id: callId, ...(bankError ? { bank_error: bankError } : {}) })
    return finish({
      outcome: bankError ? 'invalid_bank' : 'plain',
      error: bankError,
      receipts: [{ id: callId, label: 'root', command: rootRequest.command, mapped }],
      bank: null,
      slowTokens,
      selectorTokens: 0,
      stopReason: null,
      events,
      config,
      sessionId,
      record,
      policy,
    })
  }

  const select = typeof selectFactory === 'function' ? selectFactory(authoring) : undefined
  const controller = new SubstitutionController({
    policy,
    priors: config.priors,
    record,
    ...(select ? { select } : {}),
    episodeId: sessionId,
    toolName,
  })
  controller.ownSlowCall(callId, slowTokens)
  controller.noteBank(bank, callId)
  controller.beginBoundary(callId, authoring?.previousCallId)

  const receipts = []
  const rootMapped = await dispatch(rootRequest, `${callId}:root`, 'root')
  receipts.push({ id: callId, label: 'root', command: rootRequest.command, mapped: rootMapped })
  const results = [
    {
      call_id: callId,
      is_error: rootMapped.is_error || rootMapped.receipt.return_code !== 0,
      status: 'PARSED',
      value: { native_text: receiptText(rootMapped.receipt) },
    },
  ]

  let previous = 'root'
  let predecessorCallId = callId
  let committed = 0
  let stopReason = null

  while (committed < policy.maximum_fast_steps) {
    if (exec?.signal?.aborted) {
      stopReason = 'aborted'
      break
    }
    const candidates = bank.candidates.filter((candidate) => candidate.predecessor_id === previous)
    if (candidates.length === 0) {
      record({ kind: 'jev/full-cot', bank_sha256: bank.sha256, reason: 'bank_exhausted' })
      stopReason = 'bank_exhausted'
      break
    }
    controller.precede(predecessorCallId)
    const decision = await controller.decide(bank, {
      public_user_requests: authoring?.userRequests ?? [],
      candidates,
      public_results: results,
    })
    if (decision.kind === 'slow') {
      stopReason = decision.reason
      break
    }
    const request = decision.candidate.arguments
    let mapped
    try {
      mapped = await dispatch(request, decision.call.id, decision.candidate.label)
    } catch (error) {
      record({
        kind: 'sar/uncertified-execution',
        call_id: decision.call.id,
        reason: 'native_dispatch_failed',
        error: error instanceof Error ? error.message : String(error),
        certified_substitution: 0,
      })
      stopReason = exec?.signal?.aborted ? 'aborted' : 'dispatch_failed'
      break
    }
    controller.observeTool({
      call_id: decision.call.id,
      name: decision.call.name,
      arguments: request,
      result: { observation: receiptText(mapped.receipt) },
    })
    receipts.push({ id: decision.call.id, label: decision.candidate.label, command: request.command, mapped })
    results.push({
      call_id: decision.call.id,
      is_error: mapped.is_error || mapped.receipt.return_code !== 0,
      status: 'PARSED',
      value: { native_text: receiptText(mapped.receipt) },
    })
    previous = decision.candidate.label
    predecessorCallId = decision.call.id
    committed += 1
    if (mapped.is_error || mapped.receipt.return_code !== 0) {
      stopReason = mapped.is_error ? 'unreadable_receipt' : 'native_error'
      break
    }
  }
  if (stopReason === null && committed >= policy.maximum_fast_steps) stopReason = 'step_limit'

  const certificates = events.filter((event) => event.kind === 'sar/substitution-certificate').length
  const last = receipts.at(-1)
  const lastFailed = Boolean(last && (last.mapped.is_error || last.mapped.receipt.return_code !== 0))
  const outcome = certificates === 0 ? 'deferred' : lastFailed ? 'failed' : 'completed'

  return finish({
    outcome,
    error: null,
    receipts,
    bank,
    slowTokens,
    selectorTokens: selectorTokensOf(events),
    stopReason,
    events,
    config,
    sessionId,
    record,
    policy,
    substitutions: certificates,
  })
}

/** Sum the selector usage recorded for this call. */
function selectorTokensOf(events) {
  return events.filter((event) => event.kind === 'jev/decision').reduce((total, event) => total + Number(event.usage?.totalTokens ?? 0), 0)
}

/**
 * Build the tool value, record the run event and return the detached payload the
 * registry renders. Guard receipts stay exact in the ledger certificates; the
 * value only carries the model-visible (clipped) receipts.
 */
function finish(input) {
  const substitutions = input.substitutions ?? input.events.filter((event) => event.kind === 'sar/substitution-certificate').length
  input.record({
    kind: 'harnessmm/run',
    outcome: input.outcome,
    bank_sha256: input.bank?.sha256 ?? null,
    bank_source: input.bank?.source ?? null,
    candidates: input.bank?.candidates.length ?? 0,
    substitutions,
    stop_reason: input.stopReason,
    slow_tokens: input.slowTokens,
    selector_tokens: input.selectorTokens,
    bank_error: input.error,
    session_id: input.sessionId,
  })
  return {
    outcome: input.outcome,
    substitutions,
    ...(input.error ? { bank_error: input.error } : {}),
    bank: input.bank
      ? { sha256: input.bank.sha256, source: input.bank.source, candidates: input.bank.candidates.length }
      : null,
    stop_reason: input.stopReason ?? null,
    slow_tokens: input.slowTokens,
    selector_tokens: input.selectorTokens,
    receipts: input.receipts.map((item) => ({
      id: item.id,
      label: item.label,
      command: item.command,
      is_error: item.mapped.is_error,
      ...modelReceipt(item.mapped.receipt, input.config.maxReceiptBytes),
    })),
  }
}

/** Model-facing report: outcome counters, then every receipt the model needs. */
export function renderValue(value) {
  if (!value || typeof value !== 'object') return String(value)
  const lines = []
  lines.push(`harnessmm: ${value.outcome}; ${value.substitutions} substitution(s) certified`)
  if (value.error) lines.push(`error: ${value.error}`)
  if (value.bank_error) {
    lines.push(`bank rejected: ${value.bank_error}`)
    lines.push('the root command ran normally; author the next bank as fully literal nodes')
  } else if (value.bank) {
    lines.push(`bank: ${value.bank.candidates} candidate(s) from ${value.bank.source} (graph ${String(value.bank.sha256).slice(0, 12)})`)
  } else {
    lines.push('bank: none (plain terminal call)')
  }
  if (value.stop_reason) lines.push(`control returned to the model: ${value.stop_reason}`)
  lines.push(`slow tokens seen: ${value.slow_tokens}, selector tokens spent: ${value.selector_tokens}`)
  if (Array.isArray(value.receipts) && value.receipts.length > 0) {
    lines.push('receipts:')
    for (const item of value.receipts) {
      lines.push(
        `${item.label} ${JSON.stringify({ return_code: item.return_code, stdout: item.stdout ?? '', stderr: item.stderr ?? null })}`,
      )
    }
  }
  return lines.join('\n')
}

/** Clip helper re-exported for tests and routes. */
export { clip }
