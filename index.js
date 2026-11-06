/**
 * dsh-harnessmm — HarnessMM (arXiv 2610.32813) for DeepSeek Harness.
 *
 * HarnessMM removes repeated reasoning calls by executing decisions the slow
 * actor already resolved. In this harness the slow actor is the model turn, and
 * the decision graph is a literal action bank authored for one command:
 *
 *   - `<CHISEL_PLAN>{...}</CHISEL_PLAN>` in the assistant text, or
 *   - `chisel_plan` in the terminal call's arguments (the v10 channel).
 *
 * The plugin mounts:
 *   - a bank-aware `terminal` tool: it runs the root, then every
 *     successor whose receipt guard holds, dispatching each through the native
 *     shell tool so tool policy, approvals and sandboxing still apply;
 *   - a system-prompt section carrying the authoring contract;
 *   - the `/harnessmm` command and /api/dsh-harnessmm/* audit routes;
 *   - the in-app savings dashboard (client.js: a conversation-view tab in the
 *     session tab strip next to Fleet, reading the audit routes same-origin).
 *
 * Every substitution records `certified-native-substitution/v1`, naming the slow
 * callback that did not happen.
 *
 * @module dsh-harnessmm
 */

import { normalizePriors } from './admission.js'
import { Ledger, summaryText } from './ledger.js'
import { normalizePolicy, planInstruction } from './policy.js'
import { createRoutes } from './routes.js'
import { createSelectorFactory } from './selector.js'
import { resolveShellTool } from './shell.js'
import { LedgerStore, resolveStoragePath } from './store.js'
import { createTerminalTool } from './tools.js'

/** Stable cordis plugin id. */
export const name = 'harnessmm'

/** The two services the mechanism cannot work without. */
export const inject = ['tools', 'systemPrompt']

const CONFIG_KEYS = ['enabled', 'policy', 'shellTool', 'maxReceiptBytes', 'selector', 'priors', 'persist', 'storagePath']
const SELECTOR_KEYS = ['enabled', 'maxTokens', 'temperature', 'provider', 'model']

/**
 * Validate the bundle config. Every field is optional but closed: an unknown key
 * or an out-of-range value is a load error, never a silent default.
 *
 * @param {Record<string, unknown>} input
 */
export function resolveConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('harnessmm: config must be an object')
  const unknown = Object.keys(input).filter((key) => !CONFIG_KEYS.includes(key))
  if (unknown.length > 0) throw new Error(`harnessmm: unknown config key(s): ${unknown.join(', ')}`)

  const policy = normalizePolicy(input.policy)
  const enabled = input.enabled ?? true
  if (typeof enabled !== 'boolean') throw new Error('harnessmm: enabled must be a boolean')

  const shellTool = input.shellTool ?? ''
  if (typeof shellTool !== 'string') throw new Error('harnessmm: shellTool must be a tool name or "" for auto-detection')

  const maxReceiptBytes = input.maxReceiptBytes ?? 8192
  if (!Number.isSafeInteger(maxReceiptBytes) || maxReceiptBytes < 512 || maxReceiptBytes > 65536) {
    throw new Error('harnessmm: maxReceiptBytes must be an integer in 512..65536')
  }

  const rawSelector = input.selector ?? {}
  if (!rawSelector || typeof rawSelector !== 'object' || Array.isArray(rawSelector)) throw new Error('harnessmm: selector must be an object')
  const unknownSelector = Object.keys(rawSelector).filter((key) => !SELECTOR_KEYS.includes(key))
  if (unknownSelector.length > 0) throw new Error(`harnessmm: unknown selector key(s): ${unknownSelector.join(', ')}`)
  const maxTokens = rawSelector.maxTokens ?? 256
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 1024) throw new Error('harnessmm: selector.maxTokens must be an integer in 1..1024')
  const temperature = rawSelector.temperature ?? 0
  if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new Error('harnessmm: selector.temperature must be a number in 0..2')
  }
  const provider = rawSelector.provider ?? ''
  const model = rawSelector.model ?? ''
  if (typeof provider !== 'string' || typeof model !== 'string') throw new Error('harnessmm: selector.provider/model must be strings')
  if (rawSelector.enabled !== undefined && typeof rawSelector.enabled !== 'boolean') throw new Error('harnessmm: selector.enabled must be a boolean')

  const persist = input.persist ?? true
  if (typeof persist !== 'boolean') throw new Error('harnessmm: persist must be a boolean')
  const storagePath = input.storagePath ?? ''
  if (typeof storagePath !== 'string') throw new Error('harnessmm: storagePath must be a string')

  return {
    enabled,
    policy,
    shellTool,
    maxReceiptBytes,
    selector: { enabled: rawSelector.enabled ?? true, maxTokens, temperature, provider, model },
    priors: normalizePriors(input.priors ?? null),
    persist,
    storagePath,
  }
}

/** Pick this plugin's tool name without shadowing an existing registration. */
function pickToolName(ctx) {
  const available = (candidate) => {
    try {
      return !ctx.tools?.get?.(candidate)
    } catch {
      return true
    }
  }
  for (const candidate of ['terminal', 'harnessmm_terminal']) {
    if (available(candidate)) return candidate
  }
  throw new Error('harnessmm: both "terminal" and "harnessmm_terminal" are registered by other plugins')
}

