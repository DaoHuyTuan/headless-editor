import { comparePath } from './path'
import { createSelection, isNodeRange, mainRange, single } from './selection'
import { getNode, isText, type ReadableRoot } from './node'
import type { Doc, ElementNode, Node, Path, Point, Range, Selection, SelectionRange, TextNode } from './types'

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

/** Whether `sel` is a node selection: its single range is a node range. */
export function isNodeSelection(sel: Selection | null | undefined): boolean {
  return !!sel && isNodeRange(mainRange(sel))
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
  return single({ anchor: point, focus: point, node: [...path] })
}

/**
 * The editable point nearest to `path` in document order: the end of the last editable text before
 * it, else the start of the first one at or after it (a text that now sits at `path`, after a node
 * there was removed, counts as after). Null when `doc` has no editable text. The rule that
 * `nodeSelection` and normalize's empty-text cleanup use, over the whole doc.
 */
export function nearestEditablePoint(doc: ReadableRoot, types: NodeTypes, path: Path): Point | null {
  let point: Point | null = null
  for (const [t, p] of editableTextEntries(doc, types)) {
    if (comparePath(p, path) < 0) point = { path: p, offset: t.text.length }
    else return point ?? { path: p, offset: 0 }
  }
  return point
}

/** Whether both points of `range` are editable and its `node`, if any, is an opaque element. */
export function isEditableRange(doc: ReadableRoot, types: NodeTypes, range: SelectionRange): boolean {
  return (
    isEditablePoint(doc, types, range.anchor) &&
    isEditablePoint(doc, types, range.focus) &&
    (!range.node || isOpaqueAt(doc, types, range.node))
  )
}

/**
 * `sel` with every range that is not at an editable point moved there: each bad point goes to
 * `nearestEditablePoint`, and a `node` that is not an opaque element is dropped. A range is dropped
 * only when the doc has no editable point; null when every range is. Normalized (moved ranges may
 * merge, `main` follows its range); `sel` itself when every range is already valid.
 */
export function rehomeRanges(doc: ReadableRoot, types: NodeTypes, sel: Selection): Selection | null {
  if (sel.ranges.every((r) => isEditableRange(doc, types, r))) return sel
  const out: SelectionRange[] = []
  let main = 0
  sel.ranges.forEach((range, i) => {
    const fix = (pt: Point) => (isEditablePoint(doc, types, pt) ? pt : nearestEditablePoint(doc, types, pt.path))
    const anchor = fix(range.anchor)
    const focus = fix(range.focus)
    if (!anchor || !focus) return
    const moved: SelectionRange = { anchor, focus }
    if (range.node && isOpaqueAt(doc, types, range.node)) moved.node = range.node
    if (i <= sel.main) main = out.length
    out.push(moved)
  })
  return out.length === 0 ? null : createSelection(out, main)
}

/** A caret at the start of the first editable text of `doc`, or null when it has none. */
export function firstEditableCaret(doc: ReadableRoot, types: NodeTypes): Selection | null {
  for (const [, path] of editableTextEntries(doc, types)) {
    return single({ anchor: { path, offset: 0 }, focus: { path, offset: 0 } })
  }
  return null
}
