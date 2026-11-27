/**
 * dsh-spec-kb — reader for `portable-spec-kb` stores.
 *
 * A store is a directory with:
 *   manifest.json          format + counts + module list
 *   entries.jsonl          one record per line (id/kind/module/name/…/fields)
 *   sections/<module>.jsonl  full section text, one JSON object per line
 *   chunks.jsonl           optional RAG units
 *
 * Only Node built-ins are used, so the same module backs the DSH plugin and a
 * standalone self-test. Records are indexed lazily on first use: the index keeps
 * compact search fields and a byte range into the source text, and full records
 * are re-read on demand rather than held in memory.
 */

import { closeSync, createReadStream, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

export const FORMAT_NAME = 'portable-spec-kb'

/** Parsed section files kept in memory; a long session must not grow forever. */
const SECTION_CACHE_MODULES = 16
const SECTION_CACHE_BYTES = 16 * 1024 * 1024

/**
 * A single `sections.jsonl` is parsed once into a module map. Above this size the
 * map would cost more than the budget allows, so those files keep the streaming
 * path (one pass per module) instead.
 */
const SECTION_FILE_CACHE_BYTES = 16 * 1024 * 1024

/** Root files accepted as a record stream, in preference order. */
const ENTRY_FILES = ['entries.jsonl', 'data.jsonl', 'records.jsonl']

/** One section file used when the store has no `sections/` directory. */
const SECTIONS_FILE = 'sections.jsonl'

/** Profile of a store without `manifest.json`: plain JSONL records. */
const GENERIC_FORMAT = 'generic'

/**
 * Field aliases for stores written outside the portable-spec-kb contract.
 * The first key that has a value wins; every substitution is reported in
 * `inferred` so a caller can see what the reader had to guess.
 */
const FIELD_ALIASES = {
  id: ['id', 'uid', 'key', 'ref'],
  name: ['name', 'title', 'heading', 'label'],
  title: ['title', 'name', 'heading'],
  module: ['module', 'category', 'group', 'topic'],
  kind: ['kind', 'type', 'record_type'],
  section: ['section', 'chapter', 'number'],
  page: ['page', 'pageNo', 'page_number'],
  body: ['body', 'text', 'content', 'description', 'definition', 'syntax', 'lead'],
  upstream: ['upstream', 'references', 'dependsOn', 'depends_on'],
  document: ['document', 'doc', 'file'],
}

/** Chinese and short module aliases, mirroring the stores' own readers. */
const MODULE_ALIASES = {
  通信: 'Com',
  通信管理: 'ComM',
  诊断: 'Dcm',
  诊断通信: 'Dcm',
  诊断事件: 'Dem',
  故障: 'Dem',
  存储: 'NvM',
  非易失: 'NvM',
  掉电: 'NvM',
  闪存: 'Fee',
  内存: 'MemIf',
  内存映射: 'MemMap',
  路由: 'PduR',
  网络管理: 'Nm',
  can网络管理: 'CanNm',
  状态管理: 'CanSM',
  传输协议: 'CanTp',
  收发器: ['CanTrcv_TJA1145', 'CANTransceiverDriver'],
  模式管理: 'BswM',
  ecu管理: 'EcuM',
  看门狗: 'WdgIf',
  看门狗管理: 'WdgM',
  时基: ['StbM_解耦', 'SynchronizedTimeBaseManager'],
  时间同步: ['StbM_解耦', 'SynchronizedTimeBaseManager'],
  运行时: 'Rte',
  标定: 'Xcp',
}

/**
 * Short BSW module names → the module keys used by AUTOSAR specification
 * documents (`SWS_*` files are named after the document, e.g. NVRAMManager),
 * so `module: "NvM"` reaches the AUTOSAR store while still resolving exactly in
 * vendor stores that already use the short name.
 */
const SHORT_MODULE_ALIASES = {
  nvm: 'NVRAMManager',
  dcm: 'DiagnosticCommunicationManager',
  dem: 'DiagnosticEventManager',
  pdur: 'PDURouter',
  comm: 'COMManager',
  cannm: 'CANNetworkManagement',
  cansm: 'CANStateManager',
  cantp: 'CANTransportLayer',
  cantrcv: 'CANTransceiverDriver',
  ecum: 'ECUStateManager',
  bswm: 'BSWModeManager',
  wdgm: 'WatchdogManager',
  wdgif: 'WatchdogInterface',
  fee: 'FlashEEPROMEmulation',
  memif: 'MemoryAbstractionInterface',
  memmap: 'MemoryMapping',
  det: 'DefaultErrorTracer',
  e2e: 'E2ELibrary',
  os: 'OS',
  xcp: 'XCP',
  rte: 'RTE',
  nm: 'NetworkManagement',
}

/** Trim to `max` characters on a word-free boundary, marking truncation. */
export function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/** Lower-case search terms; CJK phrases stay whole, Latin words split on punctuation. */
export function tokenize(query) {
  return String(query ?? '')
    .toLowerCase()
    .split(/[\s,，、;；。:：()（）[\]【】/]+/)
    .map((term) => term.trim())
    .filter((term) => term !== '')
}

/**
 * Chinese terms that name a module, mapped to the module keys the stores use.
 * A Chinese question about an English specification must reach the right module,
 * otherwise every term scores zero and the agent concludes "not covered".
 *
 * A value may be an array when the official specs and a vendor manual name the
 * same module differently: the official AUTOSAR store files time synchronisation
 * under `SynchronizedTimeBaseManager`/`TimeSyncOver*` and transceivers under
 * `CANTransceiverDriver`, while NeuSAR files them under `StbM_解耦` and
 * `CanTrcv_TJA1145`. Mapping to one name only would leave the other store at
 * zero hits for the same question.
 */
const CJK_MODULE_TERMS = {
  诊断: 'Dcm',
  诊断通信: 'Dcm',
  诊断事件: 'Dem',
  故障: 'Dem',
  存储: 'NvM',
  非易失: 'NvM',
  掉电: 'NvM',
  闪存: 'Fee',
  内存: 'MemIf',
  内存映射: 'MemMap',
  路由: 'PduR',
  通信: 'Com',
  通信管理: 'ComM',
  网络管理: 'Nm',
  状态管理: 'CanSM',
  传输协议: 'CanTp',
  收发器: ['CanTrcv_TJA1145', 'TransceiverDriver'],
  模式管理: 'BswM',
  ecu管理: 'EcuM',
  看门狗: 'WdgIf',
  看门狗管理: 'WdgM',
  时基: ['StbM_解耦', 'SynchronizedTimeBaseManager'],
  时间同步: ['StbM_解耦', 'SynchronizedTimeBaseManager', 'TimeSync'],
  运行时: 'Rte',
  标定: 'Xcp',
  写保护: 'write protection',
  安全访问: 'security access',
  诊断服务: 'diagnostic service',
}

/** A table value is one key or several; expands to search terms. */
function aliasTerms(value) {
  const list = Array.isArray(value) ? value : [value]
  const terms = []
  for (const item of list) terms.push(...tokenize(item))
  return terms
}

/**
 * Expand a query with Chinese terms that name a module or a well-known concept.
 *
 * The expansion is additive: the original term still has to match, so this only
 * widens recall — it never turns a non-match into a false positive on its own.
 */
export function expandQuery(query) {
  const terms = tokenize(query)
  const extra = []
  for (const term of terms) {
    const moduleKey = CJK_MODULE_TERMS[term]
    if (moduleKey !== undefined) {
      extra.push(...aliasTerms(moduleKey))
      continue
    }
    // A longer Chinese phrase may contain a known term as a prefix.
    for (const [zh, en] of Object.entries(CJK_MODULE_TERMS)) {
      if (term.includes(zh) && term !== zh) {
        extra.push(...aliasTerms(en))
      }
    }
  }
  const merged = [...terms]
  for (const term of extra) {
    if (!merged.includes(term)) merged.push(term)
  }
  return merged
}

function kindMatches(entryKind, wanted) {
  if (!wanted) return true
  if (wanted === 'compliance') return String(entryKind).startsWith('compliance_')
  return entryKind === wanted
}

/** Normalize a user-supplied kind, accepting `deviation` for `compliance_deviation`. */
export function normalizeKind(kind) {
  if (kind === undefined || kind === null || kind === '') return undefined
  const value = String(kind).trim().toLowerCase()
  if (value === '' || value === 'any' || value === 'all') return undefined
  if (value.startsWith('compliance_')) return value
  if (value === 'compliance' || value === 'deviation' || value === 'unsupported' || value === 'limit') {
    return value === 'compliance' ? 'compliance' : `compliance_${value}`
  }
  return value
}

/** The explanatory text a portable-spec-kb record keeps under `fields`. */
function canonicalBodyOf(record) {
  const fields = record?.fields && typeof record.fields === 'object' ? record.fields : {}
  return (
    fields.body ??
    fields.definition ??
    fields.description ??
    fields.syntax ??
    fields.lead ??
    record?.summary ??
    ''
  )
}

/** First alias that carries a non-empty value. */
function pick(record, aliases) {
  for (const key of aliases) {
    const value = record[key]
    if (value !== undefined && value !== null && value !== '') return { key, value }
  }
  return { key: undefined, value: undefined }
}

/** A printed page number, accepting a digit string; anything else is null. */
function pageOf(value) {
  if (Number.isInteger(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  return null
}

/**
 * The record's explanatory text.
 *
 * A portable-spec-kb store keeps it under `fields`; a plain JSONL store may use
 * `body`, `text`, `content`, … at the top level. Both shapes resolve here, so the
 * index, `get` and `brief` read the same text.
 */
export function bodyOf(record) {
  const canonical = canonicalBodyOf(record)
  if (canonical !== '') return canonical
  const alias = pick(record ?? {}, FIELD_ALIASES.body)
  return alias.value === undefined ? '' : String(alias.value)
}

/** Whether a path exists and is a regular file (a directory is never an entry file). */
async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** Whether one parsed line looks like a knowledge-base record at all. */
function isRecordLike(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return false
  for (const key of ['name', 'title', 'heading', 'label', 'body', 'text', 'content', 'description', 'definition', 'syntax', 'lead', 'summary']) {
    if (typeof record[key] === 'string' && record[key].trim() !== '') return true
  }
  const fields = record.fields
  return typeof fields?.body === 'string' && fields.body.trim() !== ''
}

/**
 * Flatten one raw record into the index shape, tolerating foreign field names.
 *
 * Canonical portable-spec-kb records pass through untouched; a plain JSONL
 * store's `text`/`title`/`pageNo`/`category` still lands on the right index
 * field, and every substitution is recorded in `inferred` so it stays visible.
 */
function normalizeRecord(record, kbId, position, inferred) {
  const note = (canonical, key) => {
    if (key !== undefined && key !== canonical) inferred.add(`${canonical}←${key}`)
  }

  const id = pick(record, FIELD_ALIASES.id)
  const name = pick(record, FIELD_ALIASES.name)
  const title = pick(record, FIELD_ALIASES.title)
  const module = pick(record, FIELD_ALIASES.module)
  const kind = pick(record, FIELD_ALIASES.kind)
  const section = pick(record, FIELD_ALIASES.section)
  const page = pick(record, FIELD_ALIASES.page)
  const upstream = pick(record, FIELD_ALIASES.upstream)
  const document =
    record?.source?.document !== undefined && record.source.document !== null && record.source.document !== ''
      ? { key: 'source.document', value: record.source.document }
      : pick(record, FIELD_ALIASES.document)

  note('id', id.key)
  note('name', name.key)
  note('title', title.key)
  note('module', module.key)
  note('kind', kind.key)
  note('section', section.key)
  note('page', page.key)
  note('upstream', upstream.key)
  if (document.key !== undefined && document.key !== 'source.document' && document.key !== 'document') {
    note('document', document.key)
  }

  const canonicalBody = canonicalBodyOf(record)
  const aliasBody = pick(record, FIELD_ALIASES.body)
  const body = canonicalBody !== '' ? canonicalBody : aliasBody.value === undefined ? '' : String(aliasBody.value)
  if (canonicalBody === '') note('body', aliasBody.key)

  const numericPage = pageOf(page.value)
  if (!Number.isInteger(page.value) && numericPage !== null) inferred.add('page←string')

  let nameText = String(name.value ?? '')
  if (nameText === '' && body !== '') {
    nameText = clip(body, 80)
    inferred.add('name←body')
  }
  let idText = String(id.value ?? '')
  if (idText === '') {
    idText = `${kbId}:${position}`
    inferred.add('id←generated')
  }

  const upstreamList = Array.isArray(upstream.value)
    ? upstream.value.map(String)
    : typeof upstream.value === 'string' && upstream.value.trim() !== ''
      ? upstream.value.split(/[,;\s]+/).filter((item) => item !== '')
      : null

  return {
    id: idText,
    kind: String(kind.value ?? ''),
    module: String(module.value ?? ''),
    name: nameText,
    title: String(title.value ?? ''),
    section: section.value === undefined ? '' : String(section.value),
    page: numericPage,
    document: document.value === undefined ? '' : String(document.value),
    summary: clip(body, 500),
    upstream: upstreamList,
  }
}

/**
 * Extract a citation from a record: store, source document, section, page.
 *
 * The same helper serves search hits and full records so both cite identically;
 * a hit carries the document name in its index entry, which is why the index
 * keeps `document` next to `section` and `page`.
 */
export function citationOf(kbId, record) {
  const document = record?.source?.document ? String(record.source.document) : record?.document ? String(record.document) : ''
  const parts = [kbId]
  if (document) parts.push(document.replace(/\.pdf$/i, ''))
  if (record?.section !== undefined && record?.section !== null && String(record.section) !== '') {
    parts.push(`§${record.section}`)
  }
  if (Number.isInteger(record?.page)) parts.push(`p.${record.page}`)
  const name = record?.kind === 'requirement' ? record?.name : ''
  const text = parts.join(' · ')
  return name ? `${text} · ${name}` : text
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Whether the first lines of a file parse into record-like objects. */
async function hasRecordLikeLine(path) {
  const stream = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let seen = 0
  try {
    for await (const line of lines) {
      if (line.trim() === '') continue
      seen += 1
      try {
        if (isRecordLike(JSON.parse(line.replace(/^\uFEFF/, '')))) return true
      } catch {
        /* keep looking */
      }
      if (seen >= 20) break
    }
  } catch {
    return false
  }
  return false
}

/** Spec-kb keys that mark a manifest as a knowledge-base manifest, not a random one. */
const MANIFEST_KEYS = ['kb_id', 'format', 'files', 'counts', 'modules']

/** Root JSONL files that may hold records, in preference order. */
function entryCandidates(names) {
  return [
    ...ENTRY_FILES.filter((name) => names.includes(name)),
    ...names
      .filter(
        (name) =>
          name.endsWith('.jsonl') &&
          !name.startsWith('.') &&
          name !== SECTIONS_FILE &&
          !name.startsWith('chunks') &&
          !ENTRY_FILES.includes(name),
      )
      .sort((a, b) => a.localeCompare(b)),
  ]
}

/**
 * Decide how one directory stores records.
 *
 * Returns the layout, `{ error }` for a store that is recognisably spec-kb but
 * unusable, or `null` when the directory is not a store at all. A broken store
 * must be distinguishable from "no store here": silently dropping it hides the
 * only diagnostic the Settings page and `spec_kb_info` can show.
 */
async function detectLayout(dir) {
  const manifestPath = join(dir, 'manifest.json')
  if (await exists(manifestPath)) {
    let manifest = null
    let parseError = null
    try {
      const parsed = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''))
      // JSON.parse also yields null, arrays and primitives; only a plain object is
      // a manifest, and `instanceof` avoids a typeof-on-null dereference.
      manifest = parsed instanceof Object && !Array.isArray(parsed) ? parsed : null
    } catch (error) {
      parseError = error
    }
    const rel = manifest === null ? 'entries.jsonl' : manifest.files?.entries ?? 'entries.jsonl'
    const entriesPath = join(dir, String(rel))
    // A manifest that points at a directory is as broken as a missing file.
    if (await isFile(entriesPath)) {
      if (parseError !== null) {
        return { error: `manifest.json is not valid JSON: ${String(parseError.message ?? parseError)}` }
      }
      if (manifest === null) return { error: 'manifest.json must be a JSON object' }
      return { profile: FORMAT_NAME, entriesRel: String(rel), manifest }
    }
    // An unparsable manifest next to no entries file is more likely some other
    // tool's manifest (a browser extension, a build artifact) than a store.
    if (parseError !== null) return null
    const declaresStore = manifest !== null && MANIFEST_KEYS.some((key) => key in manifest)
    if (declaresStore) {
      return { error: `manifest.json declares entries "${String(rel)}", but that file is missing` }
    }
    return null
  }
  let names
  try {
    names = await readdir(dir)
  } catch {
    return null
  }
  for (const candidate of entryCandidates(names)) {
    if (await hasRecordLikeLine(join(dir, candidate))) {
      return { profile: GENERIC_FORMAT, entriesRel: candidate, manifest: null }
    }
  }
  return null
}

/** Same decision the loader makes, so discovery never lists an unusable path. */
async function isKbDir(dir) {
  return (await detectLayout(dir)) !== null
}

/**
 * Sync probe for display: the prompt's store list and the Settings page must name
 * exactly the directories the loader will pick up. Reading the first record line
 * is what keeps a directory full of logs or exports from being advertised.
 */
export function looksLikeStoreSync(dir) {
  try {
    const manifestPath = join(dir, 'manifest.json')
    if (existsSync(manifestPath)) return manifestLooksLikeStoreSync(dir)
    for (const candidate of entryCandidates(readdirSync(dir))) {
      if (hasRecordLikeLineSync(join(dir, candidate))) return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * The manifest branch of `detectLayout`, mirrored synchronously.
 *
 * A directory holding some other tool's manifest (a browser extension, a build
 * artifact) must not be advertised as a store, so the manifest's own keys decide.
 */
function manifestLooksLikeStoreSync(dir) {
  let manifest = null
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''))
    manifest = parsed instanceof Object && !Array.isArray(parsed) ? parsed : null
  } catch {
    // Unparsable manifest: only a store when an entries file sits next to it.
    return hasEntryFileSync(dir, 'entries.jsonl')
  }
  const rel = manifest === null ? 'entries.jsonl' : manifest.files?.entries ?? 'entries.jsonl'
  if (hasEntryFileSync(dir, String(rel))) return true
  return manifest !== null && MANIFEST_KEYS.some((key) => key in manifest)
}

function hasEntryFileSync(dir, rel) {
  try {
    return statSync(join(dir, rel)).isFile()
  } catch {
    return false
  }
}

/** First record-like line of a file, read synchronously; partial lines are rejected. */
function hasRecordLikeLineSync(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(16384)
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    const text = buffer.toString('utf8', 0, read)
    for (const line of text.split('\n')) {
      const trimmed = line.replace(/^\uFEFF/, '').trim()
      if (trimmed === '') continue
      // The final fragment may be cut by the buffer; a parse failure is then
      // inconclusive, so report "no" rather than latching onto a broken line.
      try {
        return isRecordLike(JSON.parse(trimmed))
      } catch {
        return false
      }
    }
    return false
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export { isKbDir }

async function subdirectories(dir) {
  try {
    const items = await readdir(dir, { withFileTypes: true })
    return items.filter((item) => item.isDirectory()).map((item) => join(dir, item.name))
  } catch {
    return []
  }
}

/** Normalize a configured path list: trim, resolve, de-duplicate. */
export function normalizePathList(input) {
  const list = Array.isArray(input) ? input : input === undefined || input === null || input === '' ? [] : [input]
  const out = []
  for (const item of list) {
    const value = String(item ?? '').trim()
    if (value === '') continue
    const absolute = resolve(value)
    if (!out.includes(absolute)) out.push(absolute)
  }
  return out
}

/**
 * Expand configured paths into store directories.
 *
 * A path may be a store, a parent whose direct children are stores, or both: a
 * parent that happens to hold one stray JSONL export must not shadow the real
 * stores next to it. Store-internal directories (`sections/`, `chunks/`) are
 * never descended into — they hold parts of a store, not stores.
 */
export async function discoverKbDirs(paths) {
  const found = []
  for (const raw of paths ?? []) {
    if (!raw) continue
    const dir = resolve(String(raw))
    if (await isKbDir(dir)) found.push(dir)
    for (const child of await subdirectories(dir)) {
      const name = basename(child).toLowerCase()
      if (name === 'sections' || name === 'chunks') continue
      if (await isKbDir(child)) found.push(child)
    }
  }
  return [...new Set(found)]
}

/** Count JSONL lines without loading the file into memory. */
async function countJsonlLines(path) {
  if (!(await exists(path))) return null
  let count = 0
  const stream = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of lines) if (line.trim() !== '') count += 1
  return count
}

/**
 * One loaded `portable-spec-kb` store.
 *
 * `load()` builds a compact index; `record(entry)` re-reads one full record from
 * the retained source text by its character range.
 */
export class SpecKb {
  constructor(dir) {
    this.dir = resolve(dir)
    this.loaded = false
    this.loadError = null
    this.manifest = null
    this.entriesRel = 'entries.jsonl'
    this.text = ''
    this.entries = []
    this.badLines = 0
    this.byId = new Map()
    this.byName = new Map()
    this.byModule = new Map()
    this.reverseUpstream = new Map()
    this.modules = []
    this.kinds = {}
    this.kbId = ''
    this.profile = ''
    this.inferred = new Set()
    this.entriesPath = ''
    // Identity of the entries file at load time: a rebuild while the process runs
    // makes every stored byte offset suspect, so it is checked before each read.
    this.entriesStat = null
    this.loadedAt = null
    this.nextRetryAt = 0
    this.sectionsCache = new Map()
    this.sectionsBytes = 0
    this.sectionsMtime = new Map()
    this.sectionsFile = null
    this.sectionsPending = new Map()
  }

  get title() {
    const name = this.manifest?.name
    if (name && typeof name === 'object') return name.zh || name.en || this.kbId
    if (typeof name === 'string') return name
    return this.kbId || this.dir
  }

  async load() {
    if (this.loaded) return this
    const layout = await detectLayout(this.dir)
    if (layout === null) throw new Error(`not a knowledge base: no manifest.json or record JSONL in ${this.dir}`)
    if (layout.error !== undefined) throw new Error(layout.error)
    this.profile = layout.profile
    this.inferred = new Set()
    const fallbackName = basename(this.dir)
    this.manifest = layout.manifest ?? {
      kb_id: fallbackName,
      name: { zh: fallbackName, en: fallbackName },
      counts: {},
      format: { name: GENERIC_FORMAT },
      modules: [],
    }
    this.kbId = String(this.manifest.kb_id ?? fallbackName)
    this.entriesRel = layout.entriesRel
    const entriesPath = join(this.dir, this.entriesRel)
    // Stat before reading: if the file is rewritten during the read, the recorded
    // identity no longer matches and the next read reports the store as stale.
    this.entriesStat = await stat(entriesPath)
    const raw = await readFile(entriesPath, 'utf8')
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
    // The source text is not retained: the index keeps a byte range per record
    // and `record()` re-reads just that line. 116k records hold ~180 MB of JSONL,
    // which would otherwise stay resident for the whole session.
    this.entriesPath = entriesPath
    this.text = ''
    const bomBytes = text.length === raw.length ? 0 : 3
    let byteCursor = bomBytes

    let start = 0
    while (start < text.length) {
      let end = text.indexOf('\n', start)
      if (end === -1) end = text.length
      const line = text.slice(start, end)
      const lineBytes = Buffer.byteLength(line, 'utf8')
      if (line.trim() !== '') {
        let record
        try {
          record = JSON.parse(line)
        } catch {
          this.badLines += 1
        }
        if (record && typeof record === 'object' && !Array.isArray(record)) {
          this.#index(normalizeRecord(record, this.kbId, this.entries.length, this.inferred), byteCursor, lineBytes)
        }
      }
      byteCursor += lineBytes + (end < text.length ? 1 : 0)
      start = end + 1
    }

    for (const [module, list] of [...this.byModule.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      this.modules.push({ module, entries: list.length })
    }
    this.loaded = true
    this.loadedAt = Date.now()
    return this
  }

  /**
   * Reload this store from disk after its entries file changed.
   *
   * Every byte range in the index belongs to the file as it was at load time, so
   * a rebuild requires a full re-index rather than a re-read.
   */
  async reload() {
    this.loaded = false
    this.loadError = null
    this.manifest = null
    this.entriesRel = 'entries.jsonl'
    this.text = ''
    this.entries = []
    this.badLines = 0
    this.byId = new Map()
    this.byName = new Map()
    this.byModule = new Map()
    this.reverseUpstream = new Map()
    this.modules = []
    this.kinds = {}
    this.kbId = ''
    this.profile = ''
    this.inferred = new Set()
    this.entriesStat = null
    this.loadedAt = null
    this.sectionsCache.clear()
    this.sectionsBytes = 0
    this.sectionsMtime.clear()
    this.sectionsFile = null
    this.sectionsPending.clear()
    return this.load()
  }

  /** Whether `entries.jsonl` changed since it was indexed. */
  staleOnDisk() {
    if (this.entriesStat === null) return false
    try {
      const current = statSync(this.entriesPath)
      return current.mtimeMs !== this.entriesStat.mtimeMs || current.size !== this.entriesStat.size
    } catch {
      return true
    }
  }

  /** Add one normalized record to the index at its byte range. */
  #index(fields, offset, size) {
    const module = fields.module
    const entry = {
      id: fields.id,
      kind: fields.kind,
      module,
      name: fields.name,
      nameLower: fields.name.toLowerCase(),
      moduleLower: module.toLowerCase(),
      section: fields.section,
      title: fields.title,
      page: fields.page,
      document: fields.document,
      summary: fields.summary,
      hay: `${fields.name} ${fields.title} ${module} ${fields.section} ${fields.summary}`.toLowerCase(),
      offset,
      size,
      upstream: fields.upstream,
    }
    this.entries.push(entry)
    this.push(this.byId, entry.id, entry)
    if (entry.nameLower) this.push(this.byName, entry.nameLower, entry)
    this.push(this.byModule, module, entry)
    this.kinds[entry.kind] = (this.kinds[entry.kind] ?? 0) + 1
    if (entry.upstream) {
      for (const upstreamId of entry.upstream) {
        const key = upstreamId.toLowerCase()
        if (!this.reverseUpstream.has(key)) this.reverseUpstream.set(key, new Set())
        this.reverseUpstream.get(key).add(entry.name || entry.id)
      }
    }
  }

  push(map, key, value) {
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(value)
  }

  /**
   * Full record for one index entry, read from its byte range in the store.
   *
   * `offset`/`size` are UTF-8 byte offsets, not string indices, so a record can
   * be read without loading `entries.jsonl` again. The cost is one small pread
   * per lookup, which only `get`/`trace`/`brief` pay.
   */
  record(entry) {
    if (!entry) return null
    // The index's byte ranges describe the file as it was indexed. A rebuilt
    // store would make a re-read land in the middle of a different record, so
    // fail closed instead of returning another entry's body.
    if (this.staleOnDisk()) return null
    let fd
    try {
      fd = openSync(this.entriesPath, 'r')
      const buffer = Buffer.alloc(entry.size)
      // pread may return fewer bytes than asked for; a short read would parse a
      // truncated record, so fill the buffer before decoding.
      let filled = 0
      while (filled < entry.size) {
        const read = readSync(fd, buffer, filled, entry.size - filled, entry.offset + filled)
        if (read <= 0) break
        filled += read
      }
      if (filled !== entry.size) return null
      const parsed = JSON.parse(buffer.toString('utf8'))
      // Defence in depth: a record whose id contradicts the index is not the one
      // this entry points at, even when the file's size still matches.
      if (entry.id && parsed?.id !== undefined && String(parsed.id) !== entry.id) return null
      return parsed
    } catch {
      return null
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }

  /**
   * Resolve a module name to one module key.
   *
   * The order matters: an exact key wins, then the Chinese alias table, then the
   * short BSW names, and only then a prefix match. The prefix step is a last
   * resort because several modules share a prefix ("COM" vs "COMManager"), so
   * an ambiguous prefix resolves to the shortest candidate, which is the
   * generic document rather than a specific one.
   */
  resolveModule(value) {
    const wanted = String(value ?? '').trim()
    if (!wanted) return undefined
    const lower = wanted.toLowerCase()
    const known = [...this.byModule.keys()]
    const exact = known.find((name) => name.toLowerCase() === lower)
    if (exact) return exact
    const alias = MODULE_ALIASES[lower] ?? MODULE_ALIASES[wanted]
    for (const candidate of alias === undefined ? [] : Array.isArray(alias) ? alias : [alias]) {
      if (this.byModule.has(candidate)) return candidate
    }
    const short = SHORT_MODULE_ALIASES[lower]
    if (short && this.byModule.has(short)) return short
    const prefixed = known.filter((name) => name.toLowerCase().startsWith(lower))
    if (prefixed.length === 0) return undefined
    if (prefixed.length === 1) return prefixed[0]
    // Prefer the shortest name: "COM" over "COMBasedTransformer"/"COMManager".
    return prefixed.slice().sort((a, b) => a.length - b.length || a.localeCompare(b))[0]
  }

  /**
   * Ranked search over the compact index.
   *
   * An empty query is refused: without terms every record would match with the
   * same score, which is noise rather than a result.
   *
   * @param {{ query?: string, module?: string, kind?: string, name?: string, limit?: number }} options
   */
  search(options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 8, 1), 50)
    const wantedKind = normalizeKind(options.kind)
    const module = this.resolveModule(options.module)
    const exactName = options.name ? String(options.name).trim().toLowerCase() : ''
    const terms = expandQuery(options.query)
    if (terms.length === 0 && exactName === '') {
      return { total: 0, module, kind: wantedKind, hits: [], empty: true }
    }
    const pool = module ? (this.byModule.get(module) ?? []) : this.entries
    const scored = []

    for (const entry of pool) {
      if (!kindMatches(entry.kind, wantedKind)) continue
      if (exactName) {
        if (entry.nameLower === exactName) scored.push({ entry, score: 1000 })
        continue
      }
      const score = this.#score(entry, terms)
      if (score > 0) scored.push({ entry, score })
    }

    scored.sort((a, b) => b.score - a.score || a.entry.nameLower.localeCompare(b.entry.nameLower))
    const seen = new Set()
    const hits = []
    for (const item of scored) {
      const key = `${item.entry.id}|${item.entry.page}`
      if (seen.has(key)) continue
      seen.add(key)
      hits.push({ index: item.entry, score: item.score })
      if (hits.length >= limit) break
    }
    return { total: scored.length, module, kind: wantedKind, hits }
  }

  /**
   * Score one record against the query terms.
   *
   * Terms are weighted by where they match, and the record must match at least
   * one term. Requiring every term would make an expanded Chinese query
   * ("诊断安全访问" → "诊断", "dcm", "security", "access") score zero in an
   * English specification, because the Chinese term itself matches nothing.
   * A record that matches only the expansion still ranks, and one that matches
   * the original terms ranks higher.
   */
  #score(entry, terms) {
    let score = 0
    let matched = 0
    for (const term of terms) {
      let best = 0
      if (entry.nameLower === term) best = 40
      else if (entry.nameLower.startsWith(term)) best = 28
      else if (entry.nameLower.includes(term)) best = 16
      if (entry.moduleLower === term) best = Math.max(best, 12)
      else if (entry.moduleLower.includes(term)) best = Math.max(best, 6)
      if (entry.hay.includes(term)) best = Math.max(best, 2)
      if (best === 0) continue
      matched += 1
      score += best
    }
    if (matched === 0) return 0
    // Reward records that match more of the query, without letting one weak
    // match outweigh a strong one.
    return score * (1 + (matched - 1) * 0.25)
  }

  /** Records matching an exact name or id, optionally filtered by module. */
  match(ref, module) {
    const wanted = String(ref ?? '').trim()
    if (wanted === '') return []
    const moduleName = this.resolveModule(module)
    const list = this.byId.get(wanted) ?? this.byName.get(wanted.toLowerCase()) ?? []
    return moduleName ? list.filter((entry) => entry.module === moduleName) : list
  }

  /**
   * Trace a requirement through the store in both directions.
   *
   * Upstream ids may live outside the requirement records: AUTOSAR stores as
   * distilled here keep SRS requirements inside section text (`[SRS_Mem_00041] …`),
   * so an unresolved id falls back to the record that mentions it.
   */
  async trace(ref) {
    const list = this.match(ref)
    const requirements = list.filter((entry) => entry.kind === 'requirement')
    if (requirements.length === 0) return { found: false, candidates: list.slice(0, 5).map((e) => `${e.module}/${e.name}`) }
    const requirement = requirements[0]
    const resolveRef = (id) => {
      const matches = this.byId.get(id) ?? this.byName.get(id.toLowerCase()) ?? []
      const first = matches[0] ?? this.#findByMention(id)
      const record = first ? this.record(first) : null
      return {
        id,
        found: Boolean(first),
        via: first ? (matches[0] ? 'record' : 'mention') : undefined,
        module: first?.module ?? '',
        title: first?.title ?? first?.name ?? '',
        section: first?.section ?? '',
        page: first?.page ?? null,
        citation: first ? citationOf(this.kbId, record ?? { section: first.section, page: first.page, name: id }) : undefined,
      }
    }
    const upstream = (requirement.upstream ?? []).map((id) => resolveRef(id))
    const downstreamKeys = [requirement.name.toLowerCase(), requirement.id.toLowerCase()]
    const downstreamNames = new Set()
    for (const key of downstreamKeys) {
      for (const name of this.reverseUpstream.get(key) ?? []) downstreamNames.add(name)
    }
    const downstream = [...downstreamNames].slice(0, 50).map((name) => {
      const matches = this.byName.get(name.toLowerCase()) ?? []
      const first = matches.find((entry) => entry.kind === 'requirement') ?? matches[0] ?? this.#findByMention(name)
      return {
        id: name,
        found: Boolean(first),
        module: first?.module ?? '',
        title: first?.title ?? first?.name ?? '',
        section: first?.section ?? '',
        page: first?.page ?? null,
      }
    })
    return { found: true, requirement, upstream, downstream, duplicateCount: requirements.length - 1 }
  }

  /** First record whose name mentions `id` (section names embed requirement ids). */
  #findByMention(id) {
    const needle = String(id ?? '').toLowerCase()
    if (needle === '') return undefined
    let fallback
    for (const entry of this.entries) {
      if (entry.kind !== 'section' && entry.kind !== 'requirement') continue
      if (!entry.nameLower.includes(needle)) continue
      const bracketed = entry.nameLower.startsWith(`[${needle}]`) || entry.nameLower.startsWith(needle)
      if (bracketed) return entry
      if (fallback === undefined) fallback = entry
    }
    return fallback
  }

  /** Section text for one module, loaded from `sections/<module>.jsonl` on demand. */
  async sections(moduleValue, options = {}) {
    const module = this.resolveModule(moduleValue)
    if (!module) return { found: false, available: this.modules.map((item) => item.module) }
    const items = await this.#loadSections(module)
    const sectionWanted = options.section !== undefined && options.section !== null ? String(options.section).trim() : ''
    const titleWanted = options.title ? String(options.title).trim().toLowerCase() : ''
    const limit = Math.min(Math.max(Number(options.limit) || 10, 1), 50)
    const filtered = items.filter((item) => {
      if (sectionWanted !== '' && String(item.section ?? '') !== sectionWanted) return false
      if (titleWanted !== '' && !String(item.title ?? '').toLowerCase().includes(titleWanted)) return false
      return true
    })
    return {
      found: true,
      module,
      total: filtered.length,
      truncated: filtered.length > limit,
      items: filtered.slice(0, limit),
    }
  }

  /**
   * Section text for one module.
   *
   * The layout is resolved rather than guessed: a `sections/` directory holds one
   * file per module, a single JSONL file (whatever its manifest name) holds rows
   * for every module and is filtered by module. A manifest that points at a
   * missing path falls back to the conventional locations instead of silently
   * returning nothing.
   */
  async #loadSections(module) {
    const key = `module:${module}`
    const pending = this.sectionsPending.get(key)
    if (pending !== undefined) return pending
    const task = this.#loadSectionsFor(module).finally(() => this.sectionsPending.delete(key))
    this.sectionsPending.set(key, task)
    return task
  }

  async #loadSectionsFor(module) {
    const layout = await this.#sectionsLayout()
    if (layout === null) {
      this.#cacheSections(module, [])
      return []
    }
    if (layout.kind === 'dir') {
      const path = join(layout.dir, `${module}.jsonl`)
      let mtimeMs = null
      try {
        mtimeMs = (await stat(path)).mtimeMs
      } catch {
        mtimeMs = null
      }
      const cached = this.sectionsCache.get(module)
      if (cached !== undefined && this.sectionsMtime.get(module) === mtimeMs) {
        this.sectionsCache.delete(module) // refresh recency order
        this.sectionsCache.set(module, cached)
        return cached
      }
      const items = mtimeMs === null ? [] : await this.#readSectionsFile(path, null)
      this.sectionsMtime.set(module, mtimeMs)
      this.#cacheSections(module, items)
      return items
    }
    const byModule = await this.#sectionsMap(layout)
    if (byModule !== null) return this.#sectionsForModule(byModule, module)
    const items = await this.#readSectionsFile(layout.path, module)
    this.#cacheSections(module, items)
    return items
  }

  /** Where section text lives: one file per module, one file for all, or nothing. */
  async #sectionsLayout() {
    const declared = this.manifest?.files?.sections
    const candidates = []
    if (typeof declared === 'string' && declared !== '') candidates.push(join(this.dir, declared))
    candidates.push(join(this.dir, 'sections'), join(this.dir, SECTIONS_FILE))
    for (const path of candidates) {
      try {
        const info = await stat(path)
        if (info.isDirectory()) return { kind: 'dir', dir: path }
        if (info.isFile()) return { kind: 'file', path, size: info.size, mtimeMs: info.mtimeMs }
      } catch {
        /* try the next conventional location */
      }
    }
    return null
  }

  /**
   * Parse a single sections file once, grouped by module.
   *
   * Without this the first query for each of N modules re-reads the whole file;
   * a 100-module store would parse it 100 times. The map is replaced when the file
   * changes, and files above the cache budget keep the streaming path.
   */
  async #sectionsMap(layout) {
    if (layout.size > SECTION_FILE_CACHE_BYTES) return null
    const cached = this.sectionsFile
    if (cached !== null && cached.path === layout.path && cached.mtimeMs === layout.mtimeMs) return cached.byModule
    const key = `file:${layout.path}`
    const pending = this.sectionsPending.get(key)
    if (pending !== undefined) return pending
    const task = this.#buildSectionsMap(layout).finally(() => this.sectionsPending.delete(key))
    this.sectionsPending.set(key, task)
    return task
  }

  async #buildSectionsMap(layout) {
    const byModule = new Map()
    const stream = createReadStream(layout.path, { encoding: 'utf8' })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        if (line.trim() === '') continue
        const row = this.#parseSectionLine(line)
        if (row === null) continue
        const module = this.#rowModule(row)
        if (module === '') continue
        const list = byModule.get(module) ?? []
        list.push(this.#projectSection(row))
        byModule.set(module, list)
      }
    } catch {
      return null
    }
    this.sectionsFile = { path: layout.path, mtimeMs: layout.mtimeMs, byModule }
    return byModule
  }

  /** One module's rows out of a whole-file map, accepting a differently-cased key. */
  #sectionsForModule(byModule, module) {
    const direct = byModule.get(module)
    if (direct !== undefined) return direct
    const lower = module.toLowerCase()
    for (const [key, items] of byModule) {
      if (key.toLowerCase() === lower || this.resolveModule(key) === module) return items
    }
    return []
  }

  async #readSectionsFile(path, module) {
    const items = []
    const stream = createReadStream(path, { encoding: 'utf8' })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        if (line.trim() === '') continue
        const row = this.#parseSectionLine(line)
        if (row === null) continue
        if (module !== null && !this.#sectionBelongsTo(row, module)) continue
        items.push(this.#projectSection(row))
      }
    } catch {
      /* a missing section file means the module has no section text */
    }
    return items
  }

  #parseSectionLine(line) {
    try {
      const parsed = JSON.parse(line.replace(/^\uFEFF/, ''))
      return parsed instanceof Object && !Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  /** Canonical module a section row belongs to; '' when the row names none. */
  #rowModule(row) {
    const value = pick(row, FIELD_ALIASES.module).value
    const text = String(value ?? '').trim()
    if (text === '') return ''
    return this.resolveModule(text) ?? text
  }

  #sectionBelongsTo(row, module) {
    const key = this.#rowModule(row)
    if (key === '') return false
    if (key === module || key.toLowerCase() === module.toLowerCase()) return true
    return this.resolveModule(key) === module
  }

  /** Project one section row, tolerating a plain store's field names. */
  #projectSection(row) {
    const section = pick(row, FIELD_ALIASES.section).value
    const title = pick(row, ['title', 'name', 'heading', 'label']).value
    const document = row?.source?.document ?? row?.document_id ?? row?.document ?? row?.doc ?? row?.file ?? ''
    return {
      section: section === undefined || section === null ? '' : String(section),
      title: title === undefined || title === null ? '' : String(title),
      page: pageOf(pick(row, FIELD_ALIASES.page).value),
      document: document === undefined || document === null ? '' : String(document),
      text: String(bodyOf(row) ?? ''),
    }
  }

  /**
   * Insert one module's section items with a size and count bound.
   *
   * Section text is the largest per-module payload; without a bound, every
   * module a session ever touches stays parsed for its lifetime. Replacing an
   * entry subtracts its old size first, so concurrent or repeated loads cannot
   * inflate the budget.
   */
  #cacheSections(module, items) {
    const sizeOf = (list) => list.reduce((total, item) => total + item.text.length + item.title.length + 200, 0)
    const previous = this.sectionsCache.get(module)
    if (previous !== undefined) this.sectionsBytes -= sizeOf(previous)
    this.sectionsCache.delete(module)
    this.sectionsCache.set(module, items)
    this.sectionsBytes += sizeOf(items)
    while (this.sectionsCache.size > SECTION_CACHE_MODULES || this.sectionsBytes > SECTION_CACHE_BYTES) {
      const oldest = this.sectionsCache.keys().next().value
      if (oldest === module) break // never evict the entry just inserted
      this.sectionsBytes -= sizeOf(this.sectionsCache.get(oldest))
      this.sectionsCache.delete(oldest)
    }
  }

  /**
   * Compliance findings (vendor manuals), optionally narrowed by subtype and text.
   *
   * A module or subtype filter alone is a valid query: "every deviation in Dcm"
   * needs no text. The kind filter is always constrained to compliance findings;
   * a caller-supplied `kind` selects the subtype (deviation, unsupported, limit)
   * rather than replacing the compliance scope.
   */
  compliance(options = {}) {
    const subtype = options.kind === undefined || options.kind === null || options.kind === '' ? undefined : options.kind
    const wantedKind = subtype === undefined ? 'compliance' : normalizeKind(subtype)
    // Scope comes from the caller's arguments only: with neither a module, a
    // subtype, nor text, "list every finding in the store" would dump hundreds
    // of records with no narrowing.
    const hasScope = Boolean(options.module) || subtype !== undefined || Boolean(options.query)
    if (!hasScope) {
      return { total: 0, hits: [], empty: true }
    }
    const text = options.query
    if (text === undefined || text === '') {
      // No text: list the module's findings directly.
      const module = this.resolveModule(options.module)
      const pool = module ? (this.byModule.get(module) ?? []) : this.entries
      const matched = pool.filter((entry) => kindMatches(entry.kind, wantedKind))
      return { total: matched.length, hits: matched.slice(0, 50).map((entry) => ({ index: entry, score: 1 })) }
    }
    return this.search({ ...options, kind: wantedKind })
  }

  /** Manifest, actual counts, and index health for this store. */
  stats() {
    const ids = this.byId
    const duplicateGroups = [...ids.values()].filter((list) => list.length > 1).length
    const duplicateRecords = [...ids.values()].reduce((sum, list) => sum + Math.max(0, list.length - 1), 0)
    // Only a portable store promises `<kb_id>::<entity>` ids; reporting a count of
    // violations for a generic store would contradict the SKIP in `validate()`.
    const prefixRuleApplies = this.profile === FORMAT_NAME
    const prefixViolations = prefixRuleApplies ? [...ids.keys()].filter((id) => this.kbId && !id.startsWith(this.kbId)).length : 0
    return {
      kb_id: this.kbId,
      title: this.title,
      dir: this.dir,
      version: this.manifest?.version ?? '',
      language: this.manifest?.language ?? '',
      engine: this.manifest?.engine ?? '',
      format: this.manifest?.format?.name ?? '',
      profile: this.profile,
      inferred: [...this.inferred],
      loadedAt: this.loadedAt,
      stale: this.staleOnDisk(),
      prefixRuleApplies,
      manifestCounts: this.manifest?.counts ?? {},
      actual: {
        entries: this.entries.length,
        uniqueIds: ids.size,
        duplicateIdGroups: duplicateGroups,
        duplicateRecords,
        prefixViolations,
        badLines: this.badLines,
        modules: this.byModule.size,
        kinds: this.kinds,
      },
      modules: this.modules.map((item) => item.module),
    }
  }

  /**
   * Structural validation of the store against its own manifest and format.
   * `deep` also counts chunks.jsonl and every section file.
   */
  async validate(options = {}) {
    const checks = []
    const add = (check, status, detail) => checks.push({ check, status, detail })
    const counts = this.manifest?.counts ?? {}
    const format = this.manifest?.format ?? {}
    // A generic store has no manifest to check itself against. Its checks are
    // SKIPped rather than PASSed: "not applicable" must not look like "verified".
    const generic = this.profile !== FORMAT_NAME
    add(
      'format declaration',
      format.name === FORMAT_NAME ? 'PASS' : generic ? 'SKIP' : 'WARN',
      `profile=${this.profile || '(none)'} name=${format.name ?? '(none)'} version=${format.version ?? '(none)'} encoding=${format.encoding ?? '(none)'}`,
    )
    add(
      'manifest counts.entries',
      counts.entries === undefined ? (generic ? 'SKIP' : 'PASS') : counts.entries === this.entries.length ? 'PASS' : 'FAIL',
      `manifest=${counts.entries ?? '(none)'} actual=${this.entries.length}`,
    )
    const stats = this.stats()
    add(
      'unique record ids',
      stats.actual.duplicateRecords === 0 ? 'PASS' : 'FAIL',
      `${stats.actual.duplicateIdGroups} duplicated ids, ${stats.actual.duplicateRecords} extra records`,
    )
    add(
      'id prefix == kb_id',
      generic ? 'SKIP' : stats.actual.prefixViolations === 0 ? 'PASS' : 'FAIL',
      generic
        ? `generic store ids are not required to start with ${this.kbId}`
        : stats.actual.prefixViolations === 0
          ? `all ids start with ${this.kbId || '(none)'}`
          : `${stats.actual.prefixViolations} violations`,
    )
    add('jsonl parsing', this.badLines === 0 ? 'PASS' : 'FAIL', `${this.badLines} unparseable lines`)
    const stale = this.staleOnDisk()
    add(
      'entries file unchanged',
      stale ? 'WARN' : 'PASS',
      stale ? 'the entries file changed after it was indexed; the next load re-indexes it' : 'the index matches the file on disk',
    )
    const declaredModules = Array.isArray(this.manifest?.modules) ? this.manifest.modules : []
    const actualModules = this.modules.map((item) => item.module)
    const sameModules = declaredModules.length === actualModules.length && declaredModules.every((name) => actualModules.includes(name))
    add(
      'modules match entries',
      generic ? 'SKIP' : sameModules ? 'PASS' : 'WARN',
      `manifest=${declaredModules.length} actual=${actualModules.length}${sameModules ? '' : ` diff=${declaredModules.filter((name) => !actualModules.includes(name)).slice(0, 5)}`}`,
    )

    if (options.deep) {
      if (counts.chunks !== undefined) {
        const chunks = await countJsonlLines(join(this.dir, this.manifest?.files?.chunks ?? 'chunks.jsonl'))
        add('chunks.jsonl count', chunks === counts.chunks ? 'PASS' : 'FAIL', `manifest=${counts.chunks} actual=${chunks}`)
      }
      if (counts.sections !== undefined) {
        const rel = this.manifest?.files?.sections ?? 'sections/'
        let total = 0
        try {
          const target = join(this.dir, rel)
          const isDir = (await stat(target)).isDirectory()
          if (isDir) {
            const items = await readdir(target)
            for (const item of items) {
              if (!item.endsWith('.jsonl')) continue
              total += (await countJsonlLines(join(target, item))) ?? 0
            }
          } else {
            total = (await countJsonlLines(target)) ?? 0
          }
          add('sections count', total === counts.sections ? 'PASS' : 'FAIL', `manifest=${counts.sections} actual=${total}`)
        } catch (error) {
          add('sections count', 'WARN', String(error?.message ?? error))
        }
      }
    }

    return { ok: !checks.some((item) => item.status === 'FAIL'), profile: this.profile, inferred: [...this.inferred], checks }
  }
}

