/**
 * Substitution controller: Guarded Decision Reuse + Certified Callback Substitution.
 *
 * Port of HarnessMM `sar_v2.mjs` (ExecutableSubdag) as exposed by pi-harnessmm,
 * with the same admission, the same certificate schema and the same event kinds.
 * The controller is host-neutral: it decides, the host executes, and it records.
 *
 * @module dsh-harnessmm/controller
 */

import { admit, deterministicAdmission, compactState } from './admission.js'
import { byteUpper, hash, selectorSystem } from './policy.js'
import { nativeCallId } from './bank.js'

/**
 * The controller owns admission, commitment and certification. It never
 * executes: the host dispatches the returned call through the native interface
 * and reports the receipt through {@link SubstitutionController#observeTool}.
 */
export class SubstitutionController {
  #policy
  #record
  #priors
  #select
  #episodeId
  #toolName
  #pending = new Map()
  #done = new Set()
  #slowSequence = []
  #actorSequence = []
  #boundary = null
  #substitutions = 0
  #authors = 0
  slowTokens = 0

  /**
   * @param {object} options
   * @param {{version:number, enabled:boolean, maximum_candidates:number, maximum_fast_steps:number, maximum_public_bytes:number}} options.policy
   * @param {(event: object) => void} options.record ledger sink
   * @param {{phase:string, categories:Record<string,{phase:string,median_tokens:number}>}|null} [options.priors]
   * @param {(input:{system:string, state:unknown, labels:string[]}) => Promise<{label:string, usage?:object}>} [options.select]
   * @param {string} [options.episodeId]
   * @param {string} [options.toolName]
   */
  constructor(options) {
    this.#policy = options.policy
    this.#priors = options.priors ?? null
    this.#select = options.select
    this.#episodeId = options.episodeId ?? 'dsh-session'
    this.#toolName = options.toolName ?? 'terminal'
    this.#record = (event) => {
      if (event.kind === 'jev/request') this.#actorSequence.push({ kind: 'fast', id: String(event.decision_id) })
      if (event.kind === 'jev/compiled-native-action') {
        const boundary = this.#boundary
        const call = event.call
        if (!boundary || this.#pending.has(call.id) || this.#done.has(call.id)) {
          throw new Error('Invalid substitution boundary')
        }
        this.#pending.set(call.id, {
          ...event,
          boundary,
          slow_snapshot: this.#slowSequence.length,
          actor_sequence: structuredClone(this.#actorSequence),
        })
      }
      options.record(event)
    }
  }

  /** A paid slow call happened: the authoring turn of `bank`. */
  ownSlowCall(attemptId, tokens = 0) {
    this.#slowSequence.push(attemptId)
    this.#actorSequence.push({ kind: 'slow', id: attemptId })
    this.#record({ kind: 'sar/slow-call', native_attempt_id: attemptId, tokens })
    if (tokens > 0) this.slowTokens = tokens
  }

  /** Record the bank the slow turn authored. */
  noteBank(bank, authorCallbackId) {
    this.#authors += 1
    this.#record({
      kind: 'sar/bank-authored',
      bank_sha256: bank.sha256,
      root_id: bank.root.id,
      author_callback_id: authorCallbackId,
      candidates: bank.candidates.length,
      bank_source: bank.source,
      bank_author_call_index: this.#authors,
    })
  }

  /**
   * Register the native boundary the next substitution bypasses: `attemptId` is the
   * authoring call, and each substitution derives its own omitted-callback identity
   * from it, so a certificate names the callback that did not happen.
   */
  beginBoundary(authoringCallbackId, predecessorCallbackId) {
    this.#boundary = { bypassed_slow_callback_id: authoringCallbackId, predecessor_callback_id: predecessorCallbackId }
    this.#substitutions = 0
  }

  /**
   * Name the call whose receipt authorizes the next decision. The certificate binds
   * it as `predecessor_callback_id`, so a substitution always points at the exact
   * callback that produced its evidence.
   */
  precede(callbackId) {
    if (this.#boundary) this.#boundary.predecessor_callback_id = callbackId
  }

  /**
   * Decide the next action from the current bank state.
   * Admission runs first; only admitted candidates reach the selector, and the
   * selector may only pick a label it was given.
   */
  async decide(bank, state) {
    const policy = this.#policy
    // Upstream refuses an oversized public state instead of paying for a selector over it.
    const bounded = policy.version >= 8 ? state.candidates : state
    if (byteUpper(bounded) > policy.maximum_public_bytes) {
      this.#record({ kind: 'sar/defer', bank_sha256: bank.sha256, reason: 'public_state_too_large', bytes: byteUpper(bounded), limit: policy.maximum_public_bytes })
      return { kind: 'slow', reason: 'public_state_too_large' }
    }
    const fullSAR = policy.version === 6 && this.slowTokens > 0
    const priorsPath = policy.version === 8 || policy.version === 10
    const admission = priorsPath
      ? admit(state, this.#priors, this.#episodeId, true, this.#toolName)
      : deterministicAdmission(state, this.slowTokens, fullSAR)
    const decisionId = hash([bank.sha256, state.public_results.length, Date.now()])
    this.#record(
      priorsPath
        ? {
            kind: 'sar/pre-admission',
            bank_sha256: bank.sha256,
            estimated_fast_total_tokens: admission.fastUpper,
            eligible: admission.eligible.map((item) => ({ id: item.candidate.label, reason: item.reason, type: item.type })),
            rejected: admission.rejected.map((item) => ({ id: item.candidate.label, reason: item.reason })),
            estimate_identity: 'frozen same-parent TRAIN category median',
            threshold: 'fast <= 0.25 * replaced slow',
            full_admission: fullSAR,
          }
        : {
            kind: 'sar/pre-admission',
            bank_sha256: bank.sha256,
            eligible: admission.eligible.map((item) => ({ id: item.candidate.label, estimated_net_saving: item.estimated_net_saving })),
            rejected: admission.rejected.map((item) => ({ id: item.candidate.label, reason: item.reason })),
            threshold_tokens: admission.threshold_tokens,
            estimate_identity: admission.identity,
            slow_tokens: this.slowTokens,
          },
    )
    if (admission.eligible.length === 0) {
      // Upstream names the two cases apart: an unreadable guard requests new CoT even
      // when another branch looked eligible, and an empty eligible set defers.
      const unknown = admission.rejected.some((item) => item.reason === 'guard_unknown' || item.reason === 'unknown_public_receipt')
      const reason = unknown ? 'guard_unknown' : 'no_eligible_or_unexpected_receipt'
      this.#record({ kind: 'sar/defer', bank_sha256: bank.sha256, reason })
      return { kind: 'slow', reason }
    }

    const candidates = admission.eligible.map((item) => item.candidate)
    const labels = candidates.map((candidate) => candidate.label)
    let label
    let deterministic = false
    if (policy.version === 6 && candidates.length === 1) {
      label = labels[0]
      deterministic = true
      this.#record({ kind: 'sar/deterministic-commit', decision_id: decisionId, native_attempt_id: this.#boundary?.bypassed_slow_callback_id, bank_sha256: bank.sha256 })
    } else {
      const selectorState = priorsPath ? admission.state : compactState(state, candidates, this.#episodeId)
      if (!this.#select) {
        this.#record({ kind: 'jev/slow-fallback', decision_id: decisionId, reason: 'selector_unavailable' })
        return { kind: 'slow', reason: 'selector_unavailable' }
      }
      const system = selectorSystem(labels)
      this.#record({
        kind: 'jev/request',
        decision_id: decisionId,
        native_attempt_id: this.#boundary?.bypassed_slow_callback_id,
        bank_sha256: bank.sha256,
        step: state.public_results.length,
        request: { system, state: selectorState },
      })
      let answer
      try {
        answer = await this.#select({ system, state: selectorState, labels })
      } catch (error) {
        this.#record({ kind: 'jev/error', decision_id: decisionId, error: error instanceof Error ? error.message : String(error) })
        this.#record({ kind: 'jev/slow-fallback', decision_id: decisionId })
        return { kind: 'slow', reason: 'selector_unavailable' }
      }
      this.#record({ kind: 'jev/decision', decision_id: decisionId, ...answer })
      if (!labels.includes(answer.label)) {
        this.#record({ kind: 'jev/slow-fallback', decision_id: decisionId })
        return { kind: 'slow', reason: 'selector_abstained' }
      }
      label = answer.label
    }

    const candidate = candidates.find((item) => item.label === label)
    const call = {
      type: 'tool-call',
      id: nativeCallId(bank, candidate.label),
      name: candidate.tool,
      arguments: JSON.stringify(candidate.arguments),
    }
    this.#record({ kind: 'jev/compiled-native-action', decision_id: decisionId, bank_sha256: bank.sha256, candidate, call, native_execution_claimed: false })
    return { kind: 'commit', candidate, call, deterministic, admission }
  }

  /**
   * Bind the native receipt to the certificate. Throws when the receipt does not
   * match the admitted action or when a slow request intervened.
   */
  observeTool(event) {
    const item = this.#pending.get(event.call_id)
    if (!item) return
    if (
      event.name !== item.call.name ||
      hash(event.arguments) !== hash(JSON.parse(item.call.arguments)) ||
      !Object.hasOwn(event.result ?? {}, 'observation') ||
      this.#slowSequence.length !== item.slow_snapshot
    ) {
      throw new Error('Substitution lacks exact native receipt or has intervening slow request')
    }
    this.#pending.delete(event.call_id)
    this.#done.add(event.call_id)
    this.#substitutions += 1
    let observation = event.result.observation
    try {
      if (typeof observation === 'string') observation = JSON.parse(observation)
    } catch {
      /* keep the raw text */
    }
    if (observation?.executed === false) {
      this.#record({ kind: 'sar/uncertified-execution', call_id: event.call_id, reason: 'shared_parent_suppressed_action', certified_substitution: 0, executed_native_receipt: event.result })
      return
    }
    this.#record({
      kind: 'sar/substitution-certificate',
      schema: 'certified-native-substitution/v1',
      bank_hash: item.bank_sha256,
      bank_sha256: item.bank_sha256,
      candidate_id: item.candidate.label,
      decision_id: `${item.bank_sha256.slice(0, 12)}:${item.candidate.label}`,
      // The callback this execution replaced: the slow request that would have
      // produced it, identified per boundary rather than by the authoring call.
      bypassed_slow_callback_id: `${item.boundary.bypassed_slow_callback_id}:omitted:${this.#substitutions}`,
      predecessor_callback_id: item.boundary.predecessor_callback_id,
      graph_hash: item.bank_sha256,
      exact_native_tool: event.name,
      exact_arguments: event.arguments,
      native_receipt_hash: hash(event.result),
      native_result_sha256: hash(event.result),
      call_id: event.call_id,
      native_receipt: event.result,
      guard: item.candidate.node?.guard,
      native_action_hash: hash([event.name, event.arguments]),
      actor_request_sequence: item.actor_sequence,
      slow_requests_at_boundary: this.#slowSequence.length - item.slow_snapshot,
      slow_sequence_before: item.slow_snapshot,
      slow_sequence_after: this.#slowSequence.length,
      valid_substitution: true,
      counterfactual_identity: 'unchanged native SDK llm/stream boundary; no claim of paired-parent trajectory equality',
    })
  }
}
