import { comparePath } from './path'
import { getNode, isText, type ReadableRoot } from './node'
import type { Doc, ElementNode, Node, Path, Point, Range, Selection, TextNode } from './types'

/** What the editable-text helpers need from a `Registry`. */
export interface NodeTypes {
  node(type: string): { atom?: boolean } | undefined
}

/**
 * Unknown (unregistered) elements and atoms are opaque: the renderer shows none of their texts, so
 * no caret or editing command may go inside them (they are kept and moved whole).
 */
export function isOpaque(el: Pick<ElementNode, 'type'>, types: NodeTypes): boolean {
  const registered = types.node(el.type)
  return !registered || registered.atom === true
}

/**
 * The editable texts below `root` (root excluded), with paths relative to it, in document order:
 * every text that is not inside an opaque element. With `range`, only texts whose path is within it.
 * An opaque `root` element has none.
 */
export function* editableTextEntries(root: ReadableRoot, types: NodeTypes, range?: Range): Generator<[TextNode, Path]> {
  const start = root as Doc | ElementNode
  if (start.type !== 'doc' && isOpaque(start, types)) return
  function* walk(nodes: Node[], base: Path): Generator<[TextNode, Path]> {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!
      const path = [...base, i]
      if (isText(n)) {
        if (range && (comparePath(path, range.start.path) < 0 || comparePath(path, range.end.path) > 0)) continue
        yield [n, path]
      } else if (!isOpaque(n, types)) {
        yield* walk(n.children ?? [], path)
      }
    }
  }
  yield* walk(start.children ?? [], [])
}

/** Whether `point` is a valid caret position in an editable text of `doc`. */
export function isEditablePoint(doc: ReadableRoot, types: NodeTypes, point: Point): boolean {
  if (point.path.length === 0 || !Number.isInteger(point.offset) || point.offset < 0) return false
  let node: Node
  try {
    node = getNode(doc, point.path)
  } catch {
    return false
  }
  if (!isText(node) || point.offset > node.text.length) return false
  for (let depth = 1; depth < point.path.length; depth++) {
    if (isOpaque(getNode(doc, point.path.slice(0, depth)) as ElementNode, types)) return false
  }
  return true
}

export function isNodeSelection(sel: Selection | null | undefined): sel is Selection & { node: Path } {
  return !!sel && sel.node !== undefined
}

/** Whether `path` addresses an opaque element (atom or unknown type) of `doc`. */
export function isOpaqueAt(doc: ReadableRoot, types: NodeTypes, path: Path): boolean {
  if (path.length === 0) return false
  let node: Node
  try {
    node = getNode(doc, path)
  } catch {
    return false
  }
  return !isText(node) && isOpaque(node, types)
}

/**
 * A node selection of the opaque element at `path`; its caret is at the end of the last editable
 * text before the element, else the start of the first one after it. Throws when the element is
 * not opaque, or when the doc has no editable text to anchor the caret.
 */
export function nodeSelection(doc: ReadableRoot, types: NodeTypes, path: Path): Selection {
  if (!isOpaqueAt(doc, types, path)) throw new Error(`No opaque element at [${path}]`)
  let point: Point | null = null
  for (const [t, p] of editableTextEntries(doc, types)) {
    const c = comparePath(p, path)
    if (c < 0) point = { path: p, offset: t.text.length }
    else if (c > 0) {
      point ??= { path: p, offset: 0 }
      break
    }
  }
  if (!point) throw new Error(`No editable text to anchor a node selection of [${path}]`)
  return { anchor: point, focus: point, node: [...path] }
}

/** A caret at the start of the first editable text of `doc`, or null when it has none. */
export function firstEditableCaret(doc: ReadableRoot, types: NodeTypes): Selection | null {
  for (const [, path] of editableTextEntries(doc, types)) {
    return { anchor: { path, offset: 0 }, focus: { path, offset: 0 } }
  }
  return null
}
