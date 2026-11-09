import { createId } from './model/id'
import type { Data, Doc, ElementNode, Json, Mark, Node, TextNode } from './model/types'
import type { Registry } from './plugin/registry'
import type { AnyPlugin } from './plugin/types'

type Raw = Record<string, unknown>

function isObject(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Deep copy of a JSON-like value; non-JSON leaves (functions, symbols, undefined) are dropped. */
function cloneJson(value: unknown): Json | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map((v) => cloneJson(v) ?? null)
  if (isObject(value)) {
    const out: Record<string, Json> = {}
    for (const [k, v] of Object.entries(value)) {
      const c = cloneJson(v)
      if (c !== undefined) out[k] = c
    }
    return out
  }
  return undefined
}

function cloneData(value: unknown): Data {
  return isObject(value) ? (cloneJson(value) as Data) : {}
}

function preview(raw: unknown): string {
  try {
    return JSON.stringify(raw)?.slice(0, 200) ?? String(raw)
  } catch {
    return String(raw)
  }
}

function warnDrop(what: string, raw: unknown, reason: string): void {
  console.warn(`[hte] Dropped ${what} while loading content (${reason}): ${preview(raw)}`)
}

/**
 * Validates `data` for a registered node/mark type. Returns the data to use, or null when the
 * value is invalid and the plugin's `onInvalidData` hook is missing, returns null or invalid data, or throws.
 */
function resolveData(registry: Registry, plugin: AnyPlugin, raw: unknown): { data: Data } | { error: string } {
  let message: string
  try {
    const result = registry.validateData(plugin.name, raw)
    if (result.ok) return { data: cloneData(result.data) }
    message = result.message
  } catch (e) {
    message = e instanceof Error ? e.message : String(e)
  }
  try {
    const repaired = plugin.spec.onInvalidData?.(raw)
    // The repair is validated too: a hook returning still-invalid data drops the node.
    if (isObject(repaired)) {
      const result = registry.validateData(plugin.name, repaired)
      if (result.ok) return { data: cloneData(result.data) }
      message = `onInvalidData returned invalid data: ${result.message}`
    }
  } catch {
    // treated like returning null
  }
  return { error: message }
}

function coerceMarks(raw: unknown, registry: Registry, validate: boolean): Mark[] {
  if (!Array.isArray(raw)) return []
  const out: Mark[] = []
  for (const m of raw) {
    if (!isObject(m) || typeof m.type !== 'string') {
      warnDrop('mark', m, 'not a mark')
      continue
    }
    const registered = validate ? registry.mark(m.type) : undefined
    if (!registered) {
      out.push({ type: m.type, data: cloneData(m.data) })
      continue
    }
    const res = resolveData(registry, registered.plugin, m.data)
    if ('error' in res) warnDrop(`"${m.type}" mark`, m, res.error)
    else out.push({ type: m.type, data: res.data })
  }
  return out
}

function coerceChildren(raw: unknown, registry: Registry, validate: boolean, seen: Set<string>): Node[] {
  if (!Array.isArray(raw)) return []
  const out: Node[] = []
  for (const c of raw) {
    const n = coerceNode(c, registry, validate, seen)
    if (n) out.push(n)
  }
  return out
}

/** A fresh id that is not in `seen`. */
function freshId(seen: Set<string>): string {
  let id = createId()
  while (seen.has(id)) id = createId()
  return id
}

/**
 * `validate` is false below unknown elements: their subtree is only made structurally valid.
 * `seen` holds the element ids used so far in the whole doc: a missing or repeated id gets a fresh one.
 */
function coerceNode(raw: unknown, registry: Registry, validate: boolean, seen: Set<string>): Node | null {
  if (!isObject(raw)) {
    warnDrop('node', raw, 'not an object')
    return null
  }
  if (typeof raw.text === 'string') {
    const text: TextNode = { text: raw.text, marks: coerceMarks(raw.marks, registry, validate) }
    return text
  }
  if (typeof raw.type !== 'string' || raw.type === '' || 'text' in raw) {
    warnDrop('node', raw, 'neither a text nor an element')
    return null
  }
  const id = typeof raw.id === 'string' && raw.id !== '' && !seen.has(raw.id) ? raw.id : freshId(seen)
  seen.add(id)
  const registered = validate ? registry.node(raw.type) : undefined

  if (!registered) {
    // Unknown type (or below one): keep everything as given, lossless.
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'id' || k === 'type' || k === 'data' || k === 'children') continue
      const c = cloneJson(v)
      if (c !== undefined) out[k] = c
    }
    const el = { ...out, id, type: raw.type, data: cloneData(raw.data) } as ElementNode
    if (Array.isArray(raw.children)) el.children = coerceChildren(raw.children, registry, false, seen)
    return el
  }

  const res = resolveData(registry, registered.plugin, raw.data)
  if ('error' in res) {
    warnDrop(`"${raw.type}" node`, raw, res.error)
    return null
  }
  const el: ElementNode = { id, type: raw.type, data: res.data }
  if (!registered.atom || Array.isArray(raw.children)) el.children = coerceChildren(raw.children, registry, true, seen)
  return el
}

/**
 * Coerces arbitrary input into a structurally valid `Doc`: fills missing id/data/marks/children,
 * gives repeated element ids a fresh id (the first occurrence keeps its id), validates data (repairing via `onInvalidData` or dropping the node with a warning) and keeps
 * unknown types as given. Never throws and never mutates `raw`. Run `normalize` afterwards.
 */
export function coerceDoc(raw: unknown, registry: Registry): Doc {
  try {
    if (!isObject(raw)) return { type: 'doc', children: [] }
    // Root-level texts/inlines are kept here; `normalize` wraps them into blocks.
    return { type: 'doc', children: coerceChildren(raw.children, registry, true, new Set()) as ElementNode[] }
  } catch {
    return { type: 'doc', children: [] }
  }
}
