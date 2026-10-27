import { nextPath, previousPath } from '../model/path'
import type { Path } from '../model/types'
import type { Operation } from './types'

function samePrefix(a: Path, b: Path, len: number): boolean {
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) return false
  return true
}

/** Final location of a node moved from `path` to `newPath` (given in pre-move coordinates). */
export function movedPath(path: Path, newPath: Path): Path {
  const k = path.length - 1
  const out = [...newPath]
  if (path.length < newPath.length && samePrefix(path, newPath, k) && path[k]! < newPath[k]!) out[k]!--
  return out
}

/** Inverse of `movedPath`: the pre-move `newPath` for a move from `from` that lands at `target`. */
function unmovedPath(from: Path, target: Path): Path {
  const k = from.length - 1
  const out = [...target]
  if (from.length < target.length && samePrefix(from, target, k) && from[k]! <= target[k]!) out[k]!++
  return out
}

export function invertOp(op: Operation): Operation {
  switch (op.type) {
    case 'insert_text':
      return { ...op, type: 'remove_text' }
    case 'remove_text':
      return { ...op, type: 'insert_text' }
    case 'insert_node':
      return { ...op, type: 'remove_node' }
    case 'remove_node':
      return { ...op, type: 'insert_node' }
    case 'split_node':
      return { type: 'merge_node', path: nextPath(op.path), position: op.position, properties: op.properties }
    case 'merge_node':
      return { type: 'split_node', path: previousPath(op.path), position: op.position, properties: op.properties }
    case 'move_node': {
      const at = movedPath(op.path, op.newPath)
      return { type: 'move_node', path: at, newPath: unmovedPath(at, op.path) }
    }
    case 'set_node_data':
      return { ...op, data: op.prevData, prevData: op.data }
    case 'add_mark':
      return { ...op, type: 'remove_mark' }
    case 'remove_mark':
      return { ...op, type: 'add_mark' }
    case 'set_selection':
      return { ...op, selection: op.prevSelection, prevSelection: op.selection }
  }
}
