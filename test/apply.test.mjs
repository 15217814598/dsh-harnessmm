/**
 * Mounting: what `apply` registers on a dsh-shaped context.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { candidate, liveSignal, makeSession, makeShell, planText } from './harness.mjs'

function mount({ text = '', toolName = 'terminal', config = { persist: false }, serverAvailable = true } = {}) {
  const shell = makeShell({ 'echo root': { exitCode: 0, stdout: 'root-ok' }, 'echo A': { exitCode: 0, stdout: 'ran: echo A' } })
  const registry = new Map([[shell.tool.name, shell.tool]])
  const sessions = new Map([['session-1', makeSession({ text })]])
  const sections = []
  const commands = []
  const routes = []
  const effects = []
  const injections = []

  const ctx = {
    tools: {
      get: (name, scope) => registry.get(name),
      register(definition) {
        registry.set(definition.name, definition)
        return () => registry.delete(definition.name)
      },
      async execute(execution) {
        const definition = registry.get(execution.name)
        if (!definition) throw new Error(`unknown tool ${execution.name}`)
        return definition.execute(execution.arguments, execution)
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
      getSectionOrder: () => 40,
    },
    inject(deps, callback) {
      injections.push({ deps, callback })
      if (serverAvailable) callback(ctx)
    },
    get(name) {
      if (name === 'sessions') return { get: (id) => sessions.get(id) }
      if (name === 'commands') {
        return {
          register(definition) {
            commands.push(definition)
            return () => {}
          },
        }
      }
      if (name === 'webServer' && serverAvailable) {
        return {
          register(route) {
            routes.push(route)
            return () => {}
          },
        }
      }
      return undefined
    },
    effect(execute, label) {
      effects.push({ label, dispose: execute() })
      return () => {}
    },
  }

  apply(ctx, config)
  return { ctx, registry, sessions, sections, commands, routes, effects, injections, shell, toolName }
}

function invoke(route, { method = 'GET', url = route.path } = {}) {
  const state = {}
  const res = {
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
    },
    end(body) {
      state.body = body
    },
  }
  return Promise.resolve(route.handler({ method, url }, res)).then(() => state)
}

test('apply mounts the tool, the authoring section, the command and the audit routes', () => {
  const mounted = mount()
  assert.equal(typeof mounted.ctx.tools.get('terminal')?.execute, 'function')
  assert.equal(mounted.sections.length, 1)
  assert.equal(mounted.sections[0].name, 'harnessmm')
  assert.match(mounted.sections[0].text, /HarnessMM guarded decision reuse is active/)
  assert.match(mounted.sections[0].text, /chisel_plan/)
  assert.equal(mounted.commands.length, 1)
  assert.equal(mounted.commands[0].name, 'harnessmm')
  assert.equal(mounted.routes.length, 3)
  assert.deepEqual(mounted.routes.map((route) => route.path).sort(), [
    '/api/dsh-harnessmm',
    '/api/dsh-harnessmm/ledger',
    '/api/dsh-harnessmm/status',
  ])
  assert.equal(mounted.effects.length, 2)
  assert.deepEqual(mounted.effects.map((effect) => effect.label).sort(), [
    'dsh-harnessmm: audit routes',
    'dsh-harnessmm: surfaces',
  ])
})

test('audit routes wait for a web server that mounts after the plugin', async () => {
  const mounted = mount({ serverAvailable: false })
  assert.equal(mounted.routes.length, 0)
  assert.equal(mounted.injections.length, 1)
  assert.deepEqual(mounted.injections[0].deps, ['webServer'])

  const scopedRoutes = []
  mounted.injections[0].callback({
    webServer: {
      register(route) {
        scopedRoutes.push(route)
        return () => {}
      },
    },
    effect(execute) {
      execute()
      return () => {}
    },
  })
  assert.equal(scopedRoutes.length, 3)
  assert.deepEqual(scopedRoutes.map((route) => route.path).sort(), [
    '/api/dsh-harnessmm',
    '/api/dsh-harnessmm/ledger',
    '/api/dsh-harnessmm/status',
  ])
})

test('the mounted command reports the ledger, and clear resets it', async () => {
  const mounted = mount()
  const tool = mounted.ctx.tools.get('terminal')
  const exec = { callId: 'call_1', name: 'terminal', arguments: {}, agent: { id: 'session-1' }, signal: liveSignal() }
  await tool.execute({ command: 'echo root', chisel_plan: [candidate({ candidate_id: 'A', arguments: { command: 'echo A' } })] }, exec)

  const command = mounted.commands[0]
  const report = await command.handler({ agent: { id: 'session-1' }, rawInput: '' })
  assert.equal(report.kind, 'success')
  assert.match(report.text, /harnessmm policy v6/)
  assert.match(report.text, /certified substitutions: 1/)

  const cleared = await command.handler({ agent: { id: 'session-1' }, rawInput: 'clear' })
  assert.match(cleared.text, /cleared/)
  const after = await command.handler({ agent: { id: 'session-1' }, rawInput: '' })
  assert.match(after.text, /certified substitutions: 0/)
})

test('the status route reports policy, tool, shell and per-session counters', async () => {
  const mounted = mount({
    text: '<CHISEL_PLAN>{"candidates":[{"candidate_id":"A","predecessor_id":"root","tool":"terminal","arguments":{"command":"echo A"},"guard":{"return_code":0},"required_receipt_fields":["return_code"],"expected_local_cost":{"selector_upper_tokens":2048},"dependency_ids":[]}]}</CHISEL_PLAN>',
  })
  const exec = { callId: 'call_1', name: 'terminal', arguments: {}, agent: { id: 'session-1' }, signal: liveSignal() }
  await mounted.ctx.tools.get('terminal').execute({ command: 'echo root' }, exec)

  const statusRoute = mounted.routes.find((route) => route.path === '/api/dsh-harnessmm/status')
  const status = await invoke(statusRoute)
  assert.equal(status.status, 200)
  const payload = JSON.parse(status.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.plugin, 'dsh-harnessmm')
  assert.equal(payload.policy.version, 6)
  assert.equal(payload.toolName, 'terminal')
  assert.equal(payload.shellTool, 'pwsh')
  assert.equal(payload.totals.certified_substitutions, 1)
  assert.equal(payload.sessions[0].sessionId, 'session-1')
  assert.equal(payload.sessions[0].project, 'E:/project/demo')
  assert.equal(payload.projects[0].project, 'E:/project/demo')
  assert.equal(payload.projects[0].estimated_saved_tokens, payload.totals.estimated_saved_tokens)
  assert.equal(payload.persistence.enabled, false)

  const ledgerRoute = mounted.routes.find((route) => route.path === '/api/dsh-harnessmm/ledger')
  const ledger = await invoke(ledgerRoute, { url: '/api/dsh-harnessmm/ledger?sessionId=session-1' })
  const ledgerPayload = JSON.parse(ledger.body)
  assert.equal(ledgerPayload.sessionId, 'session-1')
  assert.equal(ledgerPayload.events.some((event) => event.kind === 'sar/substitution-certificate'), true)

  const cleared = await invoke(ledgerRoute, { method: 'DELETE', url: '/api/dsh-harnessmm/ledger?sessionId=session-1' })
  assert.equal(JSON.parse(cleared.body).cleared, 'session-1')
})

test('the dashboard route serves a self-contained HTML page', async () => {
  const mounted = mount()
  const dashboard = mounted.routes.find((route) => route.path === '/api/dsh-harnessmm')
  const response = await invoke(dashboard)
  assert.equal(response.status, 200)
  assert.match(response.headers['Content-Type'], /text\/html/)
  assert.match(response.body, /^<!doctype html>/)
  assert.match(response.body, /HarnessMM/)
})

test('a persisted ledger survives a remount and reports its project', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harnessmm-apply-'))
  const file = join(dir, 'ledger.jsonl')
  try {
    const config = { persist: true, storagePath: file }
    const first = mount({ text: planText([candidate()]), config })
    const exec = { callId: 'call_1', name: 'terminal', arguments: {}, agent: { id: 'session-1' }, signal: liveSignal() }
    await first.ctx.tools.get('terminal').execute({ command: 'echo root' }, exec)

    const second = mount({ config })
    const statusRoute = second.routes.find((route) => route.path === '/api/dsh-harnessmm/status')
    const status = JSON.parse((await invoke(statusRoute)).body)
    assert.equal(status.persistence.enabled, true)
    assert.equal(status.totals.certified_substitutions, 1)
    assert.equal(status.sessions[0].sessionId, 'session-1')
    assert.equal(status.sessions[0].project, 'E:/project/demo')
    assert.equal(status.projects[0].project, 'E:/project/demo')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a competing tool name falls back to harnessmm_terminal', () => {
  const registry = new Map([['terminal', { name: 'terminal', description: 'other', parameters: {} }]])
  const shell = makeShell()
  registry.set('pwsh', shell.tool)
  const sections = []
  const ctx = {
    tools: {
      get: (name) => registry.get(name),
      register(definition) {
        registry.set(definition.name, definition)
        return () => {}
      },
      execute: async () => {
        throw new Error('not used')
      },
    },
    systemPrompt: { section: (section) => (sections.push(section), () => {}), getSectionOrder: () => 40 },
    get: () => undefined,
    effect: () => () => {},
  }
  apply(ctx, { persist: false })
  assert.equal(typeof registry.get('harnessmm_terminal')?.execute, 'function')
  assert.match(sections[0].text, /harnessmm_terminal/)
})
