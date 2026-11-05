/**
 * Native shell dispatch.
 *
 * HarnessMM executes every admitted successor "through the same native terminal
 * interface". In dsh that interface is a registered shell tool (`pwsh` on the
 * Windows preset, `bash` on POSIX), so this plugin calls `ctx.tools.execute`
 * instead of spawning a process: the tool registry's pre-execute policy, the
 * session's sandbox policy, approvals, cancellation and job handling all still
 * apply to every banked action.
 *
 * @module dsh-harnessmm/shell
 */

import { receiptFromResult } from './receipt.js'

/** Shell tool names tried, in order, when the config does not name one. */
export const SHELL_CANDIDATES = ['pwsh', 'bash', 'shell']

/** Tools that take `description`/`workdir`/`timeoutMs` (the dsh shell dialect). */
const SHELL_DIALECT = new Set(['pwsh', 'bash'])

/**
 * Resolve the native shell tool this plugin dispatches through.
 *
 * The lookup takes the execution's Agent as the viewing scope: a composition may
 * register its shell tool inside an agent-preset scope (the shipped Windows
 * preset does), where a scope-less `get` cannot see it.
 *
 * @param {object} ctx plugin context (needs `ctx.tools`)
 * @param {string} configured configured `shellTool` ('' = auto)
 * @param {string} ownToolName this plugin's own tool name (never a valid target)
 * @param {object|undefined} scope the execution's Agent, used as the viewing scope
 * @returns {string}
 */
export function resolveShellTool(ctx, configured, ownToolName, scope) {
  const available = (name) => {
    try {
      return Boolean(ctx.tools?.get?.(name, scope))
    } catch {
      return false
    }
  }
  if (configured) {
    if (configured === ownToolName) throw new Error(`harnessmm: shellTool must not be this plugin's own tool (${configured})`)
    if (!available(configured)) {
      throw new Error(`harnessmm: shellTool ${JSON.stringify(configured)} is not visible to this session; available shell tools: ${SHELL_CANDIDATES.filter(available).join(', ') || 'none'}`)
    }
    return configured
  }
  for (const name of SHELL_CANDIDATES) {
    if (name !== ownToolName && available(name)) return name
  }
  throw new Error(`harnessmm: no native shell tool is visible to this session (looked for ${SHELL_CANDIDATES.join(', ')}); set shellTool explicitly`)
}

/**
 * Translate the frozen `{command, cwd, timeout_sec}` contract into one shell
 * tool's argument names.
 */
export function toShellArguments(shellTool, request, description) {
  const args = { command: request.command }
  if (SHELL_DIALECT.has(shellTool)) {
    args.description = description
    if (request.cwd !== undefined) args.workdir = request.cwd
    if (request.timeout_sec !== undefined) args.timeoutMs = request.timeout_sec * 1000
    return args
  }
  // An unknown configured shell tool receives the generic spelling.
  if (request.cwd !== undefined) args.cwd = request.cwd
  if (request.timeout_sec !== undefined) args.timeout_sec = request.timeout_sec
  args.description = description
  return args
}

/** A short, deterministic description for the native tool card. */
export function describeCommand(command, label) {
  const firstLine = String(command ?? '').split(/\r?\n/)[0].trim()
  const head = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine
  return `harnessmm ${label}: ${head || 'terminal command'}`
}

/**
 * Dispatch one admitted native action and normalize its receipt.
 *
 * @param {object} ctx plugin context
 * @param {string} shellTool registered shell tool name
 * @param {{command:string, cwd?:string, timeout_sec?:number}} request frozen arguments
 * @param {{callId:string, agent?:object, signal?:AbortSignal}} exec outer execution
 * @param {string} callId synthetic native call id for this dispatch
 * @param {string} description tool-card description
 */
export async function dispatchShell(ctx, shellTool, request, exec, callId, description) {
  const result = await ctx.tools.execute({
    callId,
    name: shellTool,
    arguments: toShellArguments(shellTool, request, description),
    ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
    ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
  })
  return receiptFromResult(result)
}
