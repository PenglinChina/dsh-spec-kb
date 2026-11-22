/**
 * dsh-spec-kb self-test — exercises the reader against the real stores.
 *
 *   node test/selftest.mjs
 *   SPEC_KB_ROOT=F:/elsewhere node test/selftest.mjs
 *
 * The plugin entry (index.js) imports DSH runtime packages, so this test covers
 * the zero-dependency reader the tools are built on.
 */

import assert from 'node:assert/strict'
import { SpecKbRegistry, discoverKbDirs, normalizeKind, tokenize } from '../lib/kb.js'

const ROOT = process.env.SPEC_KB_ROOT ?? 'F:/MyProject/spec-kb'
const registry = new SpecKbRegistry({ paths: [ROOT], maxResults: 8, maxBodyChars: 6000 })
await registry.ensure()
if (registry.kbs.length === 0) {
  console.log(`SKIP  no portable-spec-kb store under ${ROOT} (this suite needs real stores; test/ci.test.mjs is the data-free one)`)
  process.exit(0)
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

await check('discover stores under the configured root', async () => {
  const dirs = await discoverKbDirs([ROOT])
  assert.ok(dirs.length >= 2, `expected at least 2 stores, found ${dirs.length}`)
})

await check('load both stores with their kb_id', async () => {
  await registry.ensure()
  assert.equal(registry.usable.length, 2)
  assert.deepEqual(
    registry.usable.map((store) => store.kbId).sort(),
    ['autosar-spec-4.3.1', 'neusar-ccore-v3'],
  )
})

await check('autosar index matches its manifest', async () => {
  const store = registry.byId('autosar-spec-4.3.1')
  const stats = store.stats()
  assert.equal(stats.actual.entries, stats.manifestCounts.entries)
  assert.equal(stats.actual.entries, 52262)
  assert.equal(stats.actual.kinds.requirement, 25849)
  assert.equal(stats.actual.modules, 178)
})

await check('neusar index keeps compliance kinds', async () => {
  const store = registry.byId('neusar-ccore-v3')
  const stats = store.stats()
  assert.equal(stats.actual.entries, 2216)
  assert.equal(stats.actual.kinds.compliance_deviation, 528)
  assert.equal(stats.actual.kinds.compliance_limit, 154)
})

await check('exact requirement search', async () => {
  const { hits, total } = await registry.search({ name: 'SWS_NvM_00051', limit: 5 })
  assert.ok(total > 0, 'no hit')
  assert.equal(hits[0].index.name, 'SWS_NvM_00051')
  assert.equal(hits[0].index.kind, 'requirement')
  assert.equal(hits[0].store.kbId, 'autosar-spec-4.3.1')
})

await check('search reports the pre-limit total', async () => {
  const result = await registry.search({ query: 'NvM', limit: 3 })
  assert.equal(result.hits.length, 3)
  assert.ok(result.total > 3, `total was ${result.total}`)
})

await check('full record with body, page and citation', async () => {
  const found = await registry.get('SWS_NvM_00051')
  assert.equal(found.found, true)
  assert.ok(String(found.record.fields.body ?? '').length > 50, 'empty body')
  assert.equal(found.record.page, 27)
  assert.equal(found.record.section, '7.1.2')
  assert.match(found.citation, /autosar-spec-4\.3\.1/)
  assert.match(found.citation, /§7\.1\.2/)
})

await check('requirement trace exposes upstream ids', async () => {
  const result = await registry.trace('SWS_NvM_00051')
  assert.equal(result.found, true)
  const upstream = result.upstream.map((item) => item.id)
  assert.ok(upstream.includes('SRS_Mem_00041'), `upstream was ${upstream.join(',')}`)
})

await check('trace resolves upstream ids stored only in section text', async () => {
  const result = await registry.trace('SWS_NvM_00051')
  const srs = result.upstream.find((item) => item.id === 'SRS_Mem_00041')
  assert.equal(srs.found, true, 'SRS_Mem_00041 should resolve through a mentioning section')
  assert.equal(srs.via, 'mention')
  assert.equal(srs.module, 'MemoryServices')
  assert.match(srs.citation, /§6\.1\.1\.1/)
})

await check('section text loads by module + section number', async () => {
  const result = await registry.sections('NvM', { section: '7.1.2', kb: 'autosar-spec-4.3.1' })
  assert.equal(result.found, true)
  assert.equal(result.module, 'NVRAMManager', 'short module name should resolve to the AUTOSAR document module')
  assert.ok(result.items.length > 0, 'no section item')
  assert.match(result.items[0].text, /SWS_NvM/)
})

await check('module aliases resolve in both stores', async () => {
  const autosar = registry.byId('autosar-spec-4.3.1')
  const neusar = registry.byId('neusar-ccore-v3')
  assert.equal(autosar.resolveModule('Dcm'), 'DiagnosticCommunicationManager')
  assert.equal(autosar.resolveModule('NvM'), 'NVRAMManager')
  assert.equal(neusar.resolveModule('诊断'), 'Dcm')
  assert.equal(neusar.resolveModule('NvM'), 'NvM')
})

await check('compliance findings filter by module and subtype', async () => {
  const hits = await registry.compliance({ module: 'Dcm', kb: 'neusar-ccore-v3', limit: 5 })
  assert.ok(hits.length > 0, 'no compliance hit')
  assert.ok(hits.every((hit) => String(hit.index.kind).startsWith('compliance_')))
  assert.equal(normalizeKind('deviation'), 'compliance_deviation')
})

await check('evidence brief is cited and bounded', async () => {
  const brief = await registry.brief('NvM write protection', { modules: ['NvM'], limit: 2 })
  assert.match(brief, /Spec knowledge base evidence/)
  assert.match(brief, /SWS_/)
  assert.match(brief, /§/)
  assert.ok(brief.length < 20000, `brief too long: ${brief.length}`)
})

await check('structural validation reports the store defects', async () => {
  const report = await registry.validate({ deep: false })
  assert.equal(report.reports.length, 2)
  const autosar = report.reports.find((item) => item.kb === 'autosar-spec-4.3.1')
  const uniqueness = autosar.checks.find((item) => item.check === 'unique record ids')
  assert.equal(uniqueness.status, 'FAIL')
  assert.match(uniqueness.detail, /duplicated ids/)
  assert.equal(report.ok, false)
})

await check('tokenizer and kind normalization helpers', async () => {
  assert.deepEqual(tokenize('NvM，写保护'), ['nvm', '写保护'])
  assert.equal(normalizeKind('unsupported'), 'compliance_unsupported')
  assert.equal(normalizeKind(undefined), undefined)
})

console.log(`\n${passed}/${passed + failed} checks passed`)
process.exit(failed === 0 ? 0 : 1)
