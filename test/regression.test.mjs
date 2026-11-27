/**
 * Regression tests for the defects found in the self-review.
 *
 * Each test names the defect it locks down, so a future change that
 * reintroduces the bug fails here rather than in an agent's answer.
 */
import assert from 'node:assert/strict'
import { SpecKbRegistry, expandQuery, citationOf } from '../lib/kb.js'

const ROOT = process.env.SPEC_KB_ROOT ?? 'F:/MyProject/spec-kb'
const registry = new SpecKbRegistry({ paths: [ROOT] })
await registry.ensure()
if (registry.kbs.length === 0) {
  console.log(`SKIP  no portable-spec-kb store under ${ROOT} (this suite needs real stores; test/ci.test.mjs is the data-free one)`)
  process.exit(0)
}
const autosar = registry.byId('autosar-spec-4.3.1')
const neusar = registry.byId('neusar-ccore-v3')

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

// ── Defect A: a Chinese question must reach the English specification ───────
await check('A1: Chinese module term expands to an English term', () => {
  assert.deepEqual(expandQuery('诊断'), ['诊断', 'dcm'])
  assert.deepEqual(expandQuery('写保护'), ['写保护', 'write', 'protection'])
})

await check('A2: a Chinese query finds records in the English store', () => {
  const result = autosar.search({ query: '写保护', limit: 5 })
  assert.ok(result.total > 0, 'no hits for a Chinese query')
  const top = result.hits[0].index
  assert.ok(
    /write|protection/i.test(`${top.name} ${top.title}`),
    `top hit is unrelated: ${top.module}/${top.name}`,
  )
})

await check('A3: a Chinese diagnostic query reaches the Dcm documents', () => {
  const result = autosar.search({ query: '诊断安全访问', limit: 5 })
  assert.ok(result.total > 0, 'no hits for 诊断安全访问')
})

await check('A4: a Chinese query still finds the Chinese vendor manual', () => {
  const result = neusar.search({ query: '多块任务', limit: 3 })
  assert.ok(result.total > 0, 'no hits in the Chinese manual')
})

await check('A5: a nonsense query still returns nothing', () => {
  assert.equal(autosar.search({ query: 'zzzqqqnotarealtopic', limit: 5 }).total, 0)
})

await check('A6: brief() with a Chinese topic finds evidence', async () => {
  const brief = await registry.brief('写保护', { modules: ['NvM'], limit: 2 })
  assert.ok(!brief.includes('not covered by the knowledge base'), 'brief found nothing')
})

// ── Defect B: search hits and full records must cite identically ────────────
await check('B1: a search hit carries the source document', () => {
  const hit = autosar.search({ name: 'SWS_NvM_00051', limit: 1 }).hits[0]
  assert.ok(hit.index.document.includes('NVRAMManager'), 'no document in the index entry')
  assert.ok(hit.index.document.length > 0)
})

await check('B2: hit citation and full-record citation agree', () => {
  const hit = autosar.search({ name: 'SWS_NvM_00051', limit: 1 }).hits[0]
  const hitCitation = citationOf(autosar.kbId, hit.index)
  const fullCitation = citationOf(autosar.kbId, autosar.record(hit.index))
  assert.equal(hitCitation, fullCitation)
})

// ── Defect C: an empty search must not return the whole store ────────────────
await check('C1: an empty search returns no hits', () => {
  const result = autosar.search({})
  assert.equal(result.total, 0)
  assert.equal(result.empty, true)
})

await check('C2: a module filter alone is not enough to dump a module', () => {
  const result = autosar.search({ module: 'NVRAMManager' })
  assert.equal(result.total, 0)
})

// ── Defect D: module resolution must not silently pick a wrong module ───────
await check('D1: an ambiguous prefix resolves to the generic document', () => {
  assert.equal(autosar.resolveModule('COM'), 'COM')
  assert.equal(autosar.resolveModule('CAN'), 'CAN')
})

await check('D2: an exact module name still wins', () => {
  assert.equal(autosar.resolveModule('COMManager'), 'COMManager')
  assert.equal(autosar.resolveModule('CANDriver'), 'CANDriver')
})

