/**
 * CI test: runs without any external knowledge base.
 *
 * The other suites read the real stores under `SPEC_KB_ROOT` (default
 * `F:/spec-kb`) and skip when that path is absent, so they cannot run on a clean
 * runner. This suite builds fixture stores in a temp directory — an English store
 * modelled on the AUTOSAR layout, a Chinese vendor store with compliance
 * findings, a BOM-prefixed cache fixture and a plain JSONL store — and exercises
 * the reader, discovery, the citations and the HTTP routes against them.
 *
 *   node test/ci.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-spec-kb-ci-'))
process.env.DSH_HOME = home

const { SpecKb, SpecKbRegistry, bodyOf, citationOf, discoverKbDirs, looksLikeStoreSync } = await import('../lib/kb.js')
const { createSpecKbRoutes } = await import('../lib/routes.js')

// ── fixture ────────────────────────────────────────────────────────────────

const root = join(home, 'stores')

function manifest(kbId, title, language, modules, count) {
  return {
    kb_id: kbId,
    name: { zh: title, en: title },
    version: '4.3.1',
    language,
    format: { name: 'portable-spec-kb', version: '1.0', encoding: 'utf-8' },
    files: { entries: 'entries.jsonl', sections: 'sections/' },
    counts: { entries: count },
    modules,
  }
}

function writeStore(kbId, title, language, entries, sections = {}, options = {}) {
  const dir = join(root, kbId)
  mkdirSync(join(dir, 'sections'), { recursive: true })
  const modules = [...new Set(entries.map((entry) => entry.module))]
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest(kbId, title, language, modules, entries.length), null, 1))
  const body = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
  writeFileSync(join(dir, 'entries.jsonl'), (options.bom ? '\uFEFF' : '') + body)
  for (const [module, items] of Object.entries(sections)) {
    writeFileSync(join(dir, 'sections', `${module}.jsonl`), items.map((item) => JSON.stringify(item)).join('\n') + '\n')
  }
}

writeStore(
  'autosar-spec-4.3.1',
  'AUTOSAR Classic Platform 4.3.1',
  'en',
  [
    {
      id: 'autosar-spec-4.3.1::SWS_NvM_00051',
      kind: 'requirement',
      module: 'NVRAMManager',
      name: 'SWS_NvM_00051',
      title: 'Write protection of NvRAM blocks',
      section: '7.2.2.13',
      page: 48,
      source: { document: 'AUTOSAR_SWS_NVRAMManager.pdf', document_id: 'AUTOSAR_SWS_NVRAMManager' },
      upstream: ['SRS_Mem_00034'],
      requirement: 'SWS_NvM_00051',
      fields: { body: 'The NvM module shall support write protection of NvRAM blocks against unintended writes.' },
    },
    {
      id: 'autosar-spec-4.3.1::NvM_WriteBlock',
      kind: 'api',
      module: 'NVRAMManager',
      name: 'NvM_WriteBlock',
      section: '8.1.2',
      page: 99,
      source: { document: 'AUTOSAR_SWS_NVRAMManager.pdf' },
      fields: { syntax: 'Std_ReturnType NvM_WriteBlock(NvM_BlockIdType BlockId, const void* NvM_SrcPtr)' },
    },
    {
      id: 'autosar-spec-4.3.1::NvMBlockDescriptor_NvMBlockJobPriority',
      kind: 'config',
      module: 'NVRAMManager',
      name: 'NvMBlockJobPriority',
      section: '9.1',
      page: 120,
      source: { document: 'AUTOSAR_SWS_NVRAMManager.pdf' },
      fields: { body: 'Job priority of the NvM block, used when several jobs are queued.' },
    },
    {
      id: 'autosar-spec-4.3.1::Dcm',
      kind: 'glossary',
      module: 'DiagnosticCommunicationManager',
      name: 'Dcm',
      section: '1',
      page: 3,
      source: { document: 'AUTOSAR_SWS_DiagnosticCommunicationManager.pdf' },
      fields: { definition: 'Diagnostic Communication Manager: handles diagnostic services and security access.' },
    },
    {
      id: 'autosar-spec-4.3.1::Dcm_SecurityAccess',
      kind: 'api',
      module: 'DiagnosticCommunicationManager',
      name: 'Dcm_SecurityAccess',
      section: '8.2',
      page: 71,
      source: { document: 'AUTOSAR_SWS_DiagnosticCommunicationManager.pdf' },
      fields: { syntax: 'Std_ReturnType Dcm_SecurityAccess(uint8 level)' },
    },
    {
      id: 'autosar-spec-4.3.1::SynchronizedTimeBase',
      kind: 'section',
      module: 'SynchronizedTimeBaseManager',
      name: 'Synchronized time base',
      section: '2',
      page: 9,
      source: { document: 'AUTOSAR_SWS_SynchronizedTimeBaseManager.pdf' },
      fields: { body: 'This module provides time synchronisation between ECUs over the configured bus.' },
    },
    {
      id: 'autosar-spec-4.3.1::CANTransceiverDriver',
      kind: 'section',
      module: 'CANTransceiverDriver',
      name: 'CAN transceiver driver',
      section: '1',
      page: 5,
      source: { document: 'AUTOSAR_SWS_CANTransceiverDriver.pdf' },
      fields: { body: 'Driver for the CAN transceiver, including mode and wake-up handling.' },
    },
    {
      id: 'autosar-spec-4.3.1::SRS_Mem_00034',
      kind: 'section',
      module: 'MemoryServices',
      name: '[SRS_Mem_00034] Write accesses of the NVRAM manager',
      section: '5.6',
      page: 34,
      source: { document: 'AUTOSAR_SRS_MemoryServices.pdf' },
      fields: { body: 'The NVRAM manager shall protect NvRAM blocks against unintended write accesses.' },
    },
  ],
)

// A BOM-prefixed store with more modules than the section cache keeps: the
// index stores byte ranges into the file, so the three BOM bytes must be
// accounted for or every record parses as garbage.
const cacheModules = Array.from({ length: 20 }, (_, i) => `Mod${String(i).padStart(2, '0')}`)
writeStore(
  'bom-fixture',
  'BOM and section-cache fixture',
  'en',
  cacheModules.map((module) => ({
    id: `bom-fixture::${module}`,
    kind: 'section',
    module,
    name: `${module} record`,
    section: '1',
    page: 1,
    source: { document: 'bom.pdf' },
    fields: { body: `${module} body behind a byte order mark` },
  })),
  Object.fromEntries(
    cacheModules.map((module) => [module, [{ section: '1', page: 1, title: module, text: `${module} section text` }]]),
  ),
  { bom: true },
)

writeStore(
  'neusar-ccore-v3',
  'NeuSAR cCore V3.0',
  'zh',
  [
    {
      id: 'neusar-ccore-v3::Dcm_Init',
      kind: 'api',
      module: 'Dcm',
      name: 'Dcm_Init',
      section: '3.1',
      page: 12,
      source: { document: 'NeuSAR_cCore_V3.0_Dcm.pdf' },
      fields: { syntax: 'void Dcm_Init(const Dcm_ConfigType* config)' },
    },
    {
      id: 'neusar-ccore-v3::Dcm_SecurityAccessTiming',
      kind: 'compliance_deviation',
      module: 'Dcm',
      name: 'Dcm 安全访问时序偏差',
      section: '4.2',
      page: 30,
      source: { document: 'NeuSAR_cCore_V3.0_Dcm.pdf' },
      fields: { body: '安全访问的种子-密钥时序与 AUTOSAR 规范不一致。' },
    },
    {
      id: 'neusar-ccore-v3::StbM_FlexRay',
      kind: 'compliance_unsupported',
      module: 'StbM_解耦',
      name: '时间同步不支持 FlexRay',
      section: '2',
      page: 8,
      source: { document: 'NeuSAR_cCore_V3.0_StbM.pdf' },
      fields: { body: '当前实现只在 CAN 上提供时间同步，FlexRay 不支持。' },
    },
  ],
  {
    StbM_解耦: [
      { section: '2.1', page: 9, title: '时间同步配置', body: '配置时间同步的主从角色与同步周期。' },
      { section: '2.2', page: 10, title: '时基状态', body: '时基状态机与同步丢失处理。' },
    ],
  },
)

// A plain JSONL store: no manifest, foreign field names, one sections.jsonl.
const plainDir = join(root, 'plain-kb')
mkdirSync(plainDir, { recursive: true })
writeFileSync(
  join(plainDir, 'data.jsonl'),
  [
    JSON.stringify({ id: 'p1', title: 'Alpha rule', text: 'Alpha body explains write protection.', category: 'Core', pageNo: 12, chapter: '3.1' }),
    JSON.stringify({ id: 'p2', title: 'Beta rule', content: 'Beta body about diagnostics.', category: 'Diag' }),
  ].join('\n') + '\n',
)
writeFileSync(
  join(plainDir, 'sections.jsonl'),
  [
    JSON.stringify({ module: 'Core', section: '3.1', page: 12, title: 'Alpha section', text: 'Alpha section text' }),
    JSON.stringify({ module: 'Diag', section: '4', page: 20, title: 'Beta section', text: 'Beta section text' }),
  ].join('\n') + '\n',
)

// ── harness ────────────────────────────────────────────────────────────────

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

const registry = new SpecKbRegistry({ paths: [root] })
await registry.ensure()
const autosar = registry.byId('autosar-spec-4.3.1')
const neusar = registry.byId('neusar-ccore-v3')

// ── reader and registry ────────────────────────────────────────────────────

await check('both fixture stores load', () => {
  assert.ok(autosar, 'autosar fixture store missing')
  assert.ok(neusar, 'vendor fixture store missing')
  assert.equal(autosar.entries.length, 8)
  assert.equal(neusar.entries.length, 3)
})

await check('a Chinese query reaches the English store', () => {
  const result = autosar.search({ query: '写保护', limit: 5 })
  assert.ok(result.total > 0, 'no hits for 写保护')
  assert.ok(/write|protection/i.test(`${result.hits[0].index.name} ${result.hits[0].index.title}`))
})

await check('time-sync terms resolve in both stores', () => {
  const en = autosar.search({ query: '时间同步', limit: 5 })
  assert.ok(en.hits.some((hit) => hit.index.module === 'SynchronizedTimeBaseManager'))
  const zh = neusar.search({ query: '时间同步', limit: 5 })
  assert.ok(zh.hits.some((hit) => hit.index.module === 'StbM_解耦'))
})

await check('an empty query is refused instead of dumping the store', async () => {
  const empty = await registry.search({})
  assert.equal(empty.total, 0)
  assert.equal(empty.hits.length, 0)
  const moduleOnly = await registry.search({ module: 'Dcm' })
  assert.equal(moduleOnly.total, 0)
})

await check('an unknown kb is reported and never widens the scope', async () => {
  const found = await registry.search({ query: 'write', kb: 'nope' })
  assert.equal(found.total, 0)
  assert.equal(found.unknownKb, 'nope')
  const record = await registry.get('SWS_NvM_00051', { kb: 'nope' })
  assert.equal(record.found, false)
  assert.equal(record.unknownKb, 'nope')
  const findings = await registry.compliance({ kb: 'nope' })
  assert.equal(findings.length, 0)
  assert.equal(registry.byId('nope'), null)
})

await check('compliance returns findings only, and needs a scope', async () => {
  const hits = await registry.compliance({ module: 'Dcm', kb: 'neusar-ccore-v3' })
  assert.ok(hits.length > 0)
  assert.ok(hits.every((hit) => String(hit.index.kind).startsWith('compliance_')))
  const subtype = await registry.compliance({ module: 'StbM_解耦', kind: 'unsupported', kb: 'neusar-ccore-v3' })
  assert.ok(subtype.length > 0)
  assert.ok(subtype.every((hit) => hit.index.kind === 'compliance_unsupported'))
  assert.equal((await registry.compliance({})).length, 0)
})

await check('Chinese module terms resolve per store', () => {
  assert.equal(autosar.resolveModule('Dcm'), 'DiagnosticCommunicationManager')
  assert.equal(autosar.resolveModule('时间同步'), 'SynchronizedTimeBaseManager')
  assert.equal(neusar.resolveModule('时间同步'), 'StbM_解耦')
  assert.equal(autosar.resolveModule('NoSuchModule'), undefined)
})

await check('a hit cites exactly like the record it points at', async () => {
  const hit = autosar.search({ name: 'SWS_NvM_00051' }).hits[0]
  const fromHit = citationOf(autosar.kbId, hit.index)
  const found = await registry.get(hit.index.id)
  assert.equal(fromHit, found.citation)
  assert.ok(fromHit.includes('AUTOSAR_SWS_NVRAMManager'))
  assert.ok(fromHit.includes('§7.2.2.13'))
  assert.ok(fromHit.includes('p.48'))
})

await check('trace resolves an upstream id through the section that mentions it', async () => {
  const result = await autosar.trace('SWS_NvM_00051')
  assert.equal(result.found, true)
  const upstream = result.upstream.find((item) => item.id === 'SRS_Mem_00034')
  assert.ok(upstream?.found, 'upstream id not resolved')
  assert.equal(upstream.via, 'mention')
})

await check('sections load lazily for one module', async () => {
  const result = await neusar.sections('StbM_解耦')
  assert.equal(result.found, true)
  assert.equal(result.total, 2)
})

await check('the fixture validates against its own manifest', async () => {
  const report = await autosar.validate()
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter((item) => item.status !== 'PASS')))
})

await check('records are read back from byte ranges (BOM and UTF-8)', async () => {
  const bom = registry.byId('bom-fixture')
  assert.equal(bom.text, '', 'the source text must not be retained')
  const found = await registry.get('bom-fixture::Mod00')
  assert.equal(found.found, true)
  assert.match(String(found.record?.fields?.body ?? ''), /byte order mark/)
  const nvm = await registry.get('SWS_NvM_00051')
  assert.match(String(nvm.record?.fields?.body ?? ''), /write protection/i)
  const zh = await registry.get('neusar-ccore-v3::Dcm_SecurityAccessTiming')
  assert.equal(zh.found, true)
  assert.match(String(zh.record?.fields?.body ?? ''), /安全访问/)
})

await check('the section cache keeps a bounded number of modules', async () => {
  const store = registry.byId('bom-fixture')
  for (const module of cacheModules) await store.sections(module)
  assert.ok(store.sectionsCache.size <= 16, `cache grew to ${store.sectionsCache.size}`)
})

await check('a plain JSONL store loads without a manifest', async () => {
  const plain = registry.byId('plain-kb')
  assert.ok(plain, 'generic store not discovered')
  assert.equal(plain.profile, 'generic')
  assert.equal(plain.entries.length, 2)
  assert.ok(plain.inferred.has('name←title'), `inferred: ${[...plain.inferred].join(', ')}`)
  assert.ok(plain.inferred.has('body←text') || plain.inferred.has('body←content'))
})

await check('aliased fields reach the index and the citation', async () => {
  const result = await registry.search({ query: 'write protection', kb: 'plain-kb', limit: 1 })
  assert.ok(result.total > 0)
  const index = result.hits[0].index
  assert.equal(index.module, 'Core')
  assert.equal(index.section, '3.1')
  assert.equal(index.page, 12)
  const citation = citationOf('plain-kb', index)
  assert.ok(citation.includes('§3.1'), citation)
  assert.ok(citation.includes('p.12'), citation)
})

await check('sections.jsonl serves one module at a time', async () => {
  const store = registry.byId('plain-kb')
  const core = await store.sections('Core')
  assert.equal(core.found, true)
  assert.equal(core.total, 1)
  assert.match(core.items[0].text, /Alpha section text/)
  const diag = await store.sections('Diag')
  assert.match(diag.items[0].text, /Beta section text/)
})

await check('a generic store validates with SKIP, not FAIL', async () => {
  const report = await registry.byId('plain-kb').validate()
  assert.equal(report.ok, true)
  assert.equal(report.profile, 'generic')
  assert.ok(report.checks.some((item) => item.status === 'SKIP'))
  assert.ok(!report.checks.some((item) => item.status === 'FAIL'))
})

// ── edge cases: rebuilt stores, discovery, section layouts ─────────────────

const edge = join(home, 'edge')
mkdirSync(edge, { recursive: true })

function minimalManifest(kbId, files = { entries: 'entries.jsonl' }) {
  return { kb_id: kbId, name: { zh: kbId, en: kbId }, format: { name: 'portable-spec-kb' }, files, counts: {} }
}

function edgeStore(name, manifest, entries) {
  const dir = join(edge, name)
  mkdirSync(dir, { recursive: true })
  if (manifest !== null) {
    writeFileSync(join(dir, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  }
  if (entries !== null) writeFileSync(join(dir, 'entries.jsonl'), entries)
  return dir
}

await check('a rebuilt store is re-indexed before the next read', async () => {
  const record = (name, section) => JSON.stringify({ id: 'rebuilt:a', kind: 'requirement', module: 'M', name, section, page: Number(section) })
  const dir = edgeStore('rebuilt', minimalManifest('rebuilt'), `${record('AAA', '1')}\n`)
  const local = new SpecKbRegistry({ paths: [dir] })
  await local.ensure()
  assert.equal((await local.get('rebuilt:a')).record.name, 'AAA')
  writeFileSync(join(dir, 'entries.jsonl'), `${record('AAA-v2', '2')}\n`)
  const after = await local.get('rebuilt:a')
  assert.equal(after.found, true)
  assert.equal(after.record.name, 'AAA-v2')
  assert.ok(after.citation.includes('§2'), after.citation)
})

await check('a parent with its own JSONL still mounts the stores beside it', async () => {
  const parent = join(edge, 'parent-with-notes')
  mkdirSync(parent, { recursive: true })
  writeFileSync(join(parent, 'notes.jsonl'), JSON.stringify({ title: 'Meeting notes', text: 'scratch' }) + '\n')
  const child = join(parent, 'child-store')
  mkdirSync(child, { recursive: true })
  writeFileSync(join(child, 'manifest.json'), JSON.stringify(minimalManifest('child-store')))
  writeFileSync(join(child, 'entries.jsonl'), JSON.stringify({ id: 'child-store:1', kind: 'section', module: 'M', name: 'C', section: '1', page: 1 }) + '\n')
  const local = new SpecKbRegistry({ paths: [parent] })
  await local.ensure()
  assert.deepEqual(
    local.kbs.map((kb) => kb.kbId).sort((a, b) => a.localeCompare(b)),
    ['child-store', 'parent-with-notes'],
  )
})

await check('a single sections file is filtered by module whatever its name', async () => {
  const dir = edgeStore(
    'hybrid-sections',
    minimalManifest('hybrid-sections', { entries: 'entries.jsonl', sections: 'all-sections.jsonl' }),
    JSON.stringify({ id: 'hybrid-sections:a', kind: 'section', module: 'A', name: 'A record', section: '1', page: 1 }) + '\n',
  )
  writeFileSync(
    join(dir, 'all-sections.jsonl'),
    [
      JSON.stringify({ module: 'A', section: '1', title: 'A sec', text: 'A text' }),
      JSON.stringify({ module: 'B', section: '2', title: 'B sec', text: 'B text' }),
    ].join('\n') + '\n',
  )
  const store = new SpecKb(dir)
  await store.load()
  const result = await store.sections('A')
  assert.equal(result.total, 1)
  assert.equal(result.items[0].title, 'A sec')
})

await check('sections rows from a plain store use the same aliases', async () => {
  const dir = join(edge, 'aliased-sections')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'data.jsonl'), JSON.stringify({ id: 'aliased-sections:1', title: 'Rule', text: 'Rule body', category: 'Core' }) + '\n')
  writeFileSync(join(dir, 'sections.jsonl'), JSON.stringify({ category: 'Core', heading: 'Heading', pageNo: 7, content: 'Section body' }) + '\n')
  const store = new SpecKb(dir)
  await store.load()
  const result = await store.sections('Core')
  assert.equal(result.total, 1)
  assert.equal(result.items[0].title, 'Heading')
  assert.equal(result.items[0].page, 7)
  assert.match(result.items[0].text, /Section body/)
})

await check('a broken manifest is reported instead of dropped', async () => {
  const dir = edgeStore('broken-manifest', '{ not json', JSON.stringify({ id: 'broken-manifest:1', name: 'B' }) + '\n')
  assert.deepEqual(await discoverKbDirs([dir]), [dir])
  const local = new SpecKbRegistry({ paths: [dir] })
  await local.ensure()
  assert.equal(local.kbs.length, 1)
  assert.match(String(local.kbs[0].loadError), /not valid JSON/)
})

await check('a JSON array line is not a record', async () => {
  const dir = join(edge, 'array-line')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'data.jsonl'), `[1,2,3]\n${JSON.stringify({ id: 'array-line:1', title: 'real record' })}\n`)
  const store = new SpecKb(dir)
  await store.load()
  assert.equal(store.entries.length, 1)
  assert.equal(store.entries[0].id, 'array-line:1')
})

await check('concurrent section reads do not inflate the cache budget', async () => {
  const dir = edgeStore(
    'concurrent-sections',
    minimalManifest('concurrent-sections', { entries: 'entries.jsonl', sections: 'sections/' }),
    JSON.stringify({ id: 'concurrent-sections:1', kind: 'section', module: 'M', name: 'M', section: '1', page: 1 }) + '\n',
  )
  mkdirSync(join(dir, 'sections'), { recursive: true })
  writeFileSync(join(dir, 'sections', 'M.jsonl'), JSON.stringify({ section: '1', title: 't', text: 'x'.repeat(5000) }) + '\n')
  const store = new SpecKb(dir)
  await store.load()
  await Promise.all([store.sections('M'), store.sections('M'), store.sections('M')])
  const sizeOf = (list) => list.reduce((total, item) => total + item.text.length + item.title.length + 200, 0)
  assert.equal(store.sectionsBytes, sizeOf(store.sectionsCache.get('M')))
})

await check('get cites a plain store the way search does', async () => {
  const dir = join(edge, 'cited-plain')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'data.jsonl'),
    JSON.stringify({ uid: 'cited-plain:1', heading: 'Rule', definition: 'Body through the definition field.', category: 'Core', chapter: '9', pageNo: 7, doc: 'vendor.pdf' }) + '\n',
  )
  const local = new SpecKbRegistry({ paths: [dir] })
  await local.ensure()
  const found = await local.get('cited-plain:1')
  assert.ok(found.citation.includes('vendor'), found.citation)
  assert.ok(found.citation.includes('§9'), found.citation)
  assert.ok(found.citation.includes('p.7'), found.citation)
  assert.equal(bodyOf(found.record), 'Body through the definition field.')
})

await check('the sync store probe follows the loader', async () => {
  const foreign = join(edge, 'foreign-manifest')
  mkdirSync(foreign, { recursive: true })
  writeFileSync(join(foreign, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'extension' }))
  assert.equal(looksLikeStoreSync(foreign), false)
  assert.deepEqual(await discoverKbDirs([foreign]), [])
  const logs = join(edge, 'log-dir')
  mkdirSync(logs, { recursive: true })
  writeFileSync(join(logs, 'access.jsonl'), 'not json at all\n')
  assert.equal(looksLikeStoreSync(logs), false)
})

// ── HTTP routes (Settings page) ────────────────────────────────────────────

const routes = createSpecKbRoutes({ registry, defaults: [root] })
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const route = routes.find((item) => item.path === url.pathname)
  if (route === undefined) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not found"}')
    return
  }
  await route.handler(req, res)
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

await check('status reports the fixture stores', async () => {
  const { status, body } = await get('/api/spec-kb/status')
  assert.equal(status, 200)
  assert.deepEqual(body.paths, [resolve(root)])
  assert.deepEqual(
    body.stores.map((store) => store.kb_id).sort((a, b) => a.localeCompare(b)),
    ['autosar-spec-4.3.1', 'bom-fixture', 'neusar-ccore-v3', 'plain-kb'],
  )
})

await check('browse marks a store directory', async () => {
  const { body } = await get(`/api/spec-kb/browse?path=${encodeURIComponent(root)}`)
  assert.equal(body.ok, true)
  assert.ok(body.directories.every((entry) => entry.store === true))
})

await check('saving paths validates, then persists and reloads', async () => {
  const bad = await post('/api/spec-kb/paths', { paths: [join(root, 'missing')] })
  assert.equal(bad.status, 400)
  const good = await post('/api/spec-kb/paths', { paths: [root] })
  assert.equal(good.status, 200)
  assert.equal(good.body.source, 'settings')
  assert.equal(good.body.stores.length, 4)
})

await check('reset restores the bundle defaults', async () => {
  const { status, body } = await post('/api/spec-kb/reset', {})
  assert.equal(status, 200)
  assert.equal(body.source, 'bundle')
})

await check('a cross-origin or foreign-host request is refused', async () => {
  const crossOrigin = await fetch(`${base}/api/spec-kb/reset`, {
    method: 'POST',
    headers: { origin: 'http://evil.example', 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(crossOrigin.status, 403)
  const status = await new Promise((settle, reject) => {
    const probe = httpRequest(`${base}/api/spec-kb/status`, { headers: { host: 'evil.example:1234' } }, (response) => {
      response.resume()
      settle(response.statusCode)
    })
    probe.on('error', reject)
    probe.end()
  })
  assert.equal(status, 403)
})

server.close()
console.log(`\n${passed}/${passed + failed} checks passed`)
rmSync(home, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
