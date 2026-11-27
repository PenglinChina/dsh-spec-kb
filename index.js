/**
 * dsh-spec-kb — a DeepSeek Harness plugin that mounts local `portable-spec-kb`
 * stores and gives the agent read-only, citation-bearing access to them.
 *
 * Design goals:
 *   - Load stores in place (no import, no copy): the store directory stays the
 *     source of truth, exactly like its own MCP server does.
 *   - Keep specification work spec-first: a system-prompt section tells the agent
 *     to consult the stores before answering from memory.
 *   - Never fabricate: every hit carries a citation (store, document, section,
 *     printed page) and a requirement id when one exists.
 *
 * Tools: spec_kb_info / spec_kb_search / spec_kb_get / spec_kb_trace /
 *        spec_kb_section / spec_kb_compliance / spec_kb_brief / spec_kb_validate
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { SpecKbRegistry, bodyOf, citationOf, clip, looksLikeStoreSync, normalizePathList } from './lib/kb.js'
import { createSpecKbRoutes } from './lib/routes.js'
import { effectivePaths } from './lib/settings.js'

export const name = 'dsh-spec-kb'

export const inject = ['tools', 'systemPrompt']

export const Config = z.object({
  paths: z
    .array(String)
    .default([])
    .description(
      'Absolute paths of portable-spec-kb stores, or of a parent directory whose direct children are stores. ' +
        '绝对路径：知识库目录，或直接包含多个知识库的父目录。',
    ),
  guidance: z
    .boolean()
    .default(true)
    .description('Contribute a system-prompt section that makes the agent consult the stores first. 是否注入“优先查知识库”的提示。'),
  maxResults: z.number().min(1).max(50).step(1).default(8).description('Default hit limit for search/compliance tools.'),
  maxBodyChars: z.number().min(500).max(20000).step(1).default(6000).description('Maximum characters of body text one tool returns.'),
  loadOnStart: z
    .boolean()
    .default(false)
    .description('Build the index when the plugin loads instead of on the first tool call. 启动即建索引（较慢）。'),
})

/** Compact JSON for tool results; keeps token use predictable. */
function json(value) {
  return JSON.stringify(value)
}

function errorResult(error) {
  return json({ error: String(error?.message ?? error) })
}

/**
 * Search hits projected for the model: identifiers, citation, bounded summary.
 *
 * The citation is built from the index entry, which carries the document name,
 * so a hit cites exactly like the full record it points at.
 */
function projectHits(hits) {
  return hits.map(({ store, index, score }) => ({
    kb: store.kbId,
    id: index.id,
    kind: index.kind,
    module: index.module,
    name: index.name,
    section: index.section || undefined,
    page: index.page ?? undefined,
    document: index.document || undefined,
    summary: clip(index.summary, 280),
    citation: citationOf(store.kbId, index),
    score,
  }))
}

/** Full record projected for the model: same fields plus bounded body text. */
function projectRecord(store, index, record, maxBodyChars) {
  const fields = record?.fields && typeof record.fields === 'object' ? record.fields : {}
  // `bodyOf` applies the same aliases the index used, so `get` returns the text
  // the search hit summarised — including a plain JSONL store's `text`/`content`.
  const bodyText = String(bodyOf(record) ?? '')
  const fieldSummary = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue
    const text = String(value)
    if (key === 'body' || key === 'definition' || key === 'description' || key === 'syntax' || key === 'lead') continue
    fieldSummary[key] = clip(text, 400)
  }
  return {
    kb: store.kbId,
    id: index.id,
    kind: index.kind,
    module: index.module,
    name: index.name,
    // A single-field record gives name and title the same value; repeating it
    // adds no information.
    title: index.title && index.title !== index.name ? index.title : undefined,
    section: index.section || undefined,
    page: index.page ?? undefined,
    language: record?.language ?? undefined,
    document: index.document || undefined,
    documentId: record?.source?.document_id ?? record?.document_id ?? undefined,
    upstream: Array.isArray(index.upstream) && index.upstream.length > 0 ? index.upstream : undefined,
    requirement: record?.requirement ?? undefined,
    // Cite the index, like a search hit: the raw record's field names may not be
    // the ones `citationOf` recognises.
    citation: citationOf(store.kbId, index),
    fields: Object.keys(fieldSummary).length > 0 ? fieldSummary : undefined,
    body: bodyText === '' ? undefined : clip(bodyText, maxBodyChars),
    bodyTruncated: bodyText.length > maxBodyChars ? true : undefined,
  }
}

