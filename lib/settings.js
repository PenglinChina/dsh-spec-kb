/**
 * dsh-spec-kb — user settings for mounted stores.
 *
 * The bundle patch owns the defaults; the Settings page writes a small JSON
 * file under DSH_HOME so a path change applies immediately (no profile patch
 * edit, no restart). The file is optional: without it the bundle defaults win.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { looksLikeStoreSync } from './kb.js'

/** DSH home, matching the host's own lookup (`DSH_HOME` or ~/.dsh). */
export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

export function settingsDir() {
  return join(dshHome(), 'spec-kb')
}

export function settingsFile() {
  return join(settingsDir(), 'settings.json')
}

/** Paths saved from the Settings page, or null when the file is absent/invalid. */
export function readStoredPaths() {
  try {
    const parsed = JSON.parse(readFileSync(settingsFile(), 'utf8'))
    if (!Array.isArray(parsed.paths)) return null
    const paths = parsed.paths.map((item) => String(item ?? '').trim()).filter((item) => item !== '')
    return paths.length > 0 ? paths : null
  } catch {
    return null
  }
}

/** Persist the user's path list; an empty list clears the override. */
export function writeStoredPaths(paths) {
  const list = (Array.isArray(paths) ? paths : []).map((item) => String(item ?? '').trim()).filter((item) => item !== '')
  if (list.length === 0) {
    clearStoredPaths()
    return
  }
  mkdirSync(settingsDir(), { recursive: true })
  writeFileSync(settingsFile(), `${JSON.stringify({ paths: list, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
}

export function clearStoredPaths() {
  rmSync(settingsFile(), { force: true })
}

/** The effective path list: the settings override when present, else the bundle defaults. */
export function effectivePaths(defaults) {
  const stored = readStoredPaths()
  return {
    paths: stored ?? defaults,
    source: stored !== null ? 'settings' : 'bundle',
  }
}

function isStoreDir(dir) {
  // Same probe the loader uses, so the page highlights generic JSONL stores too.
  return looksLikeStoreSync(dir)
}

/**
 * List one directory for the Settings page picker. Directories carry a `store`
 * flag so the page can highlight actual portable-spec-kb stores, and `parent`
 * is null at a filesystem root.
 */
export function browseDirectory(target) {
  const dir = target === undefined || target === null || String(target).trim() === ''
    ? dshHome()
    : resolve(String(target).trim())
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    return { ok: false, path: dir, error: String(error?.message ?? error) }
  }
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, store: isStoreDir(join(dir, entry.name)) }))
    .sort((a, b) => Number(b.store) - Number(a.store) || a.name.localeCompare(b.name))
  const parent = dirname(dir)
  return {
    ok: true,
    path: dir,
    parent: parent === dir ? null : parent,
    isStore: isStoreDir(dir),
    directories,
  }
}

/** Cheap existence/kind check used before accepting a saved path. */
export function describePath(path) {
  const dir = resolve(String(path ?? '').trim())
  try {
    const info = statSync(dir)
    if (!info.isDirectory()) return { path: dir, ok: false, reason: 'not a directory' }
    return { path: dir, ok: true, isStore: isStoreDir(dir) }
  } catch {
    return { path: dir, ok: false, reason: 'does not exist' }
  }
}
