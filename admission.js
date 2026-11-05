/**
 * Admission: decide whether a guard-satisfied candidate may replace a slow call.
 *
 * Port of HarnessMM `sar_v2.mjs` (deterministicAdmission) and `sar_admission.mjs`
 * (actionType, compactState, admit), as exposed by pi-harnessmm. Both paths are
 * here because the paper reports both: versions 6/7 use the deterministic
 * net-saving threshold, versions 8/10 require frozen TRAIN priors and fail
 * closed when they are absent.
 *
 * @module dsh-harnessmm/admission
 */

import { byteUpper, hash, selectorSystem } from './policy.js'
import { localGuard } from './guard.js'

export { selectorSystem }

/**
 * Deterministic admission for policy versions 6 and 7.
 *
 * @param {any} state `{public_results, candidates, public_user_requests}`
 * @param {number} slowTokens total tokens of the last paid slow call
 * @param {boolean} fullSAR true for version 6, where the net-saving threshold applies
 */
export function deterministicAdmission(state, slowTokens, fullSAR = true) {
  const receipt = state.public_results.at(-1)
  const verdicts = new Map()
  const done = new Set(['root', ...state.public_results.map((r) => String(r.call_id).split('_').at(-1))])
  const eligible = []
  const rejected = []
  for (const candidate of state.candidates) {
    const node = candidate.node
    const check = localGuard(node, receipt)
    verdicts.set(candidate, check)
    const missingDependency = (node.dependency_ids ?? []).some((id) => !done.has(id))
    // Provider calls are the same backbone. The estimate is deliberately visible,
    // uses only paid slow usage, and is not a guaranteed bound.
    const locallyValid = state.candidates.filter(
      (x) => (verdicts.get(x) ?? localGuard(x.node, receipt)).eligible && (x.node.dependency_ids ?? []).every((id) => done.has(id)),
    )
    const deterministic = fullSAR && locallyValid.length === 1
    const fastUpper = deterministic
      ? 0
      : Math.max(node.expected_local_cost.selector_upper_tokens, byteUpper({ objective: state.public_user_requests, candidates: state.candidates }))
    const net = slowTokens - fastUpper
    const risk = receipt?.is_error || (check.known && check.fields?.return_code !== undefined && check.fields.return_code !== 0)
    const admitted = check.known && check.eligible && !missingDependency && !risk && (!fullSAR || net > 1024)
    ;(admitted ? eligible : rejected).push({
      candidate,
      check,
      estimated_net_saving: net,
      fast_upper: fastUpper,
      reason: missingDependency
        ? 'dependency_missing'
        : risk
          ? 'native_error'
          : !check.known
            ? 'guard_unknown'
            : !check.eligible
              ? 'guard_false'
              : net <= 1024
                ? 'net_saving_threshold'
                : 'admitted',
    })
  }
  return {
    eligible,
    rejected,
    threshold_tokens: 1024,
    identity: 'prospective prior from preceding paid slow usage; candidate estimate charged by complete wire ledger',
  }
}

/**
 * Coarse action category used by the priors-based admission.
 *
 * The path allowlist of the reference harness (oracle/verifier protection) is
 * not meaningful inside a dsh session, so only the destructive/privileged
 * denylist is kept: those actions are never eligible for priors-based privacy.
 */
export function actionType(node, toolName = 'terminal') {
  const command = node?.arguments?.command
  if (node?.tool !== toolName || typeof command !== 'string') return null
  if (/(?:rm\s+-[a-z]*r|sudo\b|docker\b|chmod\s+777|curl.*\|.*(?:sh|bash))/i.test(command)) return null
  if (/\b(?:pytest|unittest|npm test|cargo test|go test|make check|ctest)\b/.test(command)) return 'verify'
  if (/^(?:\s*cd\s+[^;&]+\s*&&\s*)?(?:cat|head|tail|ls|find|pwd|rg|grep|sed\s+-n|stat|wc|file|Get-ChildItem|Get-Content|Test-Path|Select-String)\b/i.test(command)) return 'inspect'
  if (/\b(?:python|python3|make|gcc|cc|cargo|npm|git|printf|echo|cp|mkdir|patch|sed|node|pnpm|tsc)\b/.test(command)) return 'edit_or_build'
  return null
}