/** Names of the stores a configured path resolves to, without loading the index. */
function describeStores(paths) {
  const names = []
  for (const raw of paths ?? []) {
    const dir = String(raw).replace(/[\\/]+$/, '')
    if (dir === '') continue
    try {
      // A path may be a store, a parent of stores, or both; the prompt must name
      // exactly what the loader mounts, so children are always inspected.
      if (looksLikeStoreSync(dir)) names.push(basename(dir))
      for (const child of readdirSync(dir, { withFileTypes: true })) {
        if (!child.isDirectory()) continue
        const name = child.name.toLowerCase()
        if (name === 'sections' || name === 'chunks' || name.startsWith('.')) continue
        if (looksLikeStoreSync(join(dir, child.name))) names.push(child.name)
      }
    } catch {
      /* a path that does not exist contributes no store names */
    }
  }
  return [...new Set(names)]
}

/** Keep one store's projection bounded: the module roster can hold 150+ names. */
function projectStats(stats, moduleLimit = 40) {
  const modules = Array.isArray(stats.modules) ? stats.modules : []
  return {
    ...stats,
    modules: modules.slice(0, moduleLimit),
    moduleCount: modules.length,
    modulesTruncated: modules.length > moduleLimit ? true : undefined,
  }
}

/**
 * The guidance text with the store list left as a prompt variable reference.
 *
 * The variable is re-read at every prompt assembly, so a path saved in the
 * Settings page appears in the next turn without restarting the Harness.
 */
function guidanceTemplate() {
  return [
    '## Local specification knowledge bases (spec-kb)',
    'The Harness mounts local standard spec-kb stores that the spec_kb_* tools read in place. Mounted stores: {{spec_kb_stores}}.',
    'For any question these stores cover (requirements, APIs, configuration parameters, module behaviour, vendor limits and deviations):',
    '1. Consult the knowledge base before answering from memory. Use spec_kb_search to find an entity, spec_kb_get for one full record, spec_kb_trace for requirement provenance, spec_kb_compliance for "is this supported", and spec_kb_brief to assemble evidence for an analysis or design answer.',
    '2. Ground every claim taken from the stores in a retrieved record and cite it as `<kb_id> · <document> · §<section> · p.<page>`, including the requirement id when the record has one.',
    '3. If retrieval returns nothing relevant, state that the knowledge base does not cover the point. Never invent requirement ids, API signatures, default values, or configuration parameters.',
    '4. When retrieved text and prior knowledge disagree, the knowledge base wins; say which record settled it.',
  ].join('\n')
}

/** One tool registration helper: string output rendered as plain text. */
function textTool(ctx, definition) {
  return ctx.tools.register(
    defineTool({
      ...definition,
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
    }),
  )
}

