import { comparePath } from './path'
import type { DeepReadonly, Doc, ElementNode, Json, Mark, Node, Path, Range, TextNode } from './types'

/** A doc or element to read from (e.g. the readonly `editor.state.doc`); readers never mutate it. */
export type ReadableRoot = DeepReadonly<Doc | ElementNode>

/** Whether `n` is a text node; narrows read-only (`DeepReadonly<Node>`) and mutable nodes alike. */
export function isText<N extends Node | DeepReadonly<Node>>(n: N): n is Extract<N, { text: string }> {
  return typeof (n as { text?: unknown }).text === 'string'
}

/** Whether `n` is an element; narrows read-only (`DeepReadonly<Node>`) and mutable nodes alike. */
export function isElement<N extends Node | DeepReadonly<Node>>(n: N): n is Exclude<N, { text: string }> {
  return !isText(n)
}

function childrenOf(n: Doc | Node): Node[] {
  return 'text' in n && typeof n.text === 'string' ? [] : ((n as ElementNode | Doc).children ?? [])
}

/** The node at `path` below `root`, read-only: the doc is never mutated (edit it through a transaction). */
export function getNode(root: ReadableRoot, path: Path): DeepReadonly<Node> {
  let cur = root as Doc | Node
  for (const i of path) {
    const next: Node | undefined = childrenOf(cur)[i]
    if (!next) throw new Error(`Invalid path [${path}]`)
    cur = next
  }
  return cur as DeepReadonly<Node>
}

/** The parent of the node at `path`, read-only. */
export function getParent(root: ReadableRoot, path: Path): DeepReadonly<Doc | ElementNode> {
  if (path.length === 0) throw new Error('Invalid path []')
  const p = path.length === 1 ? (root as Doc | ElementNode) : (getNode(root, path.slice(0, -1)) as Node)
  if (isText(p as Node)) throw new Error(`Invalid path [${path}]`)
  return p as DeepReadonly<Doc | ElementNode>
}

/** Pre-order traversal of every node below the root (root excluded), read-only. */
export function* nodeEntries(root: ReadableRoot): Generator<[DeepReadonly<Node>, Path]> {
  function* walk(parent: Doc | Node, base: Path): Generator<[Node, Path]> {
    const kids = childrenOf(parent)
    for (let i = 0; i < kids.length; i++) {
      const path = [...base, i]
      yield [kids[i]!, path]
      yield* walk(kids[i]!, path)
    }
  }
  yield* walk(root as Doc | ElementNode, [])
}

/** Every text node below the root (with `range`: only those whose path is within it), read-only. */
export function* textEntries(root: ReadableRoot, range?: Range): Generator<[DeepReadonly<TextNode>, Path]> {
  for (const [n, p] of nodeEntries(root)) {
    if (!isText(n)) continue
    if (range && (comparePath(p, range.start.path) < 0 || comparePath(p, range.end.path) > 0)) continue
    yield [n, p]
  }
}

/** A deep copy of a JSON value: data that enters the doc never aliases a caller's (or another node's) object. */
export function cloneJson<T extends Json>(value: T): T {
  if (typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) {
    const out = new Array(value.length)
    for (let i = 0; i < value.length; i++) out[i] = cloneJson(value[i]!)
    return out as T
  }
  // Plain loops: this runs over every node of the doc in `getJSON`.
  const out: Record<string, Json> = {}
  for (const k of Object.keys(value)) out[k] = cloneJson((value as Record<string, Json>)[k]!)
  return out as T
}

export function deepEqualJson(a: Json, b: Json): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqualJson(v, b[i]!))
  }
  const ao = a as { [k: string]: Json }
  const bo = b as { [k: string]: Json }
  const ak = Object.keys(ao)
  if (ak.length !== Object.keys(bo).length) return false
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqualJson(ao[k]!, bo[k]!))
}

/** Order-insensitive equality of two mark lists (type + deep data). */
export function sameMarkSet(a: Mark[], b: Mark[]): boolean {
  if (a.length !== b.length) return false
  const used = new Set<number>()
  return a.every((m) => {
    const j = b.findIndex((o, i) => !used.has(i) && o.type === m.type && deepEqualJson(o.data, m.data))
    if (j < 0) return false
    used.add(j)
    return true
  })
}
