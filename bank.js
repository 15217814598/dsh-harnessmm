/**
 * Action-bank parsing: the `<CHISEL_PLAN>` / `chisel_plan` EDG contract.
 *
 * Port of the HarnessMM `cot_jev.mjs` bank contract as exposed by pi-harnessmm
 * (`publicReceipt`, `terminalArguments`, `schemaMatches`, `parseBank`,
 * `nativeCallId`). Behaviour is preserved, including which violations throw and
 * which turns yield `null` instead of an error:
 *
 * - no bank in the turn and no `chisel_plan` argument → `null` (a plain call);
 * - a bank that violates the frozen node contract → `BankContractError`.
 *
 * One dsh adaptation: the bank may also arrive as the `chisel_plan` argument of
 * the terminal call (the v10 channel). Exactly one channel per turn is allowed,
 * and a bank carried by both is a contract violation.
 *
 * @module dsh-harnessmm/bank
 */

import { isDeepStrictEqual } from 'node:util'
import { BankContractError, LABELS, hash, object } from './policy.js'

/** Receipt fields a guard may read; the mapped native receipt member for each guard key. */
export const GUARD_FIELDS = Object.freeze({
  return_code: 'return_code',
  stdout_contains: 'stdout',
  stdout_equals: 'stdout',
  stderr_empty: 'stderr',
  json_equals: 'stdout',
})

/** Native receipt field names that may appear in `required_receipt_fields`. */
const RECEIPT_FIELDS = ['return_code', 'stdout', 'stderr']

/** The closed terminal arguments the contract allows for a candidate (and the root). */
export function terminalArguments(value) {
  return (
    object(value) &&
    Object.keys(value).every((key) => ['command', 'cwd', 'timeout_sec'].includes(key)) &&
    typeof value.command === 'string' &&
    value.command.trim().length > 0 &&
    !value.command.includes('\0') &&
    (!Object.hasOwn(value, 'cwd') || (typeof value.cwd === 'string' && value.cwd.length > 0 && !value.cwd.includes('\0'))) &&
    (!Object.hasOwn(value, 'timeout_sec') || (Number.isSafeInteger(value.timeout_sec) && value.timeout_sec > 0))
  )
}

/**
 * Decode one native tool message into the receipt a guard may read.
 *
 * @param {{toolCallId?: string, isError?: boolean|null, content?: unknown}} message
 * @returns {{call_id?: string, is_error: boolean|null, status: 'PARSED', value: any} | {call_id?: string, is_error: boolean|null, status: 'UNKNOWN', reason: string}}
 */
export function publicReceipt(message) {
  const identity = { call_id: message?.toolCallId, is_error: message?.isError ?? null }
  const content = message?.content
  if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text' || typeof content[0].text !== 'string') {
    return { ...identity, status: 'UNKNOWN', reason: 'non_scalar_native_text' }
  }
  let value = content[0].text
  for (let depth = 0; depth < 3 && typeof value === 'string'; depth++) {
    try {
      value = JSON.parse(value)
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      return { ...identity, status: 'UNKNOWN', reason: 'unparsed_native_observation' }
    }
  }
  if (!object(value)) return { ...identity, status: 'UNKNOWN', reason: 'non_object_native_result' }
  return { ...identity, status: 'PARSED', value }
}

/**
 * JSON-Schema subset check used to prove candidate arguments match a tool
 * contract. Kept for callers that validate against a registered tool schema;
 * this plugin's own contract uses {@link terminalArguments}.
 */
export function schemaMatches(value, schema, root = schema, depth = 0) {
  if (!object(schema) || depth > 16) return false
  if (schema.$ref) {
    if (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/')) return false
    let target = root
    for (const part of schema.$ref.slice(2).split('/')) {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
      if (!object(target) || !Object.hasOwn(target, key)) return false
      target = target[key]
    }
    return schemaMatches(value, target, root, depth + 1)
  }
  if (schema.enum && !schema.enum.some((item) => isDeepStrictEqual(item, value))) return false
  if (Object.hasOwn(schema, 'const') && !isDeepStrictEqual(schema.const, value)) return false
  if (schema.allOf && !schema.allOf.every((item) => schemaMatches(value, item, root, depth + 1))) return false
  if (schema.anyOf && !schema.anyOf.some((item) => schemaMatches(value, item, root, depth + 1))) return false
  if (schema.oneOf && schema.oneOf.filter((item) => schemaMatches(value, item, root, depth + 1)).length !== 1) return false
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : typeof value
  if (schema.type && !types.includes(actual) && !(actual === 'number' && Number.isSafeInteger(value) && types.includes('integer'))) return false
  if (actual === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) return false
    if (schema.minimum !== undefined && value < schema.minimum) return false
    if (schema.maximum !== undefined && value > schema.maximum) return false
  } else if (actual === 'string') {
    if (value.includes('\0')) return false
    if (schema.minLength !== undefined && value.length < schema.minLength) return false
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return false
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false
  } else if (actual === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false
    if (schema.items && !value.every((item) => schemaMatches(item, schema.items, root, depth + 1))) return false
  } else if (actual === 'object') {
    const properties = schema.properties ?? {}
    if ((schema.required ?? []).some((key) => !Object.hasOwn(value, key))) return false
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        if (!schemaMatches(item, properties[key], root, depth + 1)) return false
      } else if (schema.additionalProperties === false) return false
      else if (object(schema.additionalProperties) && !schemaMatches(item, schema.additionalProperties, root, depth + 1)) return false
    }
  }
  return true
}