await check('D3: a short BSW name resolves to its specification module', () => {
  assert.equal(autosar.resolveModule('Dcm'), 'DiagnosticCommunicationManager')
  assert.equal(autosar.resolveModule('NvM'), 'NVRAMManager')
  assert.equal(autosar.resolveModule('Rte'), 'RTE')
})

await check('D4: an unknown module resolves to nothing', () => {
  assert.equal(autosar.resolveModule('NoSuchModule'), undefined)
})

// ── Defect E: an unknown kb filter must not widen the search ───────────────
await check('E1: search with an unknown kb returns nothing', async () => {
  const result = await registry.search({ query: 'NvM', kb: 'nope' })
  assert.equal(result.total, 0)
  assert.equal(result.unknownKb, 'nope')
})

await check('E2: get() with an unknown kb reports it', async () => {
  const found = await registry.get('SWS_NvM_00051', { kb: 'nope' })
  assert.equal(found.found, false)
  assert.equal(found.unknownKb, 'nope')
})

// ── Defect F: compliance results must not include non-compliance records ───
await check('F1: compliance() returns only compliance findings', async () => {
  const hits = await registry.compliance({ module: 'Dcm', kb: 'neusar-ccore-v3', limit: 10 })
  assert.ok(hits.length > 0, 'no compliance hits')
  assert.ok(
    hits.every((hit) => String(hit.index.kind).startsWith('compliance_')),
    `non-compliance record leaked: ${hits.find((h) => !String(h.index.kind).startsWith('compliance_'))?.index.kind}`,
  )
})

await check('F2: compliance() honours the subtype filter', async () => {
  const hits = await registry.compliance({ module: 'Dcm', kind: 'unsupported', kb: 'neusar-ccore-v3', limit: 10 })
  assert.ok(hits.length > 0, 'no unsupported findings')
  assert.ok(hits.every((hit) => hit.index.kind === 'compliance_unsupported'))
})

await check('F3: compliance() with no scope returns nothing', () => {
  const result = neusar.compliance({})
  assert.equal(result.total, 0)
})

await check('F4: a module-only compliance query lists that module', () => {
  const result = neusar.compliance({ module: 'Dcm' })
  assert.ok(result.total > 100, `expected the module's findings, got ${result.total}`)
  assert.ok(result.hits.every((hit) => hit.index.module === 'Dcm'))
})

// ── Defect B4: Chinese module terms must reach both stores' module names ──
await check('B4: 时间同步 and 时基 reach the AUTOSAR modules', async () => {
  const sync = await registry.search({ query: '时间同步', kb: 'autosar-spec-4.3.1' })
  assert.ok(sync.total > 0, 'AUTOSAR store returned nothing for 时间同步')
  const base = await registry.search({ query: '时基', kb: 'autosar-spec-4.3.1' })
  assert.ok(base.total > 0, 'AUTOSAR store returned nothing for 时基')
})

await check('B4: 收发器 reaches the AUTOSAR transceiver documents', async () => {
  const trcv = await registry.search({ query: '收发器', kb: 'autosar-spec-4.3.1' })
  assert.ok(trcv.total > 0)
  assert.ok(trcv.hits.some((hit) => hit.index.module === 'CANTransceiverDriver'))
})

await check('B4: the module filter accepts the same Chinese terms', () => {
  assert.equal(autosar.resolveModule('时间同步'), 'SynchronizedTimeBaseManager')
  assert.equal(neusar.resolveModule('时间同步'), 'StbM_解耦')
  assert.equal(autosar.resolveModule('收发器'), 'CANTransceiverDriver')
})

// ── C2: an unknown kb on compliance must not widen the scope ──────────────
await check('C2: compliance with an unknown kb returns nothing', async () => {
  const hits = await registry.compliance({ kb: 'nope' })
  assert.equal(hits.length, 0)
  assert.equal(registry.byId('nope'), null)
})

// ── Byte ranges: records are re-read from the store, never held in memory ──
await check('G1: a big-store record is read back from its byte range', async () => {
  const found = await registry.get('SWS_NvM_00051')
  assert.equal(found.found, true)
  assert.ok(String(found.record?.fields?.body ?? found.record?.summary ?? '').length > 40)
  assert.equal(autosar.text, '')
})

console.log(`\n${passed}/${passed + failed} checks passed`)
process.exit(failed === 0 ? 0 : 1)
