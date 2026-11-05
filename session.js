/**
 * Session adapters: read the authoring turn (its bank text, its paid usage and the
 * user constraints) from the live dsh session log.
 *
 * This is the dsh equivalent of pi-harnessmm's `toAuthoringMessage`,
 * `slowTokensOf` and `userRequests`: the assistant message that carries this
 * terminal call is the slow authoring turn, and its recorded `usage` is the saving
 * estimate admission charges the fast path against.
 *
 * @module dsh-harnessmm/session
 */

/**
 * Look up the live session that owns one agent. Returns `undefined` when the
 * session service or the agent is unavailable; every caller degrades to a
 * bank-only run instead of failing.
 *
 * @param {object} ctx plugin context
 * @param {{id:string}|undefined} agent
 * @returns {object|undefined}
 */
export function lookupSession(ctx, agent) {
  if (!agent || typeof agent.id !== 'string') return undefined
  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : ctx.sessions
  if (!sessions || typeof sessions.get !== 'function') return undefined
  try {
    return sessions.get(agent.id)
  } catch {
    return undefined
  }
}

/** Normalize one recorded dsh assistant message to the upstream authoring shape. */
export function toAuthoringMessage(message) {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return null
  const content = []
  for (const part of message.content) {
    if (part?.type === 'text' && typeof part.text === 'string') content.push({ type: 'text', text: part.text })
    else if (part?.type === 'reasoning' && typeof part.text === 'string') content.push({ type: 'reasoning', text: part.text })
    else if (part?.type === 'tool-call' && typeof part.name === 'string') {
      content.push({ type: 'tool-call', id: String(part.id), name: part.name, arguments: String(part.arguments ?? '{}') })
    }
  }
  return { role: 'assistant', content }
}

/** Total tokens of a paid slow call, used as the admission's saving estimate. */
export function slowTokensOf(usage) {
  if (!usage || typeof usage !== 'object') return 0
  if (Number.isSafeInteger(usage.totalTokens) && usage.totalTokens > 0) return usage.totalTokens
  const input = Number.isSafeInteger(usage.inputTokens) ? usage.inputTokens : 0
  const output = Number.isSafeInteger(usage.outputTokens) ? usage.outputTokens : 0
  return input + output > 0 ? input + output : 0
}

/**
 * Locate the authoring turn for one tool call.
 *
 * @param {object|undefined} session
 * @param {string} callId
 * @returns {null | {
 *   seq: number,
 *   index: number,
 *   event: object,
 *   message: {role:'assistant', content:object[]}|null,
 *   usageTokens: number,
 *   provider: string|undefined,
 *   model: string|undefined,
 *   userRequests: Array<{role:string, content:unknown}>,
 *   previousCallId: string|undefined,
 *   exact: boolean,
 * }}
 */
export function readAuthoringTurn(session, callId) {
  if (!session || typeof session.snapshotEvents !== 'function') return null
  let events
  try {
    events = session.snapshotEvents()
  } catch {
    return null
  }
  if (!Array.isArray(events) || events.length === 0) return null

  let index = -1
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'assistant/message') continue
    const content = event.data?.message?.content
    if (!Array.isArray(content)) continue
    if (content.some((part) => part?.type === 'tool-call' && String(part.id) === String(callId))) {
      index = i
      break
    }
  }
  const exact = index >= 0
  if (index < 0) {
    // The tool-call block may not be recorded yet on some compositions; the last
    // assistant message is still the authoring turn.
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type === 'assistant/message') {
        index = i
        break
      }
    }
  }
  if (index < 0) return null

  const event = events[index]
  const message = toAuthoringMessage(event.data?.message)
  const userRequests = []
  for (let i = 0; i < index; i++) {
    const earlier = events[i]
    if (earlier?.type === 'user/message') userRequests.push({ role: 'user', content: earlier.data?.content })
  }

  let previousCallId
  for (let i = index - 1; i >= 0 && previousCallId === undefined; i--) {
    const earlier = events[i]
    if (earlier?.type === 'tool/call' && typeof earlier.data?.callId === 'string') previousCallId = earlier.data.callId
  }

  const source = event.data?.message?.source
  return {
    seq: event.seq,
    index,
    event,
    message,
    usageTokens: slowTokensOf(event.data?.usage),
    provider: typeof source?.provider === 'string' ? source.provider : undefined,
    model: typeof source?.model === 'string' ? source.model : undefined,
    userRequests,
    previousCallId,
    exact,
  }
}

/**
 * True when the authoring turn's visible/reasoning text carries a bank block.
 * `parseBank` performs the authoritative parse; this only decides whether a plain
 * call needs to look at the session at all.
 */
export function hasBankText(authoring, policyVersion) {
  if (!authoring?.message) return false
  return authoring.message.content.some(
    (part) => (part.type === 'text' || (policyVersion >= 8 && part.type === 'reasoning')) && typeof part.text === 'string' && part.text.includes('<CHISEL_PLAN>'),
  )
}
