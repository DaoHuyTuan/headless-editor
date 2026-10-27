import { comparePath } from './path'
import type { DeepReadonly, Doc, ElementNode, Json, Mark, Node, Path, Range, TextNode } from './types'

/** A doc or element to read from (e.g. the readonly `editor.state.doc`); readers never mutate it. */
export type ReadableRoot = DeepReadonly<Doc | ElementNode>

export function isText(n: Node): n is TextNode {
  return typeof (n as TextNode).text === 'string'
}

export function isElement(n: Node): n is ElementNode {
  return !isText(n)
}

function childrenOf(n: Doc | Node): Node[] {
  return 'text' in n && typeof n.text === 'string' ? [] : ((n as ElementNode | Doc).children ?? [])
}

export function getNode(root: ReadableRoot, path: Path): Node {
  let cur = root as Doc | Node
  for (const i of path) {
    const next: Node | undefined = childrenOf(cur)[i]
    if (!next) throw new Error(`Invalid path [${path}]`)
    cur = next
  }
  return cur as Node
}

export function getParent(root: ReadableRoot, path: Path): Doc | ElementNode {
  if (path.length === 0) throw new Error('Invalid path []')
  const p = path.length === 1 ? (root as Doc | ElementNode) : getNode(root, path.slice(0, -1))
  if (isText(p as Node)) throw new Error(`Invalid path [${path}]`)
  return p as Doc | ElementNode
}

/** Pre-order traversal of every node below the root (root excluded). */
export function* nodeEntries(root: ReadableRoot): Generator<[Node, Path]> {
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

export function* textEntries(root: ReadableRoot, range?: Range): Generator<[TextNode, Path]> {
  for (const [n, p] of nodeEntries(root)) {
    if (!isText(n)) continue
    if (range && (comparePath(p, range.start.path) < 0 || comparePath(p, range.end.path) > 0)) continue
    yield [n, p]
  }
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
