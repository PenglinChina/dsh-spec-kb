/**
 * Smoke test for the browser half without a browser: load the module through a
 * fake module loader, run `apply` against a fake Cordis context, and render the
 * settings section once with a minimal React stub.
 *
 *   node test/client.test.mjs
 */

import assert from 'node:assert/strict'

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load: (definition) => {
      loaded = definition
    },
  },
}

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}

const requireStub = (name) => {
  if (name === 'react') return React
  throw new Error(`unexpected module: ${name}`)
}

await import('../client.js')
assert.ok(loaded !== null, 'client.js did not call window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-spec-kb')

const exports = loaded.factory(requireStub)
assert.equal(typeof exports.apply, 'function')
assert.deepEqual(exports.inject, ['slots', 'locale'])

let registration = null
const ctx = {
  locale: {
    register: () => () => {},
    bind: () => (key) => key,
  },
  effect: (fn) => {
    const disposer = fn()
    return () => disposer?.()
  },
  slots: {
    inject: (_name, fn) => fn(),
    register: (options, Component) => {
      registration = { options, Component }
      return () => {}
    },
  },
}

exports.apply(ctx)

let passed = 0
let failed = 0
function check(label, fn) {
  try {
    fn()
    console.log(`PASS  ${label}`)
    passed += 1
  } catch (error) {
    console.log(`FAIL  ${label}\n      ${String(error?.message ?? error).split('\n')[0]}`)
    failed += 1
  }
}

check('registers a settings section', () => {
  assert.ok(registration !== null, 'no slot registration')
  assert.equal(registration.options.name, 'settings.section')
  assert.equal(registration.options.id, 'spec-kb')
  assert.equal(registration.options.locale, 'spec-kb')
  assert.equal(typeof registration.options.label, 'function')
  assert.equal(typeof registration.Component, 'function')
})

check('section label comes from the locale', () => {
  assert.equal(registration.options.label(), 'nav')
})

check('section renders its first paint', () => {
  const element = registration.Component({ t: (key) => key })
  assert.ok(element && element.type === 'div', 'component returned no root element')
  const rendered = JSON.stringify(element, (key, value) => (key === 'children' ? value : value))
  assert.ok(rendered.includes('title'), 'title text missing')
  assert.ok(rendered.includes('configured'), 'path section missing')
  assert.ok(rendered.includes('loaded'), 'store section missing')
})

console.log(`\n${passed}/${passed + failed} checks passed`)
process.exit(failed === 0 ? 0 : 1)