/** The exact sorted key strings the node contract accepts. */
const WITH_DEPS = 'candidate_id,dependency_ids,expected_local_cost,guard,predecessor_id,required_receipt_fields,tool,arguments'.split(',').sort().join()
const WITHOUT_DEPS = 'candidate_id,expected_local_cost,guard,predecessor_id,required_receipt_fields,tool,arguments'.split(',').sort().join()

/** A literal argument may not smuggle an unresolved value into the bank. */
const UNRESOLVED = /\$\{[^}]*\}|\{\{[^}]*\}\}/

/** Validate one node and return its normalized `Candidate`. */
function validateCandidate(raw, index, declared, policy, toolName, rootArguments) {
  const where = `candidate[${index}]`
  if (!object(raw)) throw new BankContractError(`${where} must be an object`)
  const keys = Object.keys(raw).sort().join()
  if (![WITH_DEPS, WITHOUT_DEPS].includes(keys)) {
    throw new BankContractError(`${where} must contain exactly candidate_id, predecessor_id, tool, arguments, guard, required_receipt_fields, expected_local_cost and optional dependency_ids`)
  }
  const { candidate_id, predecessor_id, tool, arguments: args, guard, required_receipt_fields, expected_local_cost } = raw
  const dependency_ids = raw.dependency_ids
  if (typeof candidate_id !== 'string' || candidate_id.length !== 1 || !LABELS.slice(0, policy.maximum_candidates).includes(candidate_id)) {
    throw new BankContractError(`${where}.candidate_id must be one of ${LABELS.slice(0, policy.maximum_candidates).split('').join(', ')}`)
  }
  if (declared.has(candidate_id)) throw new BankContractError(`Duplicate candidate_id ${candidate_id}`)
  if (typeof predecessor_id !== 'string' || !declared.has(predecessor_id)) {
    throw new BankContractError(`${where}.predecessor_id must be "root" or an earlier candidate_id (got ${JSON.stringify(predecessor_id)})`)
  }
  if (dependency_ids !== undefined && (!Array.isArray(dependency_ids) || dependency_ids.some((id) => typeof id !== 'string' || !declared.has(id)))) {
    throw new BankContractError(`${where}.dependency_ids may only name "root" or earlier candidate_ids`)
  }
  if (tool !== toolName) throw new BankContractError(`${where}.tool must be ${JSON.stringify(toolName)}`)
  if (!terminalArguments(args)) {
    throw new BankContractError(`${where}.arguments must be fully literal {command, cwd?, timeout_sec?}`)
  }
  if (UNRESOLVED.test(args.command) || (args.cwd !== undefined && UNRESOLVED.test(args.cwd))) {
    throw new BankContractError(`${where}.arguments contains an unresolved placeholder; every bank argument must be literal now`)
  }
  if (predecessor_id === 'root' && tool === toolName && rootArguments !== undefined && isDeepStrictEqual(args, rootArguments)) {
    throw new BankContractError('A future candidate cannot repeat the already executed native root')
  }
  if (!object(guard) || Object.keys(guard).length === 0 || Object.keys(guard).some((key) => !Object.hasOwn(GUARD_FIELDS, key))) {
    throw new BankContractError(`${where}.guard must be a non-empty conjunction of ${Object.keys(GUARD_FIELDS).join(', ')}`)
  }
  if (!Array.isArray(required_receipt_fields) || required_receipt_fields.some((field) => !RECEIPT_FIELDS.includes(field))) {
    throw new BankContractError(`${where}.required_receipt_fields must list native receipt fields (${RECEIPT_FIELDS.join(', ')})`)
  }
  for (const key of Object.keys(guard)) {
    if (!required_receipt_fields.includes(GUARD_FIELDS[key])) {
      throw new BankContractError(`${where}.required_receipt_fields must list ${GUARD_FIELDS[key]} because guard.${key} reads it`)
    }
  }
  if (!object(expected_local_cost) || !Number.isSafeInteger(expected_local_cost.selector_upper_tokens) || expected_local_cost.selector_upper_tokens < 0) {
    throw new BankContractError(`${where}.expected_local_cost.selector_upper_tokens must be a nonnegative safe integer`)
  }
  declared.add(candidate_id)
  const candidate = {
    candidate_id,
    predecessor_id,
    tool,
    arguments: args,
    guard,
    required_receipt_fields,
    expected_local_cost,
    ...(dependency_ids !== undefined ? { dependency_ids } : {}),
    // Upstream compatibility aliases used by the controller and the ledger.
    label: candidate_id,
    after: predecessor_id,
    condition: JSON.stringify(guard),
  }
  // The v6+ node the guards and admission read; detached from the caller's value.
  candidate.node = structuredClone(candidate)
  delete candidate.node.label
  delete candidate.node.after
  delete candidate.node.condition
  return candidate
}

