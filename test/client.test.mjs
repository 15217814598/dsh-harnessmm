/**
 * Client-module contract tests: the browser bundle is a plain script meant for
 * the Host's ModuleLoader, so these tests evaluate it with a stubbed loader and
 * a stubbed React to prove the registration contract without a browser.
 *
 * @module dsh-harnessmm/test/client
 */

import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

/** Evaluate the client script against a stubbed ModuleLoader; return the applied module. */
function loadClientModule() {
  const captured = []
  const window = { __ModuleLoader__: { load: (module) => captured.push(module) } }
  const react = { createElement: (type, props) => ({ type, props }) }
  const require = (name) => {
    if (name !== 'react') throw new Error(`unexpected require: ${name}`)
    return react
  }
  new Function('window', 'require', source)(window, require)
  assert.equal(captured.length, 1)
  assert.equal(typeof captured[0].factory, 'function')
  return captured[0].factory(require)
}

test('the client module registers against the module loader', () => {
  const module = loadClientModule()
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual([...module.inject].sort(), ['layout', 'locale', 'slots'])
})

test('the client applies into the shell.bottom slot and a main panel', () => {
  const module = loadClientModule()
  const injected = []
  const descriptors = []
  const renders = []
  const ctx = {
    slots: {
      inject: (slot, register) => {
        injected.push(slot)
        register()
      },
      register: (descriptor, render) => {
        descriptors.push(descriptor)
        renders.push(render)
        return () => {}
      },
    },
  }
  module.apply(ctx)
  assert.deepEqual(injected.slice().sort(), ['main', 'shell.bottom'])
  assert.deepEqual(descriptors, [
    { name: 'shell.bottom', id: 'harnessmm-bar', order: 11 },
    { name: 'main', key: 'harnessmm' },
  ])
  for (const render of renders) {
    const element = render()
    assert.equal(typeof element.type, 'function')
    assert.ok(element.props && typeof element.props.t === 'function')
  }
})

test('the client falls back to the inline dictionary without a locale service', () => {
  const module = loadClientModule()
  const descriptors = []
  const renders = []
  const ctx = {
    slots: {
      inject: (slot, register) => register(),
      register: (descriptor, render) => {
        descriptors.push(descriptor)
        renders.push(render)
        return () => {}
      },
    },
  }
  module.apply(ctx)
  const panel = renders[1]()
  const text = panel.props.t('page.title')
  assert.equal(text, 'HarnessMM 节省')
  assert.equal(panel.props.t('card.saved', {}) , '估算节省 token')
  assert.equal(panel.props.lang, 'zh')
})

test('every t() key exists in both the zh and en dictionaries', () => {
  const keys = new Set([...source.matchAll(/\bt\('([a-z][a-z0-9.]*)'/g)].map((match) => match[1]))
  assert.ok(keys.size >= 20, `expected a real dictionary, found ${keys.size} keys`)
  for (const key of keys) {
    const occurrences = source.split(`'${key}':`).length - 1
    assert.ok(occurrences >= 2, `dictionary key needs a zh and an en entry: ${key}`)
  }
})