/**
 * All configured stores, loaded together and queried as one corpus.
 */
export class SpecKbRegistry {
  constructor(config = {}) {
    this.config = config
    this.paths = normalizePathList(config.paths)
    this.pathProvider = typeof config.pathProvider === 'function' ? config.pathProvider : null
    this.kbs = []
    this.loadedSignature = null
    this.queue = Promise.resolve()
    this.loadMs = 0
  }

  /** Replace the store paths; the next `ensure()` reloads when they changed. */
  setPaths(paths) {
    this.paths = normalizePathList(paths)
  }

  get signature() {
    return this.paths.join('|')
  }

  async ensure() {
    if (this.pathProvider !== null) this.paths = normalizePathList(this.pathProvider())
    if (this.loadedSignature === this.signature && this.kbs.length > 0 && !this.#anyStale()) return this
    // Loads are serialized. A settings change that arrives while a load is in
    // flight waits for it instead of starting a second full read of every store;
    // two concurrent callers would otherwise parse ~180 MB of JSONL twice.
    const run = async () => {
      if (this.loadedSignature === this.signature && this.kbs.length > 0) {
        // Same paths, but a store was rebuilt on disk: re-index only that store.
        await this.#refreshStale()
        return
      }
      await this.#loadAll(this.signature)
    }
    const task = this.queue.then(run, run)
    this.queue = task.catch(() => {})
    await task
    return this
  }

  /** Whether an indexed store's file changed since it was loaded. */
  #anyStale() {
    const now = Date.now()
    return this.kbs.some((kb) => (kb.loaded ? kb.staleOnDisk() : kb.nextRetryAt > 0 && now >= kb.nextRetryAt))
  }