/** The compact selector state: task constraints and guard results, nothing else. */
export function compactState(state, candidates, episodeId) {
  const immediate = state.public_results.at(-1)
  return {
    task: episodeId,
    receipt_hash: hash(immediate),
    candidates: candidates.map((candidate) => ({
      id: candidate.label,
      action: { tool: candidate.tool, arguments: candidate.arguments },
      guard: candidate.node.guard,
      public_guard_result: localGuard(candidate.node, immediate).eligible,
    })),
    schema: { terminal: ['command', 'cwd', 'timeout_sec'] },
  }
}

/**
 * Priors-based admission for policy versions 8 and 10. Every selectable candidate
 * must have a frozen TRAIN median for its category, and the fast path must stay
 * under a quarter of the replaced slow call.
 */
export function admit(state, priors, episodeId, fullSAR = true, toolName = 'terminal') {
  const receipt = state.public_results.at(-1)
  const done = new Set(['root', ...state.public_results.map((r) => String(r.call_id).split('_').at(-1))])
  const eligible = []
  const rejected = []
  const locallyValid = state.candidates.filter((candidate) => localGuard(candidate.node, receipt).eligible)
  const selectorState = compactState(state, locallyValid, episodeId)
  // UTF-8 byte count is a conservative serialization estimate, not measured usage.
  const selectorPrompt = selectorSystem(locallyValid.map((candidate) => candidate.label))
  const fastUpper = byteUpper(selectorPrompt) + byteUpper(selectorState) + 1 + 128
  for (const candidate of state.candidates) {
    const node = candidate.node
    const check = localGuard(node, receipt)
    const type = actionType(node, toolName)
    const prior = priors?.categories?.[type]
    // The v8 "fully resolved literal action" flags are structurally enforced by the
    // bank parser: every argument is literal and every guard reads the public receipt.
    const resolved = true
    const reason = !resolved
      ? 'unresolved_arguments'
      : !type
        ? 'not_allowlisted_or_high_risk'
        : !check.known
          ? 'unknown_public_receipt'
          : !check.eligible
            ? 'guard_false'
            : receipt.is_error || (check.fields?.return_code !== undefined && check.fields.return_code !== 0)
              ? 'native_error'
              : (node.dependency_ids ?? []).some((id) => !done.has(id))
                ? 'dependency_missing'
                : !prior || prior.phase !== 'train' || !Number.isSafeInteger(prior.median_tokens) || prior.median_tokens <= 0
                  ? 'missing_train_estimate'
                  : fullSAR && fastUpper * 4 > prior.median_tokens
                    ? 'fast_cost_above_quarter_of_slow'
                    : null
    const decision = {
      candidate,
      reason,
      estimated_fast_total_tokens: fastUpper,
      expected_slow_calls_saved: 1,
      estimated_replaced_slow_tokens: prior?.median_tokens ?? null,
      type,
    }
    ;(reason ? rejected : eligible).push(decision)
  }
  return { eligible, rejected, state: selectorState, fastUpper }
}

/**
 * Validate and detach a frozen TRAIN priors table.
 *
 * @param {unknown} input
 * @returns {{phase:string, categories:Record<string,{phase:string, median_tokens:number}>}|null}
 */
export function normalizePriors(input) {
  if (input === null || input === undefined) return null
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('harnessmm: priors must be an object or null')
  const { phase, categories } = input
  if (phase !== 'train') throw new Error('harnessmm: priors.phase must be "train"')
  if (!categories || typeof categories !== 'object' || Array.isArray(categories)) throw new Error('harnessmm: priors.categories must be an object')
  const detach = {}
  for (const [type, entry] of Object.entries(categories)) {
    if (!entry || typeof entry !== 'object' || entry.phase !== 'train' || !Number.isSafeInteger(entry.median_tokens) || entry.median_tokens <= 0) {
      throw new Error(`harnessmm: priors.categories.${type} must be {phase:"train", median_tokens: positive integer}`)
    }
    detach[type] = { phase: 'train', median_tokens: entry.median_tokens }
  }
  return { phase: 'train', categories: detach }
}
