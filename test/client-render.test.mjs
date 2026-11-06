/**
 * Render smoke test for the savings view. React is optional here (the plugin
 * itself has no npm dependencies), so the test skips when it cannot be resolved
 * from a parent node_modules — the registration contract still runs in
 * `client.test.mjs`.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

let React
let renderToStaticMarkup
try {
  React = (await import('react')).default
  ;({ renderToStaticMarkup } = await import('react-dom/server'))
} catch {
  /* optional: no React in this checkout */
}

test('the savings view renders with a session picker', { skip: React === undefined }, () => {
  const captured = []
  const window = { __ModuleLoader__: { load: (module) => captured.push(module) } }
  const require = (name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  }
  new Function('window', 'require', source)(window, require)
  const module = captured[0].factory(require)

  const renders = []
  const ctx = {
    slots: {
      inject: (name, register) => register(),
      register: (descriptor, render) => {
        renders.push({ descriptor, render })
        return () => {}
      },
    },
    locale: { language: 'zh' },
  }
  module.apply(ctx)
  assert.equal(renders.length, 1)
  assert.equal(renders[0].descriptor.name, 'conversation.view')

  const html = renderToStaticMarkup(renders[0].render({ sessionId: 'session-1' }))
  assert.match(html, /HarnessMM 节省/)
  assert.match(html, /class="dhm-select"/)
  assert.match(html, /<optgroup/)
  assert.match(html, /value="session-1"/)
  assert.match(html, /正在读取 HarnessMM 账本/)
})
