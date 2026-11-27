/**
 * dsh-spec-kb — HTTP routes behind the Settings page.
 *
 * The browser half talks to these routes on the same origin, so the page can
 * show what is loaded, save a path list, reset to the bundle defaults, and
 * browse the filesystem for a store directory. Handlers are plain Node
 * functions, which keeps them testable without the Harness.
 */

import { discoverKbDirs, normalizePathList } from './kb.js'
import {
  browseDirectory,
  clearStoredPaths,
  describePath,
  effectivePaths,
  writeStoredPaths,
} from './settings.js'

export const API_PREFIX = '/api/spec-kb'

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readJsonBody(req, limit = 65536) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Host names that mean "this machine"; the GUI talks to the plugin over loopback. */
const LOCAL_HOSTS = new Set(['', 'localhost', '127.0.0.1', '::1'])

/** Hostname of a Host header or an Origin URL, without the port or brackets. */
function hostnameOf(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (text === '') return ''
  try {
    return new URL(text.includes('://') ? text : `http://${text}`).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return ''
  }
}

/**
 * Refuse a request that did not come from this machine.
 *
 * These routes change settings and browse the filesystem on a loopback server,
 * so a page on another origin — or a DNS-rebinding page that resolves its own
 * name to 127.0.0.1 — must not drive them. Browsers send `Origin` on a
 * cross-origin POST, and a rebound request carries its own host name, so the two
 * header checks below are enough without adding a token handshake.
 */
function localOnly(req, res) {
  const host = hostnameOf(req.headers?.host)
  if (!LOCAL_HOSTS.has(host)) {
    sendJson(res, 403, { error: 'local requests only' })
    return false
  }
  const origin = req.headers?.origin
  if (origin !== undefined && !LOCAL_HOSTS.has(hostnameOf(origin))) {
    sendJson(res, 403, { error: 'cross-origin requests are refused' })
    return false
  }
  return true
}

/** Status payload shared by every route: effective paths plus loaded stores. */
export async function buildStatus(registry, defaults) {
  const normalizedDefaults = normalizePathList(defaults)
  const { paths: rawPaths, source } = effectivePaths(normalizedDefaults)
  const paths = normalizePathList(rawPaths)
  const problems = []
  for (const path of paths) {
    const info = describePath(path)
    if (!info.ok) problems.push(`${path}: ${info.reason}`)
  }
  // Repointing a shared registry on every status read would trigger a full
  // reload (and fight the loader's queue); only touch it when it actually moved.
  if (registry.signature !== paths.join('|')) registry.setPaths(paths)
  await registry.ensure()
  const stores = registry.kbs.map((kb) => {
    if (kb.loadError) return { dir: kb.dir, error: kb.loadError }
    const stats = kb.stats()
    return {
      kb_id: kb.kbId,
      title: kb.title,
      version: kb.manifest?.version ?? '',
      language: kb.manifest?.language ?? '',
      dir: kb.dir,
      entries: kb.entries.length,
      modules: kb.byModule.size,
      kinds: stats.actual.kinds,
      duplicateRecords: stats.actual.duplicateRecords,
      profile: kb.profile,
      stale: stats.stale,
    }
  })
  return {
    ok: true,
    defaults: normalizedDefaults,
    paths,
    source,
    loadMs: registry.loadMs,
    stores,
    problems,
  }
}

/** Validate that every submitted path exists and resolves to at least one store. */
async function validatePaths(paths) {
  const errors = []
  let discovered = 0
  for (const path of paths) {
    const info = describePath(path)
    if (!info.ok) {
      errors.push(`${path}: ${info.reason}`)
      continue
    }
    const dirs = await discoverKbDirs([path])
    if (dirs.length === 0) {
      errors.push(
        `${path}: no spec-kb store found (a portable store needs manifest.json plus its entries file; ` +
          'a generic store needs a root JSONL file such as entries.jsonl, data.jsonl or records.jsonl)',
      )
      continue
    }
    discovered += dirs.length
  }
  return { errors, discovered }
}

/**
 * Create the route table; the caller registers each entry on its web server.
 *
 * @param {{ registry: object, defaults: string[] }} options
 */
export function createSpecKbRoutes({ registry, defaults }) {
  return [
    {
      path: `${API_PREFIX}/status`,
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET required' })
        if (!localOnly(req, res)) return
        try {
          return sendJson(res, 200, await buildStatus(registry, defaults))
        } catch (error) {
          return sendJson(res, 500, { error: String(error?.message ?? error) })
        }
      },
    },
    {
      path: `${API_PREFIX}/paths`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST required' })
        if (!localOnly(req, res)) return
        try {
          const body = await readJsonBody(req)
          const submitted = Array.isArray(body.paths) ? body.paths : null
          if (submitted === null) return sendJson(res, 400, { error: 'paths must be an array of strings' })
          const paths = normalizePathList(submitted)
          if (paths.length === 0) return sendJson(res, 400, { error: 'at least one path is required; use reset to restore the defaults' })
          const { errors } = await validatePaths(paths)
          if (errors.length > 0) return sendJson(res, 400, { error: 'some paths are invalid', errors })
          writeStoredPaths(paths)
          return sendJson(res, 200, await buildStatus(registry, defaults))
        } catch (error) {
          return sendJson(res, 400, { error: String(error?.message ?? error) })
        }
      },
    },
    {
      path: `${API_PREFIX}/reset`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST required' })
        if (!localOnly(req, res)) return
        try {
          clearStoredPaths()
          return sendJson(res, 200, await buildStatus(registry, defaults))
        } catch (error) {
          return sendJson(res, 500, { error: String(error?.message ?? error) })
        }
      },
    },
    {
      path: `${API_PREFIX}/browse`,
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET required' })
        if (!localOnly(req, res)) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const target = url.searchParams.get('path') ?? ''
        return sendJson(res, 200, browseDirectory(target))
      },
    },
  ]
}