/** Place the authoring section next to the shell tool guidance. */
function sectionOrder(ctx) {
  try {
    const base = ctx.systemPrompt?.getSectionOrder?.('TOOL_PWSH')
    if (Number.isFinite(base)) return base + 0.5
  } catch {
    /* the name may not exist in this composition */
  }
  return 151
}

/**
 * A lazy shell target: the native shell tool is resolved per execution scope on
 * first dispatch, not at mount time. Tool rows may register in loader order, and a
 * composition may register its shell inside an agent-preset scope, so the scope-less
 * global view is not authoritative.
 */
function createShellTarget(ctx, configured, ownToolName) {
  const cache = new Map()
  return {
    resolve(agent) {
      const key = agent?.id ? String(agent.id) : 'global'
      if (cache.has(key)) return cache.get(key)
      const name = resolveShellTool(ctx, configured, ownToolName, agent)
      cache.set(key, name)
      console.log(`[dsh-harnessmm] dispatching native actions for ${key} through ${name}`)
      return name
    },
    peek() {
      return configured || undefined
    },
    describe() {
      if (configured) return configured
      const names = [...new Set(cache.values())]
      return names.length > 0 ? names.join(', ') : 'auto'
    },
  }
}

/** Mount the terminal tool, the prompt section, the command and the audit routes. */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  if (!resolved.enabled || !resolved.policy.enabled) {
    console.log('[dsh-harnessmm] disabled by config')
    return
  }

  const toolName = pickToolName(ctx)
  const shell = createShellTarget(ctx, resolved.shellTool, toolName)
  let store = null
  if (resolved.persist) {
    try {
      store = new LedgerStore({ filePath: resolveStoragePath(resolved.storagePath) })
    } catch (error) {
      console.warn(`[dsh-harnessmm] ledger persistence unavailable, keeping memory only: ${String(error)}`)
    }
  }
  const ledger = new Ledger(store ? { store } : {})
  const persistence = store ? store.describe() : { enabled: false, path: '', error: null, bytes: 0 }
  const disposers = []

  const tool = createTerminalTool({
    ctx,
    config: resolved,
    ledger,
    toolName,
    shell,
    selectFactory: createSelectorFactory(ctx, resolved.selector),
  })
  disposers.push(ctx.tools.register(tool))

  try {
    disposers.push(
      ctx.systemPrompt.section({
        name: 'harnessmm',
        order: sectionOrder(ctx),
        text: planInstruction(resolved.policy, toolName),
      }),
    )
  } catch (error) {
    console.warn(`[dsh-harnessmm] could not register the authoring prompt section: ${String(error)}`)
  }

  const commands = typeof ctx.get === 'function' ? ctx.get('commands') : undefined
  if (commands && typeof commands.register === 'function') {
    try {
      disposers.push(
        commands.register({
          name: 'harnessmm',
          description: 'Report HarnessMM guarded decision reuse for this session',
          handler: (invocation) => {
            const sessionId = String(invocation?.agent?.id ?? 'unknown')
            const raw = String(invocation?.rawInput ?? '').trim()
            if (raw === 'clear') {
              ledger.clear(sessionId)
              return { kind: 'success', text: 'harnessmm: cleared the ledger for this session' }
            }
            return { kind: 'success', text: summaryText(ledger.summary(sessionId), resolved.policy, ledger.project(sessionId)) }
          },
        }),
      )
    } catch (error) {
      console.warn(`[dsh-harnessmm] could not register the /harnessmm command: ${String(error)}`)
    }
  }

  /** Register the audit routes on whichever context owns the web server. */
  const registerRoutes = (scopeCtx) => {
    const webServer = scopeCtx && scopeCtx.webServer !== undefined
      ? scopeCtx.webServer
      : typeof scopeCtx?.get === 'function' ? scopeCtx.get('webServer') : undefined
    if (!webServer || typeof webServer.register !== 'function') return undefined
    const routeDisposers = []
    try {
      for (const route of createRoutes({ ledger, policy: resolved.policy, config: resolved, toolName, getShellTool: () => shell.describe(), persistence })) {
        routeDisposers.push(webServer.register(route))
      }
    } catch (error) {
      console.warn(`[dsh-harnessmm] could not register audit routes: ${String(error)}`)
    }
    return () => {
      for (const dispose of routeDisposers) {
        try {
          dispose()
        } catch {
          /* already disposed */
        }
      }
    }
  }

  // At boot a profile bundle can mount before the web server service exists;
  // wait for it instead of silently skipping the audit routes. A dynamic
  // install usually runs after the server is up, which is why the routes used
  // to appear only in that path.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scoped) => {
      const dispose = registerRoutes(scoped)
      if (dispose) scoped.effect(() => dispose, 'dsh-harnessmm: audit routes')
    })
  } else {
    const dispose = registerRoutes(ctx)
    if (dispose) disposers.push(dispose)
  }

  ctx.effect(
    () => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* already disposed */
        }
      }
    },
    'dsh-harnessmm: surfaces',
  )

  console.log(
    `[dsh-harnessmm] mounted ${toolName} (policy v${resolved.policy.version}` +
      `, priors ${resolved.priors ? Object.keys(resolved.priors.categories).join('/') : 'off'}` +
      `, selector ${resolved.selector.enabled ? 'on' : 'off'}` +
      `, shell ${resolved.shellTool || 'auto'}` +
      `, ledger ${persistence.enabled ? persistence.path : 'memory'})`,
  )
}
