import { isAncestorPath } from '../model/path'
import { createSelection } from '../model/selection'
import type { Path, Point, Selection, SelectionRange } from '../model/types'
import { movedPath } from './invert'
import type { Operation } from './types'

export type Affinity = 'forward' | 'backward'

function samePrefix(a: Path, b: Path, len: number): boolean {
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) return false
  return true
}

function pathEq(a: Path, b: Path): boolean {
  return a.length === b.length && samePrefix(a, b, a.length)
}

/** True when `path` is `op` itself or lives at/after `op` among its siblings (or below such a sibling). */
function atOrAfterSibling(opPath: Path, path: Path): boolean {
  const k = opPath.length - 1
  return k >= 0 && path.length > k && samePrefix(opPath, path, k) && path[k]! >= opPath[k]!
}

function shift(path: Path, index: number, by: number): Path {
  const out = [...path]
  out[index] = out[index]! + by
  return out
}

function insertAdjust(path: Path, at: Path): Path {
  return atOrAfterSibling(at, path) ? shift(path, at.length - 1, 1) : path
}

function removeAdjust(path: Path, at: Path): Path | null {
  const k = at.length - 1
  if (k < 0 || path.length <= k || !samePrefix(at, path, k)) return path
  if (path[k]! === at[k]!) return null
  return path[k]! > at[k]! ? shift(path, k, -1) : path
}

function transformPathAffinity(path: Path, op: Operation, affinity: Affinity): Path | null {
  switch (op.type) {
    case 'insert_node':
      return insertAdjust(path, op.path)
    case 'remove_node':
      return removeAdjust(path, op.path)
    case 'split_node': {
      const k = op.path.length - 1
      if (pathEq(op.path, path)) return affinity === 'forward' ? shift(path, k, 1) : path
      if (isAncestorPath(op.path, path)) {
        // Children at or after `position` move into the new right-hand sibling.
        if (path[k + 1]! >= op.position) {
          const out = shift(path, k, 1)
          out[k + 1] = path[k + 1]! - op.position
          return out
        }
        return path
      }
      return insertAdjust(path, [...op.path.slice(0, -1), op.path[k]! + 1])
    }
    case 'merge_node': {
      const k = op.path.length - 1
      if (pathEq(op.path, path)) return shift(path, k, -1)
      if (isAncestorPath(op.path, path)) {
        const out = shift(path, k, -1)
        out[k + 1] = path[k + 1]! + op.position
        return out
      }
      if (atOrAfterSibling(op.path, path)) return shift(path, k, -1)
      return path
    }
    case 'move_node': {
      const target = movedPath(op.path, op.newPath)
      if (pathEq(op.path, path) || isAncestorPath(op.path, path)) return [...target, ...path.slice(op.path.length)]
      // Mirror applyOp: remove at op.path, then insert at the post-removal `target`.
      const removed = removeAdjust(path, op.path)
      return removed && insertAdjust(removed, target)
    }
    case 'insert_text':
    case 'remove_text':
    case 'set_node_data':
    case 'add_mark':
    case 'remove_mark':
    case 'set_selection':
      return path
  }
}

/** Where the node at `path` ends up after `op`; null when it was removed. A split node's path keeps addressing its left half. */
export function transformPath(path: Path, op: Operation): Path | null {
  return transformPathAffinity(path, op, 'backward')
}

/** Where `point` ends up after `op`; null when the text node it was in was removed. */
export function transformPoint(point: Point, op: Operation, affinity: Affinity = 'forward'): Point | null {
  const { path, offset } = point
  switch (op.type) {
    case 'insert_text':
      if (pathEq(op.path, path) && (op.offset < offset || (op.offset === offset && affinity === 'forward')))
        return { path, offset: offset + op.text.length }
      return point
    case 'remove_text':
      if (pathEq(op.path, path) && offset > op.offset)
        return { path, offset: Math.max(op.offset, offset - op.text.length) }
      return point
    case 'split_node':
      // A point's path addresses a text node, so a split of that exact path is a text split.
      if (pathEq(op.path, path)) {
        if (offset > op.position || (offset === op.position && affinity === 'forward'))
          return { path: shift(path, path.length - 1, 1), offset: offset - op.position }
        return point
      }
      break
    case 'merge_node':
      if (pathEq(op.path, path)) return { path: shift(path, path.length - 1, -1), offset: offset + op.position }
      break
    default:
      break
  }
  const next = transformPathAffinity(path, op, affinity)
  return next && { path: next, offset }
}

/** One range mapped through `op`; null when one of its points can't be (its text node was removed). */
export function transformRange(range: SelectionRange, op: Operation, affinity: Affinity = 'forward'): SelectionRange | null {
  const anchor = transformPoint(range.anchor, op, affinity)
  const focus = transformPoint(range.focus, op, affinity)
  if (!anchor || !focus) return null
  const out: SelectionRange = { anchor, focus }
  // A removed selected node drops `node`: the mapped caret remains.
  const node = range.node && transformPath(range.node, op)
  if (node) out.node = node
  return out
}

/**
 * `sel` with every range mapped through `op` on its own, then normalized (`createSelection`): ranges
 * that collide are merged and `main` follows its range. A range that can't be mapped is dropped (if it
 * was the main one, `main` moves to the closest surviving range before it, else the first one); null
 * only when every range is gone. It only maps and drops: live-edit re-homing lives in
 * `Transaction.mapSelection` (used by `Transaction.apply`). History and rebase use `transformSelectionStrict`.
 */
export function transformSelection(sel: Selection, op: Operation, affinity: Affinity = 'forward'): Selection | null {
  const out: SelectionRange[] = []
  let main = 0
  sel.ranges.forEach((range, i) => {
    const mapped = transformRange(range, op, affinity)
    if (!mapped) return
    if (i <= sel.main) main = out.length
    out.push(mapped)
  })
  return out.length === 0 ? null : createSelection(out, main)
}

/**
 * `sel` with every range mapped through `op`, normalized; null as soon as **any** range can't be
 * mapped. History and rebase use it: an entry must restore an exact selection, so one lost range
 * drops the entry (spec §5.7). With one range it equals `transformSelection`.
 */
export function transformSelectionStrict(sel: Selection, op: Operation, affinity: Affinity = 'forward'): Selection | null {
  const out: SelectionRange[] = []
  for (const range of sel.ranges) {
    const mapped = transformRange(range, op, affinity)
    if (!mapped) return null
    out.push(mapped)
  }
  return createSelection(out, sel.main)
}
