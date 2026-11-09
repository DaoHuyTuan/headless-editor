import { createId } from '../model/id'
import { single } from '../model/selection'
import type { Data, Doc, ElementNode, Mark, Node, Path, Selection, TextNode } from '../model/types'

export function doc(...blocks: ElementNode[]): Doc {
  return { type: 'doc', children: blocks }
}

function isNodeLike(v: unknown): v is Node {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o.text === 'string' || (typeof o.id === 'string' && typeof o.type === 'string')
}

export function el(type: string, ...rest: [Data, ...Node[]] | Node[]): ElementNode {
  let data: Data = {}
  let children: Node[] = rest as Node[]
  if (rest.length > 0 && !isNodeLike(rest[0])) {
    data = rest[0] as Data
    children = rest.slice(1) as Node[]
  }
  return { id: createId(), type, data, children }
}

/** An atom element: no `children`, as loading gives a known atom. */
export function atomEl(type: string, data: Data = {}): ElementNode {
  return { id: createId(), type, data }
}

export function txt(text: string, ...marks: (string | Mark)[]): TextNode {
  return { text, marks: marks.map((m) => (typeof m === 'string' ? { type: m, data: {} } : m)) }
}

export function sel(path: Path, offset: number, focusPath?: Path, focusOffset?: number): Selection {
  return single({
    anchor: { path, offset },
    focus: { path: focusPath ?? path, offset: focusOffset ?? offset },
  })
}

/** Deep copy of `value` with every element `id` removed (for structural comparisons in tests). */
export function stripIds(value: Doc | Node | Node[]): unknown {
  return strip(value)
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip)
  if (typeof value !== 'object' || value === null) return value
  const src = value as Record<string, unknown>
  const isTextNode = typeof src.text === 'string'
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(src)) {
    if (k === 'id' && !isTextNode) continue
    out[k] = k === 'children' ? strip(v) : clone(v)
  }
  return out
}

function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clone)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]))
}