  /**
   * Re-index stores whose entries file changed on disk.
   *
   * The alternative — serving the old index — would pair stale byte offsets with
   * fresh bytes and return another record's body, so a changed store is reloaded
   * before the caller reads from it. A reload that fails is retried after a pause
   * instead of disabling the store for the rest of the session.
   */
  async #refreshStale() {
    const now = Date.now()
    for (const kb of this.kbs) {
      if (now < kb.nextRetryAt) continue
      const stale = kb.loaded ? kb.staleOnDisk() : kb.nextRetryAt > 0
      if (!stale) continue
      try {
        await kb.reload()
        kb.nextRetryAt = 0
      } catch (error) {
        kb.loadError = String(error?.message ?? error)
        kb.loaded = false
        kb.nextRetryAt = now + 5000
      }
    }
  }

  async #loadAll(signature) {
    const started = Date.now()
    const dirs = await discoverKbDirs(this.paths)
    const kbs = []
    for (const dir of dirs) {
      const kb = new SpecKb(dir)
      try {
        await kb.load()
      } catch (error) {
        kb.loadError = String(error?.message ?? error)
      }
      kbs.push(kb)
    }
    this.kbs = kbs
    this.loadMs = Date.now() - started
    this.loadedSignature = signature
    return this
  }

  get usable() {
    return this.kbs.filter((kb) => kb.loaded)
  }

  byId(kbId) {
    if (!kbId) return null
    const wanted = String(kbId).toLowerCase()
    return this.usable.find((kb) => kb.kbId.toLowerCase() === wanted || kb.dir.toLowerCase().endsWith(wanted)) ?? null
  }

  /**
   * Search every store (or one named by `kb`).
   *
   * An unknown `kb` value is a caller error, not a reason to search everything:
   * silently widening the scope would return records from the wrong store.
   */
  async search(options = {}) {
    await this.ensure()
    const limit = Math.min(Math.max(Number(options.limit) || this.config.maxResults || 8, 1), 50)
    const kb = this.byId(options.kb)
    if (options.kb && kb === null) {
      return { hits: [], total: 0, unknownKb: String(options.kb), empty: true }
    }
    const targets = kb ? [kb] : this.usable
    const hits = []
    let total = 0
    for (const store of targets) {
      const result = store.search({ ...options, limit })
      total += result.total
      if (result.empty) continue
      for (const hit of result.hits) hits.push({ store, index: hit.index, score: hit.score })
    }
    hits.sort((a, b) => b.score - a.score || a.index.nameLower.localeCompare(b.index.nameLower))
    return { hits: hits.slice(0, limit), total }
  }

  /** Full record lookup by id or name; returns the first match plus siblings. */
  async get(ref, options = {}) {
    await this.ensure()
    const kb = this.byId(options.kb)
    if (options.kb && kb === null) {
      return { found: false, suggestions: [], unknownKb: String(options.kb) }
    }
    const targets = kb ? [kb] : this.usable
    for (const store of targets) {
      const list = store.match(ref, options.module)
      if (list.length === 0) continue
      const index = list[0]
      const record = store.record(index)
      if (record === null && store.staleOnDisk()) {
        return {
          found: false,
          stale: true,
          store,
          index,
          suggestions: [],
          hint: 'the store file changed on disk after it was indexed; retry once it is readable again',
        }
      }
      return {
        found: record !== null,
        store,
        index,
        record,
        duplicateCount: list.length - 1,
        // Cite the index, exactly like a search hit: the raw record may use
        // aliased field names the citation would not recognise.
        citation: citationOf(store.kbId, index),
      }
    }
    const suggestions = []
    for (const store of targets) {
      for (const hit of store.search({ query: String(ref ?? ''), module: options.module, limit: 5 }).hits) {
        suggestions.push(`${store.kbId}/${hit.index.module}/${hit.index.name}`)
      }
    }
    return { found: false, suggestions: suggestions.slice(0, 10) }
  }

  async trace(ref, options = {}) {
    await this.ensure()
    const kb = this.byId(options.kb)
    const results = []
    for (const store of kb ? [kb] : this.usable) {
      const result = await store.trace(ref)
      if (result.found) return { ...result, store }
      results.push(...(result.candidates ?? []).map((candidate) => `${store.kbId}/${candidate}`))
    }
    return { found: false, candidates: results.slice(0, 10) }
  }

  /**
   * Section text for one module.
   *
   * With two stores mounted, "NvM" resolves in both (AUTOSAR calls the module
   * NVRAMManager, the vendor manual calls it NvM). The first store that has
   * matching text wins, so the caller gets the most specific answer; pass `kb`
   * to target one store explicitly.
   */
  async sections(module, options = {}) {
    await this.ensure()
    const kb = this.byId(options.kb)
    if (options.kb && kb === null) {
      return { found: false, available: this.usable.flatMap((store) => store.modules.map((item) => item.module)).slice(0, 40) }
    }
    for (const store of kb ? [kb] : this.usable) {
      const result = await store.sections(module, options)
      if (result.found && (result.items.length > 0 || options.section || options.title)) {
        return { ...result, store }
      }
    }
    return { found: false, available: this.usable.flatMap((store) => store.modules.map((item) => item.module)).slice(0, 40) }
  }

  async compliance(options = {}) {
    await this.ensure()
    const kb = this.byId(options.kb)
    if (options.kb && kb === null) return []
    const limit = Math.min(Math.max(Number(options.limit) || this.config.maxResults || 8, 1), 50)
    const hits = []
    for (const store of kb ? [kb] : this.usable) {
      for (const hit of store.compliance({ ...options, limit }).hits) hits.push({ store, index: hit.index, score: hit.score })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, limit)
  }

  /**
   * Deterministic evidence pack for an analysis question: the strongest
   * requirements, APIs, configuration parameters, compliance findings, and
   * matching section headings, each with its citation.
   *
   * The topic goes through the same Chinese-alias expansion as the search, so a
   * question asked in Chinese still reaches the English specification.
   */
  async brief(topic, options = {}) {
    await this.ensure()
    const limit = Math.min(Math.max(Number(options.limit) || 3, 1), 8)
    const kb = this.byId(options.kb)
    if (options.kb && kb === null) {
      return `## Spec knowledge base evidence — ${topic}\n\n### Coverage\n\n- No store named "${options.kb}" is mounted; nothing was searched.`
    }
    const targets = kb ? [kb] : this.usable
    const modules = Array.isArray(options.modules) ? options.modules : []
    const sectionTerms = expandQuery(topic)
    const sections = []
    const groups = { requirement: [], api: [], config: [], compliance: [] }

    for (const store of targets) {
      const module = modules.length === 1 ? modules[0] : undefined
      for (const kind of ['requirement', 'api', 'config']) {
        for (const hit of store.search({ query: topic, module, kind, limit: limit * 2 }).hits) {
          groups[kind].push({ store, index: hit.index, score: hit.score })
        }
      }
      for (const hit of store.compliance({ query: topic, module, limit }).hits) {
        groups.compliance.push({ store, index: hit.index, score: hit.score })
      }
      // Section headings are English too, so match them on the expanded terms.
      for (const moduleName of modules.length > 0 ? modules : store.modules.map((item) => item.module)) {
        const result = await store.sections(moduleName, { title: sectionTerms.join(' '), limit })
        for (const item of result.items ?? []) sections.push({ store, module: result.module, item })
        if (result.items?.length > 0) break
      }
    }

    const budget = this.config.maxBodyChars || 6000
    const excerptChars = Math.max(200, Math.min(600, Math.floor(budget / 12)))
    const lines = [`## Spec knowledge base evidence — ${topic}`, '', `Sources: ${targets.map((store) => `${store.kbId} (${store.title})`).join('; ')}`, '']
    let evidence = 0

    const section = async (title, items) => {
      if (items.length === 0) return
      lines.push(`### ${title}`, '')
      for (const item of items.slice(0, limit)) {
        const record = item.store.record(item.index)
        const citation = citationOf(item.store.kbId, record ?? {})
        lines.push(`- **${item.index.name}** — ${citation}`)
        const body = clip(bodyOf(record ?? {}), excerptChars)
        if (body) lines.push(`  ${body}`)
        if (item.index.upstream && item.index.upstream.length > 0) {
          lines.push(`  upstream: ${item.index.upstream.slice(0, 8).join(', ')}`)
        }
        evidence += 1
      }
      lines.push('')
    }

    await section('Requirements', groups.requirement)
    await section('API definitions', groups.api)
    await section('Configuration parameters', groups.config)
    await section('Compliance findings', groups.compliance)
    if (sections.length > 0) {
      lines.push('### Sections', '')
      for (const entry of sections.slice(0, limit)) {
        const citation = citationOf(entry.store.kbId, { section: entry.item.section, page: entry.item.page, source: { document: entry.item.document } })
        lines.push(`- **${entry.module} §${entry.item.section} ${entry.item.title}** — ${citation}`)
        lines.push(`  ${clip(entry.item.text, 400)}`)
        evidence += 1
      }
      lines.push('')
    }

    lines.push('### Coverage', '')
    if (evidence === 0) {
      lines.push(`- No record matched "${topic}" in ${targets.map((store) => store.kbId).join(', ')}. Treat the topic as not covered by the knowledge base.`)
    } else {
      lines.push(`- ${evidence} records cited above; cite them verbatim and do not add requirement ids or API signatures absent from them.`)
      if (groups.requirement.length === 0) lines.push('- No normative requirement matched; be explicit that the answer is not requirement-backed.')
    }
    return lines.join('\n')
  }

  async validate(options = {}) {
    await this.ensure()
    const reports = []
    for (const store of this.kbs) {
      if (store.loadError) {
        reports.push({ kb: store.dir, ok: false, error: store.loadError, checks: [] })
        continue
      }
      reports.push({ kb: store.kbId, title: store.title, ...(await store.validate(options)) })
    }
    return { ok: reports.every((report) => report.ok), reports }
  }
}
