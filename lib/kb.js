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

import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

export const FORMAT_NAME = 'portable-spec-kb'

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

/** Compact JSON-ish text for indexes: whitespace-collapsed and clipped. */
function flatten(value, max) {
  return clip(value, max)
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

/** The primary explanatory text of a record. */
function bodyOf(record) {
  const fields = record.fields && typeof record.fields === 'object' ? record.fields : {}
  return (
    fields.body ??
    fields.definition ??
    fields.description ??
    fields.syntax ??
    fields.lead ??
    record.summary ??
    ''
  )
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

async function isKbDir(dir) {
  return exists(join(dir, 'manifest.json')) && exists(join(dir, 'entries.jsonl'))
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
 * Expand configured paths into store directories. A path may be a store, or a
 * parent whose direct children are stores (so a single `spec-kb/` root works).
 */
export async function discoverKbDirs(paths) {
  const found = []
  for (const raw of paths ?? []) {
    if (!raw) continue
    const dir = resolve(String(raw))
    if (await isKbDir(dir)) {
      found.push(dir)
      continue
    }
    for (const child of await subdirectories(dir)) {
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
    this.sectionsCache = new Map()
  }

  get title() {
    const name = this.manifest?.name
    if (name && typeof name === 'object') return name.zh || name.en || this.kbId
    if (typeof name === 'string') return name
    return this.kbId || this.dir
  }

  async load() {
    if (this.loaded) return this
    const manifestText = await readFile(join(this.dir, 'manifest.json'), 'utf8')
    this.manifest = JSON.parse(manifestText.replace(/^\uFEFF/, ''))
    this.kbId = String(this.manifest.kb_id ?? '')
    this.entriesRel = this.manifest.files?.entries ?? 'entries.jsonl'
    const entriesPath = join(this.dir, this.entriesRel)
    const raw = await readFile(entriesPath, 'utf8')
    this.text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw

    const text = this.text
    let start = 0
    while (start < text.length) {
      let end = text.indexOf('\n', start)
      if (end === -1) end = text.length
      const line = text.slice(start, end)
      if (line.trim() !== '') {
        let record
        try {
          record = JSON.parse(line)
        } catch {
          this.badLines += 1
        }
        if (record && typeof record === 'object') this.#index(record, start, line.length)
      }
      start = end + 1
    }

    for (const [module, list] of [...this.byModule.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      this.modules.push({ module, entries: list.length })
    }
    this.loaded = true
    return this
  }

  #index(record, offset, size) {
    const name = String(record.name ?? record.title ?? '')
    const module = String(record.module ?? '')
    const title = record.title !== undefined && record.title !== null ? String(record.title) : ''
    const summary = flatten(bodyOf(record), 500)
    const document = record?.source?.document ? String(record.source.document) : ''
    const entry = {
      id: String(record.id ?? ''),
      kind: String(record.kind ?? ''),
      module,
      name,
      nameLower: name.toLowerCase(),
      moduleLower: module.toLowerCase(),
      section: record.section !== undefined && record.section !== null ? String(record.section) : '',
      title,
      page: Number.isInteger(record.page) ? record.page : null,
      document,
      summary,
      hay: `${name} ${title} ${module} ${record.section ?? ''} ${summary}`.toLowerCase(),
      offset,
      size,
      upstream: Array.isArray(record.upstream) ? record.upstream.map(String) : null,
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

  /** Full record for one index entry, re-parsed from the retained source text. */
  record(entry) {
    if (!entry) return null
    const slice = this.text.slice(entry.offset, entry.offset + entry.size)
    try {
      return JSON.parse(slice)
    } catch {
      return null
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

  async #loadSections(module) {
    if (this.sectionsCache.has(module)) return this.sectionsCache.get(module)
    const rel = this.manifest?.files?.sections ?? 'sections/'
    let target = join(this.dir, rel)
    let isDirectory = false
    try {
      isDirectory = (await stat(target)).isDirectory()
    } catch {
      this.sectionsCache.set(module, [])
      return []
    }
    if (isDirectory) target = join(target, `${module}.jsonl`)
    const path = target
    const items = []
    try {
      const stream = createReadStream(path, { encoding: 'utf8' })
      const lines = createInterface({ input: stream, crlfDelay: Infinity })
      for await (const line of lines) {
        if (line.trim() === '') continue
        try {
          const record = JSON.parse(line.replace(/^\uFEFF/, ''))
          items.push({
            section: record.section !== undefined && record.section !== null ? String(record.section) : '',
            title: String(record.title ?? ''),
            page: Number.isInteger(record.page) ? record.page : null,
            document: record.document_id ? String(record.document_id) : record.source?.document ? String(record.source.document) : '',
            text: String(record.text ?? record.fields?.text ?? ''),
            raw: record,
          })
        } catch {
          /* skip malformed line */
        }
      }
    } catch {
      /* missing section file means the module has no section text */
    }
    this.sectionsCache.set(module, items)
    return items
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
    const prefixViolations = [...ids.keys()].filter((id) => this.kbId && !id.startsWith(this.kbId)).length
    return {
      kb_id: this.kbId,
      title: this.title,
      dir: this.dir,
      version: this.manifest?.version ?? '',
      language: this.manifest?.language ?? '',
      engine: this.manifest?.engine ?? '',
      format: this.manifest?.format?.name ?? '',
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
    add(
      'format declaration',
      format.name === FORMAT_NAME ? 'PASS' : 'WARN',
      `name=${format.name ?? '(none)'} version=${format.version ?? '(none)'} encoding=${format.encoding ?? '(none)'}`,
    )
    add(
      'manifest counts.entries',
      counts.entries === undefined || counts.entries === this.entries.length ? 'PASS' : 'FAIL',
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
      stats.actual.prefixViolations === 0 ? 'PASS' : 'FAIL',
      stats.actual.prefixViolations === 0 ? `all ids start with ${this.kbId || '(none)'}` : `${stats.actual.prefixViolations} violations`,
    )
    add('jsonl parsing', this.badLines === 0 ? 'PASS' : 'FAIL', `${this.badLines} unparseable lines`)
    const declaredModules = Array.isArray(this.manifest?.modules) ? this.manifest.modules : []
    const actualModules = this.modules.map((item) => item.module)
    const sameModules = declaredModules.length === actualModules.length && declaredModules.every((name) => actualModules.includes(name))
    add(
      'modules match entries',
      sameModules ? 'PASS' : 'WARN',
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

    return { ok: !checks.some((item) => item.status === 'FAIL'), checks }
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
    this.loading = null
    this.loadedSignature = null
    this.pendingSignature = null
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
    const signature = this.signature
    if (this.loadedSignature === signature && this.kbs.length > 0) return this
    if (this.loading !== null && this.pendingSignature === signature) {
      await this.loading
      return this
    }
    this.pendingSignature = signature
    this.loading = this.#loadAll(signature).finally(() => {
      this.loading = null
    })
    await this.loading
    return this
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
      return {
        found: record !== null,
        store,
        index,
        record,
        duplicateCount: list.length - 1,
        citation: citationOf(store.kbId, record ?? {}),
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
