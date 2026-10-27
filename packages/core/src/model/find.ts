import { isElement, nodeEntries, type ReadableRoot } from './node'
import type { Node, Path } from './types'

/** The path of the element with `id` below `root` (root excluded), or null when there is none. */
export function findPathById(root: ReadableRoot, id: string): Path | null {
  for (const [n, path] of nodeEntries(root)) {
    if (isElement(n as Node) && (n as { id: string }).id === id) return path
  }
  return null
}
