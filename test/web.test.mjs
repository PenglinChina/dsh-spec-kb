/**
 * Integration test for the Settings API the browser page uses.
 *
 * Starts a plain Node HTTP server over the same route handlers the plugin
 * registers, against a temporary DSH_HOME, so saving/resetting paths and
 * browsing directories are verified without the Harness.
 *
 *   node test/web.test.mjs
 */

import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const DSH_BASE = mkdtempSync(join(tmpdir(), 'dsh-spec-kb-web-'))
process.env.DSH_HOME = DSH_BASE

const { SpecKbRegistry } = await import('../lib/kb.js')
const { createSpecKbRoutes } = await import('../lib/routes.js')
const { settingsFile } = await import('../lib/settings.js')

const ROOT = process.env.SPEC_KB_ROOT ?? 'F:/MyProject/spec-kb'
const defaults = [ROOT]
const registry = new SpecKbRegistry({ paths: defaults })
const routes = createSpecKbRoutes({ registry, defaults })

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const route = routes.find((item) => item.path === url.pathname)
  if (route === undefined) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
    return
  }
  try {
    await route.handler(req, res)
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: String(error?.message ?? error) }))
  }
})
await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
const base = `http://127.0.0.1:${server.address().port}`

async function get(path) {
  const response = await fetch(`${base}${path}`)
  return { status: response.status, body: await response.json() }
}

async function post(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

let passed = 0
let failed = 0
async function check(label, fn) {
  try {
    await fn()
    console.log(`PASS  ${label}`)
    passed += 1
  } catch (error) {
    console.log(`FAIL  ${label}\n      ${String(error?.message ?? error).split('\n')[0]}`)
    failed += 1
  }
}

await check('status reports the bundle defaults and both stores', async () => {
  const { status, body } = await get('/api/spec-kb/status')
  assert.equal(status, 200)
  assert.equal(body.source, 'bundle')
  assert.deepEqual(body.paths, [resolve(ROOT)])
  assert.equal(body.stores.length, 2)
  assert.deepEqual(body.stores.map((store) => store.kb_id).sort(), ['autosar-spec-4.3.1', 'neusar-ccore-v3'])
  assert.ok(body.stores.every((store) => store.entries > 0))
})

await check('browse lists a store directory and marks it', async () => {
  const { body } = await get(`/api/spec-kb/browse?path=${encodeURIComponent('F:/MyProject/spec-kb/autosar-spec-kb')}`)
  assert.equal(body.ok, true)
  assert.equal(body.isStore, true)
  assert.ok(Array.isArray(body.directories))
})

await check('browse reaches a parent directory from a child', async () => {
  const { body } = await get(`/api/spec-kb/browse?path=${encodeURIComponent('F:/MyProject/spec-kb')}`)
  assert.equal(body.ok, true)
  const names = body.directories.map((entry) => entry.name)
  assert.ok(names.includes('autosar-spec-kb'))
  assert.ok(names.includes('neusar-spec-kb'))
  assert.ok(body.directories.every((entry) => entry.store === true))
})

await check('browse a missing directory reports the failure', async () => {
  const { body } = await get(`/api/spec-kb/browse?path=${encodeURIComponent('F:/__does_not_exist__')}`)
  assert.equal(body.ok, false)
  assert.ok(String(body.error).length > 0)
})

await check('saving an invalid path is refused and writes nothing', async () => {
  const { status, body } = await post('/api/spec-kb/paths', { paths: ['F:/__does_not_exist__'] })
  assert.equal(status, 400)
  assert.ok(Array.isArray(body.errors) && body.errors.length === 1)
  assert.equal(existsSync(settingsFile()), false)
})

await check('saving a valid path persists it and reloads the stores', async () => {
  const { status, body } = await post('/api/spec-kb/paths', { paths: [ROOT] })
  assert.equal(status, 200)
  assert.equal(body.source, 'settings')
  assert.equal(body.stores.length, 2)
  assert.equal(existsSync(settingsFile()), true)
})

await check('status reflects the saved override', async () => {
  const { body } = await get('/api/spec-kb/status')
  assert.equal(body.source, 'settings')
  assert.deepEqual(body.paths, [resolve(ROOT)])
})

await check('an empty path list is refused', async () => {
  const { status } = await post('/api/spec-kb/paths', { paths: [] })
  assert.equal(status, 400)
})

await check('reset removes the override and restores the defaults', async () => {
  const { status, body } = await post('/api/spec-kb/reset', {})
  assert.equal(status, 200)
  assert.equal(body.source, 'bundle')
  assert.equal(existsSync(settingsFile()), false)
  assert.equal(body.stores.length, 2)
})

await check('routes reject the wrong HTTP method', async () => {
  const { status } = await get('/api/spec-kb/paths')
  assert.equal(status, 405)
})

await check('a cross-origin POST is refused', async () => {
  const response = await fetch(`${base}/api/spec-kb/reset`, {
    method: 'POST',
    headers: { origin: 'http://evil.example', 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(response.status, 403)
})

await check('a request for a foreign host name is refused', async () => {
  const status = await new Promise((settle, reject) => {
    const probe = request(`${base}/api/spec-kb/status`, { headers: { host: 'evil.example:1234' } }, (response) => {
      response.resume()
      settle(response.statusCode)
    })
    probe.on('error', reject)
    probe.end()
  })
  assert.equal(status, 403)
})

console.log(`\n${passed}/${passed + failed} checks passed`)
server.close()
rmSync(DSH_BASE, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
