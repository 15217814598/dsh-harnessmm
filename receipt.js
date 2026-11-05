/**
 * Native receipt adaptation: one dsh shell tool result becomes the frozen
 * `{return_code, stdout, stderr}` receipt every guard reads.
 *
 * The plugin never runs a process itself. It dispatches each command through the
 * configured native shell tool (for example `pwsh`), so the tool registry's
 * pre-execute policy, the session's sandbox policy, approvals and background-job
 * handling stay in force for every banked action.
 *
 * @module dsh-harnessmm/receipt
 */

/** Clip one string to its tail, marking how many bytes were omitted. */
export function clip(text, budget) {
  if (typeof text !== 'string' || text.length <= budget) return text
  return `[${text.length - budget} bytes omitted]\n${text.slice(-budget)}`
}

/** The same receipt, shortened for the model; guards still read the exact one. */
export function modelReceipt(receipt, budget) {
  return {
    return_code: receipt.return_code,
    stdout: clip(receipt.stdout ?? '', budget),
    stderr: receipt.stderr === null ? null : clip(receipt.stderr ?? '', budget),
  }
}

/** The exact receipt, unchanged: guards evaluate this, never a preview. */
export function receiptText(receipt) {
  return JSON.stringify(receipt)
}

/**
 * Map one native shell tool outcome onto the frozen receipt.
 *
 * Accepts the dsh `pwsh`/`bash` foreground value (`{kind:'foreground', exitCode,
 * stdout:{text}, stderr:{text}}`), a shell tool that already returns the frozen
 * receipt, and any other shape as an unreadable receipt that fails closed.
 *
 * @param {{isError?: boolean, value?: unknown, content?: Array<{type:string,text?:string}>, error?: {message?:string}}} result
 * @returns {{is_error:boolean, receipt:{return_code:number, stdout:string, stderr:string|null}, display:string}}
 */
export function receiptFromResult(result) {
  const text = Array.isArray(result?.content) ? result.content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n') : ''
  if (result?.isError === true) {
    const message = result?.error?.message ?? (text || 'native tool error')
    return {
      is_error: true,
      receipt: { return_code: 1, stdout: '', stderr: String(message) },
      display: String(message),
    }
  }
  const value = result?.value
  if (value && typeof value === 'object' && value.kind === 'foreground') {
    const stdout = typeof value.stdout?.text === 'string' ? value.stdout.text : ''
    const stderr = typeof value.stderr?.text === 'string' ? value.stderr.text : ''
    const returnCode = Number.isInteger(value.exitCode) ? value.exitCode : value.timedOut === true ? 124 : 1
    const receipt = { return_code: returnCode, stdout, stderr: stderr.length > 0 ? stderr : null }
    return { is_error: false, receipt, display: text || stdout }
  }
  if (value && typeof value === 'object' && Number.isInteger(value.return_code) && typeof value.stdout === 'string') {
    const receipt = { return_code: value.return_code, stdout: value.stdout, stderr: typeof value.stderr === 'string' ? value.stderr : null }
    return { is_error: false, receipt, display: text || receipt.stdout }
  }
  const kind = value && typeof value === 'object' && typeof value.kind === 'string' ? value.kind : typeof value
  const detail = clip(text || safeJson(value), 500)
  return {
    is_error: true,
    receipt: { return_code: 1, stdout: '', stderr: `unreadable native receipt (${kind}): ${detail}` },
    display: detail,
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return String(value)
  }
}