/**
 * Parse the single action bank one slow turn authored.
 *
 * @param {object} input
 * @param {{role:'assistant', content:Array<object>}|null} input.message normalized authoring turn
 * @param {unknown} input.plan the `chisel_plan` tool argument, if supplied
 * @param {{version:number, maximum_candidates:number, maximum_fast_steps:number, maximum_public_bytes:number, enabled:boolean}} input.policy
 * @param {string} input.toolName the registered terminal tool name
 * @param {string} input.rootCallId the native root call id
 * @param {Record<string, unknown>} [input.rootArguments] the literal root arguments
 * @returns {null | {candidates:object[], root:{type:'tool-call', id:string, name:string, arguments:string}, reasoning:object[], sha256:string, source:'text'|'argument', raw:string}}
 */
export function parseBank({ message, plan, policy, toolName, rootCallId, rootArguments }) {
  let raw
  let source
  let blocks = []

  if (message) {
    const textParts = message.content.filter((part) => part.type === 'text' || (policy.version >= 8 && part.type === 'reasoning'))
    const text = textParts.map((part) => part.text).join('\n')
    blocks = [...text.matchAll(/<CHISEL_PLAN>([\s\S]*?)<\/CHISEL_PLAN>/g)]
    if (blocks.length > 1) throw new BankContractError('A slow turn must declare only one action bank')
    if (blocks.length === 1) {
      if (plan !== undefined) throw new BankContractError('Declare the bank in exactly one channel: <CHISEL_PLAN> text or the chisel_plan argument, not both')
      raw = blocks[0][1]
      source = 'text'
    }
  }

  if (raw === undefined && plan !== undefined && plan !== null) {
    if (Array.isArray(plan)) {
      raw = JSON.stringify({ candidates: plan })
    } else if (object(plan) && Object.keys(plan).join() === 'candidates') {
      raw = JSON.stringify(plan)
    } else {
      throw new BankContractError('chisel_plan must be an array of candidate nodes or {"candidates":[...]}')
    }
    source = 'argument'
  }

  if (raw === undefined) return null

  const toolCalls = message ? message.content.filter((part) => part.type === 'tool-call') : []
  if (message && toolCalls.length !== 1) {
    throw new BankContractError('An action bank requires exactly one registered native root tool call in the turn')
  }
  if (message) {
    const root = toolCalls[0]
    if (String(root.id) !== String(rootCallId) || root.name !== toolName) {
      throw new BankContractError('An action bank requires this terminal call to be the turn\'s single native root')
    }
  }

  let bank
  try {
    bank = JSON.parse(raw)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new BankContractError('Slow CoT emitted an invalid JSON action bank')
  }
  if (!object(bank) || Object.keys(bank).join() !== 'candidates' || !Array.isArray(bank.candidates) || bank.candidates.length > policy.maximum_candidates) {
    throw new BankContractError(`Slow CoT action bank exceeds its closed candidate contract (at most ${policy.maximum_candidates} candidates)`)
  }

  const declared = new Set(['root'])
  const candidates = bank.candidates.map((candidate, index) => validateCandidate(candidate, index, declared, policy, toolName, rootArguments))

  const reasoning = message ? message.content.filter((part) => part.type === 'reasoning') : []
  if (reasoning.some((part) => typeof part.text !== 'string')) {
    throw new BankContractError('Native authored reasoning must retain its exact text')
  }

  return {
    candidates,
    root: { type: 'tool-call', id: String(rootCallId), name: toolName, arguments: JSON.stringify(rootArguments ?? {}) },
    reasoning: reasoning.map((part) => structuredClone(part)),
    sha256: hash(JSON.stringify([String(rootCallId), raw])),
    source,
    raw,
  }
}

/** Synthetic native call id for a committed candidate, identical upstream. */
export function nativeCallId(bank, label) {
  return `chisel_${bank.sha256.slice(0, 24)}_${label}`
}
