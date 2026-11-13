import { isElement } from '../model/node'
import type { DeepReadonly, Doc, Node, Path } from '../model/types'
import type { Operation } from '../ops/types'
import type { Transaction } from './transaction'

/** Ids of the elements whose content an op of the tr may have changed, with their ancestors. */
const touched = new WeakMap<Transaction, Set<string>>()

/** The transactions with an op that changed the doc's own children (see `recordTouched`). */
const rootTouched = new WeakSet<Transaction>()

/** The touched element ids of `tr` (see `recordTouched`); empty before its first doc op. */
export function touchedElements(tr: Transaction): ReadonlySet<string> {
  return touched.get(tr) ?? new Set()
}

/** Whether an op of `tr` may have changed the doc's own children (an op whose parent path is the doc). */
export function touchedRoot(tr: Transaction): boolean {
  return rootTouched.has(tr)
}

/**
 * Records, before `op` is applied to `doc`, the elements whose children it changes: the parent of
 * its path (both parents for a move, `newPath` being a pre-move path), the elements on the way
 * there, the node itself for an element split or the previous sibling for a merge, and every
 * element of an inserted subtree; and the doc itself when an op's parent path is the doc (`touchedRoot`).
 * Normalization checks content only on these (and everything when the tr has no doc op yet). Ids
 * are enough: an element keeps its id across ops, so the set needs no mapping; a repeated id only
 * causes an extra check.
 */
export function recordTouched(tr: Transaction, doc: DeepReadonly<Doc>, op: Operation): void {
  if (op.type === 'set_selection') return
  let ids = touched.get(tr)
  if (!ids) touched.set(tr, (ids = new Set()))
  const set = ids
  if (op.path.length <= 1 || (op.type === 'move_node' && op.newPath.length <= 1)) rootTouched.add(tr)
  const chain = (path: Path) => {
    let nodes = doc.children as readonly DeepReadonly<Node>[]
    for (const i of path) {
      const n = nodes[i]
      if (!n || !isElement(n)) return
      set.add(n.id)
      nodes = (n.children ?? []) as readonly DeepReadonly<Node>[]
    }
  }
  const subtree = (n: DeepReadonly<Node>) => {
    if (!isElement(n)) return
    set.add(n.id)
    for (const c of n.children ?? []) subtree(c)
  }
  const parent = op.path.slice(0, -1)
  switch (op.type) {
    case 'insert_node':
      chain(parent)
      subtree(op.node)
      return
    case 'move_node':
      chain(parent)
      chain(op.newPath.slice(0, -1))
      return
    case 'split_node': {
      chain(op.path)
      // The right half of an element split: its own id, or the split node's when none is given.
      const id = (op.properties as { id?: unknown }).id
      if (typeof id === 'string') set.add(id)
      return
    }
    case 'merge_node': {
      chain(parent)
      const i = op.path[op.path.length - 1]!
      if (i > 0) chain([...parent, i - 1])
      return
    }
    default:
      chain(parent)
  }
}