export async function apply(ctx, config) {
  const settings = config ?? {}
  const defaults = normalizePathList(settings.paths)
  const registry = new SpecKbRegistry({
    maxBodyChars: settings.maxBodyChars,
    paths: effectivePaths(defaults).paths,
    // Every ensure() re-reads the Settings page's file, so a saved path list
    // applies to the next tool call without a restart.
    pathProvider: () => effectivePaths(defaults).paths,
  })
  const disposers = []
  // Surfaced by spec_kb_info: a Settings page that never registered is a
  // diagnosable fact, not something to hide behind a log line.
  const routesState = { ok: false, reason: 'not attempted' }
  const keep = (disposer, label) => {
    if (typeof disposer === 'function') disposers.push(disposer)
    else ctx.logger?.warn?.(`dsh-spec-kb: ${label} returned no disposer; cleanup skipped`)
    return disposer
  }

  if (settings.loadOnStart) {
    registry.ensure().catch((error) => {
      ctx.logger?.warn?.(`dsh-spec-kb: initial load failed: ${String(error?.message ?? error)}`)
    })
  }

  const tool = (definition) => {
    try {
      keep(textTool(ctx, definition), definition.name)
    } catch (error) {
      ctx.logger?.error?.(`dsh-spec-kb: failed to register ${definition.name}: ${String(error?.message ?? error)}`)
    }
  }

  tool({
    name: 'spec_kb_info',
    description:
      'Describe the mounted specification knowledge bases: store ids, versions, counts, modules, record kinds, and index health (duplicate ids, prefix violations). Call it first when unsure which store covers a module.',
    parameters: {},
    async execute() {
      try {
        await registry.ensure()
        const effective = effectivePaths(defaults)
        const knowledgeBases = registry.kbs.map((store) =>
          store.loadError ? { dir: store.dir, error: store.loadError } : projectStats(store.stats()),
        )
        // The store mix is per-store data; a top-level "format" would claim every
        // store follows the portable contract even when a generic one is mounted.
        const profiles = {}
        for (const store of registry.kbs) {
          const key = store.loadError ? 'failed' : store.profile || 'unknown'
          profiles[key] = (profiles[key] ?? 0) + 1
        }
        return json({
          tool: 'dsh-spec-kb',
          profiles,
          paths: { defaults, effective: effective.paths, source: effective.source },
          loadedInMs: registry.loadMs,
          knowledgeBases,
          failed: registry.kbs.filter((store) => store.loadError).length,
          settingsPage: routesState.ok ? { ok: true } : { ok: false, reason: routesState.reason },
        })
      } catch (error) {
        return errorResult(error)
      }
    },
  })

  tool({
    name: 'spec_kb_search',
    description:
      'Search the specification knowledge bases by text, module, kind, or exact name. Returns compact hits with store, module, section, printed page, summary, and citation. Use it before answering any question the stores cover; follow up with spec_kb_get for one full record.',
    parameters: {
      query: { type: 'string', description: 'Search text, e.g. "NvM write protection", "SWS_NvM_00051", "Xcp calibration".' },
      module: { type: 'string', description: 'Restrict to one module (e.g. NvM, Dcm); Chinese aliases such as 诊断 for Dcm are accepted.' },
      kind: {
        type: 'string',
        description: 'Restrict the record kind: requirement, api, config, glossary, section, or compliance (any compliance_* finding).',
      },
      name: { type: 'string', description: 'Exact entity name (requirement id, API name, parameter name); takes precedence over query.' },
      kb: { type: 'string', description: 'Restrict to one store by kb_id (see spec_kb_info).' },
      limit: { type: 'number', description: 'Maximum hits (1-50, default 8 or the plugin default).' },
    },
    async execute(args) {
      try {
        const { hits, total, unknownKb } = await registry.search(args)
        if (unknownKb !== undefined) {
          return json({
            error: `No mounted store is named "${unknownKb}".`,
            available: registry.usable.map((store) => store.kbId),
          })
        }
        return json({
          query: args.query ?? null,
          module: args.module ?? null,
          kind: args.kind ?? null,
          matched: total,
          returned: hits.length,
          truncated: total > hits.length ? true : undefined,
          hits: projectHits(hits),
          hint:
            hits.length === 0
              ? args.query === undefined && args.name === undefined
                ? 'Provide a query, a module, a kind, or an exact name.'
                : 'No record matched. Treat the question as not covered by the knowledge base.'
              : undefined,
        })
      } catch (error) {
        return errorResult(error)
      }
    },
  })

  tool({
    name: 'spec_kb_get',
    description:
      'Return one full specification record by exact name or record id: fields, printed section and page, source document, upstream requirement ids, and bounded body text. Use after spec_kb_search to quote a requirement, API signature, or configuration parameter precisely.',
    parameters: {
      name: { type: 'string', required: true, description: 'Exact entity name or full record id.' },
      module: { type: 'string', description: 'Restrict to one module.' },
      kb: { type: 'string', description: 'Restrict to one store by kb_id.' },
    },
    async execute(args) {
      try {
        const found = await registry.get(args.name, { module: args.module, kb: args.kb })
        if (found.unknownKb !== undefined) {
          return json({
            error: `No mounted store is named "${found.unknownKb}".`,
            available: registry.usable.map((store) => store.kbId),
          })
        }
        if (!found.found) {
          return json({
            found: false,
            name: args.name,
            stale: found.stale ? true : undefined,
            hint: found.hint,
            suggestions: found.suggestions ?? [],
          })
        }
        return json({
          found: true,
          duplicateRecords: found.duplicateCount > 0 ? found.duplicateCount : undefined,
          entry: projectRecord(found.store, found.index, found.record, settings.maxBodyChars ?? 6000),
        })
      } catch (error) {
        return errorResult(error)
      }
    },
  })

  tool({
    name: 'spec_kb_trace',
    description:
      'Trace one requirement through the specification: the upstream requirements it refines and the downstream requirements that refine it. Use it to answer "where does this requirement come from" or "which requirements implement it".',
    parameters: {
      id: { type: 'string', required: true, description: 'Requirement id or record id, e.g. SWS_NvM_00051.' },
      kb: { type: 'string', description: 'Restrict to one store by kb_id.' },
    },
    async execute(args) {
      try {
        const result = await registry.trace(args.id, { kb: args.kb })
        if (!result.found) {
          return json({ found: false, id: args.id, candidates: result.candidates ?? [], hint: 'No requirement with that id in the mounted stores.' })
        }
        const requirement = projectRecord(result.store, result.requirement, result.store.record(result.requirement), 2000)
        return json({
          found: true,
          requirement,
          upstream: result.upstream,
          downstream: result.downstream,
          duplicateRecords: result.duplicateCount > 0 ? result.duplicateCount : undefined,
        })
      } catch (error) {
        return errorResult(error)
      }
    },
  })

  tool({
    name: 'spec_kb_section',
    description:
      'Read the full text of documentation sections, which search results only summarize. Identify them by module plus a section number or a title substring. Use it when a requirement, table, or explanation needs more context than one record.',
    parameters: {
      module: { type: 'string', required: true, description: 'Module key such as NvM or Dcm; aliases such as 诊断 are accepted.' },
      section: { type: 'string', description: 'Exact section number, e.g. "7.1.2".' },
      title: { type: 'string', description: 'Case-insensitive substring of the section title, used when the number is unknown.' },
      kb: { type: 'string', description: 'Restrict to one store by kb_id.' },
      limit: { type: 'number', description: 'Maximum sections (1-50, default 10).' },
    },
    async execute(args) {
      try {
        const result = await registry.sections(args.module, {
          section: args.section,
          title: args.title,
          kb: args.kb,
          limit: args.limit,
        })
        if (!result.found) {
          return json({ found: false, module: args.module, available: result.available ?? [], hint: 'No store has section text for that module.' })
        }
        const maxBody = settings.maxBodyChars ?? 6000
        return json({
          found: true,
          kb: result.store.kbId,
          module: result.module,
          total: result.total,
          truncated: result.truncated || undefined,
          items: result.items.map((item) => ({
            section: item.section,
            title: item.title,
            page: item.page ?? undefined,
            document: item.document || undefined,
            text: clip(item.text, maxBody),
            textTruncated: item.text.length > maxBody ? true : undefined,
          })),
        })
      } catch (error) {
        return errorResult(error)
      }
    },
  })

  tool({
    name: 'spec_kb_compliance',
    description:
      'List standard-compliance findings from vendor manuals: deviations from the specification, unsupported features, and documented limits or preconditions. Use it to answer "does this implementation support X" or to qualify an answer about vendor behaviour.',
    parameters: {
      query: { type: 'string', description: 'Narrow the findings by text, e.g. "security access", "多块任务".' },
      module: { type: 'string', description: 'Restrict to one module.' },
      kind: { type: 'string', description: 'Restrict to deviation, unsupported, or limit (compliance_* subtypes also accepted).' },
      kb: { type: 'string', description: 'Restrict to one store by kb_id.' },
      limit: { type: 'number', description: 'Maximum findings (1-50, default 8).' },
    },
    async execute(args) {
      try {
        const hits = await registry.compliance(args)
        // compliance() ran ensure(), so byId() now sees the mounted stores.
        if (args.kb && hits.length === 0 && registry.byId(args.kb) === null) {
          return json({
            error: `No mounted store is named "${args.kb}".`,
            available: registry.usable.map((store) => store.kbId),
          })
        }
        return json({
          matched: hits.length,
          items: projectHits(hits),
          hint: hits.length === 0 ? 'No compliance finding matched; this store may not document that behaviour.' : undefined,
        })
      } catch (error) {
        return errorResult(error)
      }
    },
  })

  tool({
    name: 'spec_kb_brief',
    description:
      'Assemble a bounded evidence pack for an analysis or design question: the strongest requirements, API definitions, configuration parameters, compliance findings, and section headings for a topic, each with its citation. Use it at the start of a non-trivial question the stores cover so the answer is built on cited records rather than memory.',
    parameters: {
      topic: { type: 'string', required: true, description: 'The question or topic, e.g. "NvM write protection" or "Dcm security access sequence".' },
      modules: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional module filter, e.g. ["NvM","Dcm"].',
      },
      kb: { type: 'string', description: 'Restrict to one store by kb_id.' },
      limit: { type: 'number', description: 'Records per category (1-8, default 3).' },
    },
    async execute(args) {
      try {
        return await registry.brief(args.topic, { modules: args.modules, kb: args.kb, limit: args.limit })
      } catch (error) {
        return errorResult(error)
      }
    },
  })

  tool({
    name: 'spec_kb_validate',
    description:
      'Check the mounted stores for structural problems: format declaration, record counts against the manifest, duplicate ids, id prefix violations, module coverage, and optionally chunk/section counts. Use it before trusting a store or after rebuilding one.',
    parameters: {
      deep: { type: 'boolean', description: 'Also count chunks.jsonl and every section file (slower).' },
    },
    async execute(args) {
      try {
        const report = await registry.validate({ deep: args.deep === true })
        return json(report)
      } catch (error) {
        return errorResult(error)
      }
    },
  })

  if (settings.guidance !== false) {
    try {
      // The store list is a prompt variable, so it is re-read at every prompt
      // assembly: a path saved in the Settings page shows up in the next turn
      // without restarting the Harness.
      keep(
        ctx.systemPrompt.variable('spec_kb_stores', () => {
          const names = describeStores(effectivePaths(defaults).paths)
          return names.length > 0 ? names.join(', ') : 'none'
        }),
        'prompt variable',
      )
      keep(
        ctx.systemPrompt.section({
          name: 'spec-kb:guidance',
          order: 8000,
          text: guidanceTemplate(),
        }),
        'prompt section',
      )
    } catch (error) {
      ctx.logger?.warn?.(`dsh-spec-kb: prompt section failed: ${String(error?.message ?? error)}`)
    }
  }

  // The Settings page's HTTP API. Optional: profiles without a web server
  // (headless/TUI) keep the tools and skip the page.
  //
  // The routes live in an injected child scope, so unloading the plugin removes
  // them again; `webServer.register` throws on a duplicate path, which would
  // happen if a route outlived its owner.
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (scope) => {
        const routeDisposers = []
        for (const route of createSpecKbRoutes({ registry, defaults })) {
          routeDisposers.push(scope.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }))
        }
        routesState.ok = true
        routesState.reason = ''
        return () => {
          for (const dispose of routeDisposers.reverse()) {
            try {
              dispose()
            } catch {
              /* the route is already gone */
            }
          }
        }
      })
    } catch (error) {
      routesState.reason = String(error?.message ?? error)
      ctx.logger?.warn?.(`dsh-spec-kb: Settings page unavailable (web routes failed): ${routesState.reason}`)
    }
  } else {
    routesState.reason = 'no webServer service in this profile'
  }

  ctx.logger?.info?.(
    `dsh-spec-kb: ${(settings.paths ?? []).length} configured path(s), tools registered${settings.guidance === false ? ', guidance off' : ''}`,
  )

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        /* ignore teardown errors */
      }
    }
  }
}
