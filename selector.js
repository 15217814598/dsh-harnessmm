/**
 * The one-token selector.
 *
 * When more than one successor is eligible, HarnessMM asks a one-token judge to
 * pick a declared label or abstain with `?`. dsh exposes no logprobs, so — exactly
 * like pi-harnessmm — this verifies the reply shape instead of a probability and
 * treats every other reply as an abstention back to slow reasoning.
 *
 * Two dsh adaptations keep this usable with reasoning models: the judge gets a
 * small but non-trivial token budget (a reasoning model may spend a few tokens
 * before its one-character answer), and a lone label with trailing punctuation is
 * accepted while any prose still abstains.
 *
 * The judge uses the same provider/model that authored the bank, read from the
 * recorded assistant message, so no extra configuration is required.
 *
 * @module dsh-harnessmm/selector
 */

/**
 * Accept exactly one offered label, optionally followed by punctuation/space.
 * Anything else — prose, several labels, nothing at all — abstains with `?`.
 *
 * @param {string} text raw judge reply
 * @param {readonly string[]} labels offered labels
 * @returns {string}
 */
export function parseSelectorAnswer(text, labels) {
  const answer = String(text ?? '').trim()
  if (labels.includes(answer)) return answer
  const match = /^([A-Z])[^A-Za-z0-9]*$/.exec(answer)
  if (match && labels.includes(match[1])) return match[1]
  return '?'
}

/**
 * @param {object} ctx plugin context
 * @param {{enabled:boolean, maxTokens:number, temperature:number, provider:string, model:string}} settings
 * @returns {(authoring: {provider?:string, model?:string}|null) => undefined | ((input: object) => Promise<{label:string, usage?:object}>)}
 */
export function createSelectorFactory(ctx, settings) {
  return (authoring) => {
    if (!settings.enabled) return undefined
    const llm = typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm
    if (!llm || typeof llm.stream !== 'function') return undefined
    const provider = settings.provider || authoring?.provider
    const model = settings.model || authoring?.model
    if (!provider || !model) return undefined
    return (input) => selectLabel(llm, provider, model, settings, input)
  }
}

/**
 * Ask the model for exactly one label. Any text that is not one of the offered
 * labels abstains.
 */
export async function selectLabel(llm, provider, model, settings, input) {
  let text = ''
  let usage
  const stream = llm.stream({
    provider,
    model,
    system: input.system,
    messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(input.state) }] }],
    maxTokens: settings.maxTokens,
    temperature: settings.temperature,
  })
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk.type === 'usage' && chunk.usage) usage = chunk.usage
    else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
      throw new Error(chunk.reason.failure?.message ?? 'selector request failed')
    } else if (chunk.type === 'finish' && chunk.reason?.kind === 'aborted') {
      throw new Error('selector request aborted')
    }
  }
  const detached = usage
    ? {
        inputTokens: Number.isSafeInteger(usage.inputTokens) ? usage.inputTokens : 0,
        outputTokens: Number.isSafeInteger(usage.outputTokens) ? usage.outputTokens : 0,
        totalTokens: Number.isSafeInteger(usage.totalTokens)
          ? usage.totalTokens
          : (Number.isSafeInteger(usage.inputTokens) ? usage.inputTokens : 0) + (Number.isSafeInteger(usage.outputTokens) ? usage.outputTokens : 0),
      }
    : undefined
  return { label: parseSelectorAnswer(text, input.labels), ...(detached ? { usage: detached } : {}) }
}
