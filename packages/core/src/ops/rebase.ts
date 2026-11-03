import { isAncestorPath } from '../model/path'
import type { Path, Selection } from '../model/types'
import { transformPath, transformSelection } from './transform'
import type { Operation } from './types'

/**
 * Operational transform for history rebasing, deliberately conservative: every pair it can't prove
 * independent (or resolve exactly, for text ranges in one text node) gives `null`. A wrong rebase
 * corrupts docs; a `null` only costs undo depth.
 *
 * Pairs resolved:
 * - any op vs `set_selection` (the selection op maps its selections; the other op is unchanged);
 * - two text ops on the same text node: offsets shift, `null` on overlapping ranges and on
 *   two inserts at the same offset (ambiguous order);
 * - a mark op and a text op on the same text node commute;
 * - otherwise, ops whose footprints don't overlap: paths map through `transformPath`.
 *
 * `null` for: `move_node` with anything but `set_selection`; two data ops on one element; two mark
 * ops on one text node; two `insert_node` at the same path; an `insert_node` between the two nodes of
 * a `merge_node`; and any op inside (or a data/mark/text change of) a node the other side removes,
 * splits or merges, since that would change its payload or its `position`.
 */

function pathEq(a: Path, b: Path): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function ancestorOrEqual(a: Path, b: Path): boolean {
  return pathEq(a, b) || isAncestorPath(a, b)
}

function prev(p: Path): Path {
  return [...p.slice(0, -1), p[p.length - 1]! - 1]
}

/**
 * `touched`: paths whose node the op reads or changes; `subtree`: paths whose whole subtree the op
 * depends on (payload, length or child count). Two ops conflict when a subtree path of one is an
 * ancestor of (or equals) a touched path of the other.
 */
function footprint(op: Operation): { touched: Path[]; subtree: Path[] } {
  switch (op.type) {
    case 'insert_text':
    case 'remove_text':
    case 'remove_node':
    case 'split_node':
      return { touched: [op.path], subtree: [op.path] }
    case 'merge_node':
      return { touched: [prev(op.path), op.path], subtree: [prev(op.path), op.path] }
    case 'insert_node':
      // Changes only its parent's child list (the new node is not in the shared doc).
      return { touched: [op.path.slice(0, -1)], subtree: [] }
    case 'set_node_data':
    case 'add_mark':
    case 'remove_mark':
      return { touched: [op.path], subtree: [] }
    case 'move_node':
    case 'set_selection':
      return { touched: [], subtree: [] }
  }
}

function overlaps(a: Operation, b: Operation): boolean {
  const fa = footprint(a)
  const fb = footprint(b)
  return (
    fa.subtree.some((s) => fb.touched.some((t) => ancestorOrEqual(s, t))) ||
    fb.subtree.some((s) => fa.touched.some((t) => ancestorOrEqual(s, t)))
  )
}

type TextOp = Extract<Operation, { type: 'insert_text' | 'remove_text' }>
type MarkOp = Extract<Operation, { type: 'add_mark' | 'remove_mark' }>

const isTextOp = (op: Operation): op is TextOp => op.type === 'insert_text' || op.type === 'remove_text'
const isMarkOp = (op: Operation): op is MarkOp => op.type === 'add_mark' || op.type === 'remove_mark'

/** `a` after `b`, both text ops on the same text node. */
function transformText(a: TextOp, b: TextOp): TextOp | null {
  const bLen = b.text.length
  const aEnd = a.offset + a.text.length
  const bEnd = b.offset + bLen
  if (a.type === 'insert_text') {
    if (b.type === 'insert_text') {
      if (b.offset === a.offset) return null
      return b.offset < a.offset ? { ...a, offset: a.offset + bLen } : a
    }
    if (a.offset <= b.offset) return a
    if (a.offset >= bEnd) return { ...a, offset: a.offset - bLen }
    return null // inside the removed range
  }
  if (b.type === 'insert_text') {
    if (b.offset <= a.offset) return { ...a, offset: a.offset + bLen }
    if (b.offset >= aEnd) return a
    return null // inserted inside the range `a` removes: its payload is stale
  }
  if (b.offset < aEnd && a.offset < bEnd) return null
  return bEnd <= a.offset ? { ...a, offset: a.offset - bLen } : a
}

function mapSelection(sel: Selection | null, op: Operation): Selection | null | undefined {
  if (sel === null) return null
  return transformSelection(sel, op) ?? undefined
}

/** `a` rewritten to apply after `b`, where both apply to the same doc; `null` when not covered. */
export function transformOp(a: Operation, b: Operation): Operation | null {
  if (b.type === 'set_selection') return a
  if (a.type === 'set_selection') {
    const selection = mapSelection(a.selection, b)
    const prevSelection = mapSelection(a.prevSelection, b)
    if (selection === undefined || prevSelection === undefined) return null
    return { ...a, selection, prevSelection }
  }
  if (a.type === 'move_node' || b.type === 'move_node') return null

  const samePath = 'path' in b && pathEq(a.path, b.path)
  if (samePath) {
    if (isTextOp(a) && isTextOp(b)) return transformText(a, b)
    if ((isTextOp(a) && isMarkOp(b)) || (isMarkOp(a) && isTextOp(b))) return a
    if (isMarkOp(a) && isMarkOp(b)) return null
    if (a.type === 'set_node_data' && b.type === 'set_node_data') return null
    if (a.type === 'insert_node' && b.type === 'insert_node') return null
    if ((a.type === 'insert_node' && b.type === 'merge_node') || (a.type === 'merge_node' && b.type === 'insert_node'))
      return null
  }
  if (overlaps(a, b)) return null

  const path = transformPath(a.path, b)
  if (!path) return null
  return pathEq(path, a.path) ? a : { ...a, path }
}

/**
 * Rebases `ops` over `over`, two op sequences that both start from the same doc: returns `ops`
 * rewritten to apply after `over`, and `over` rewritten to apply after `ops`. `null` when any pair
 * is not covered (see the module comment).
 */
export function rebaseBoth(ops: Operation[], over: Operation[]): { ops: Operation[]; over: Operation[] } | null {
  const out: Operation[] = []
  let rest = over
  for (const op of ops) {
    let a = op
    const next: Operation[] = []
    for (const b of rest) {
      const a2 = transformOp(a, b)
      const b2 = transformOp(b, a)
      if (!a2 || !b2) return null
      next.push(b2)
      a = a2
    }
    out.push(a)
    rest = next
  }
  return { ops: out, over: rest }
}

/**
 * `ops` rewritten (paths and offsets) to apply after `over`, where both start from the same doc
 * (in history: an entry's undo ops, or a redo entry's ops, and the outside-history ops that just ran).
 * `null` when an op touches a node or text range `over` removed or changed, or for any pair not covered.
 */
export function rebaseOps(ops: Operation[], over: Operation[]): Operation[] | null {
  return rebaseBoth(ops, over)?.ops ?? null
}
