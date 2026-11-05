/**
 * A minimal stand-in for the dsh Host: one tool registry, one fake shell tool and
 * one live-session shape. It exercises the plugin's real orchestration code
 * without booting the harness.
 *
 * @module dsh-harnessmm/test/harness
 */

export const POLICY = Object.freeze({
  version: 6,
  enabled: true,
  maximum_candidates: 16,
  maximum_fast_steps: 8,
  maximum_public_bytes: 65536,
})

/** One candidate node with the frozen v6 shape. */
export function candidate(overrides = {}) {
  return {
    candidate_id: 'A',
    predecessor_id: 'root',
    tool: 'terminal',
    arguments: { command: 'echo A' },
    guard: { return_code: 0 },
    required_receipt_fields: ['return_code'],
    expected_local_cost: { selector_upper_tokens: 2048 },
    dependency_ids: [],
    ...overrides,
  }
}

/** Wrap candidates in the bank text block. */
export function planText(candidates) {
  return `<CHISEL_PLAN>${JSON.stringify({ candidates })}</CHISEL_PLAN>`
}

/** A fake registered shell tool; commands map to canned foreground receipts. */
export function makeShell(responses = {}, fallback = {}) {
  const calls = []
  const tool = {
    name: 'pwsh',
    description: 'fake pwsh',
    parameters: {},
    async execute(args) {
      calls.push(args)
      const spec = responses[args.command] ?? fallback[args.command] ?? {
        exitCode: 0,
        stdout: `ran: ${args.command}`,
        stderr: '',
      }
      return {
        isError: false,
        value: {
          kind: 'foreground',
          cwd: args.workdir ?? '.',
          exitCode: spec.exitCode ?? 0,
          signal: null,
          timedOut: spec.timedOut ?? false,
          aborted: false,
          timeoutMs: 60000,
          stdout: { text: spec.stdout ?? '', truncated: false },
          stderr: { text: spec.stderr ?? '', truncated: false },
        },
        content: [{ type: 'text', text: spec.stdout ?? '' }],
      }
    },
  }
  return { tool, calls }
}

/**
 * Build the fake context.
 *
 * @param {{tools?: object[], sessions?: Map<string, object>, llm?: object}} options
 */
export function makeCtx({ tools = [], sessions = new Map(), llm = undefined } = {}) {
  const registry = new Map(tools.map((tool) => [tool.name, tool]))
  return {
    tools: {
      get: (name) => registry.get(name),
      register(definition) {
        registry.set(definition.name, definition)
        return () => registry.delete(definition.name)
      },
      async execute(execution) {
        const definition = registry.get(execution.name)
        if (!definition) throw new Error(`unknown tool ${execution.name}`)
        return definition.execute(execution.arguments, { callId: execution.callId, agent: execution.agent, signal: execution.signal })
      },
    },
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 40 },
    get(name) {
      if (name === 'sessions') return { get: (id) => sessions.get(id) }
      if (name === 'llm') return llm
      return undefined
    },
    effect: () => () => {},
  }
}

/**
 * Build a live-session snapshot with one user constraint and one authoring turn.
 *
 * @param {object} input
 */
export function makeSession({
  callId = 'call_1',
  text = '',
  usage = { inputTokens: 9000, outputTokens: 3000, totalTokens: 12000 },
  toolCalls = [{ type: 'tool-call', id: callId, name: 'terminal', arguments: '{"command":"echo root"}' }],
  previousCallId = undefined,
  userText = 'Run the checks.',
} = {}) {
  const events = []
  let seq = 1
  events.push({ type: 'user/message', seq: seq++, data: { role: 'user', content: [{ type: 'text', text: userText }] } })
  if (previousCallId) {
    events.push({ type: 'tool/call', seq: seq++, data: { callId: previousCallId, name: 'terminal', arguments: '{"command":"previous"}' } })
  }
  events.push({
    type: 'assistant/message',
    seq: seq++,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        source: { kind: 'model', provider: 'fake', model: 'fake-1' },
        content: [...(text ? [{ type: 'text', text }] : []), ...toolCalls],
      },
      usage,
      stream: [],
    },
  })
  return { snapshotEvents: () => events }
}

/** A signal that never aborts. */
export function liveSignal() {
  return new AbortController().signal
}

/** A deterministic one-label selector that records what it was asked. */
export function makeSelector(label = 'A') {
  const requests = []
  return {
    requests,
    factory: () => async (input) => {
      requests.push(input)
      return { label: input.labels.includes(label) ? label : '?', usage: { inputTokens: 40, outputTokens: 1, totalTokens: 41 } }
    },
  }
}
