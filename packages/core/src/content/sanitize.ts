import { coerceDoc } from '../load'
import { createId } from '../model/id'
import { isElement, isText } from '../model/node'
import type { ElementNode, Mark, Node, TextNode } from '../model/types'
import type { Registry } from '../plugin/registry'
import type { Fragment } from '../transaction/fragment'

/** Unknown element types count as blocks, like in `insertFragment`. */
export function isBlock(node: Node, registry: Registry): boolean {
  return isElement(node) && registry.node(node.type)?.kind !== 'inline'
}

export function defaultBlock(registry: Registry, children: Node[]): ElementNode {
  return { id: createId(), type: registry.defaultBlock, data: {}, children }
}

/** Drops unknown marks and unknown element types (with their content) from coerced nodes. */
function dropUnknown(nodes: Node[], registry: Registry): Node[] {
  const out: Node[] = []
  for (const node of nodes) {
    if (isText(node)) {
      const marks: Mark[] = node.marks.filter((m) => registry.mark(m.type))
      out.push({ text: node.text, marks } satisfies TextNode)
      continue
    }
    if (!registry.node(node.type)) continue
    const el: ElementNode = { id: node.id, type: node.type, data: node.data }
    if (node.children) el.children = dropUnknown(node.children, registry)
    out.push(el)
  }
  return out
}

/**
 * Makes untrusted content safe to insert: `coerceDoc` validates every node's and mark's data
 * (repairing via `onInvalidData` or dropping the node), unknown types and marks are dropped, and
 * the result is either all inline content or all blocks (inline runs beside blocks are wrapped into
 * default blocks; non-atom blocks without children get an empty text).
 */
export function sanitizeFragment(raw: unknown[], registry: Registry): Fragment {
  const coerced = coerceDoc({ type: 'doc', children: raw }, registry).children as Node[]
  const nodes = dropUnknown(coerced, registry)
  const fixEmpty = (n: Node): Node => {
    if (isText(n) || n.children === undefined || n.children.length > 0) return n
    const spec = registry.node(n.type)
    return spec && !spec.atom && spec.kind === 'block' ? { ...n, children: [{ text: '', marks: [] }] } : n
  }
  if (!nodes.some((n) => isBlock(n, registry))) return nodes
  const out: Node[] = []
  let run: Node[] = []
  const flush = () => {
    if (run.length > 0) out.push(defaultBlock(registry, run))
    run = []
  }
  for (const n of nodes) {
    if (isBlock(n, registry)) {
      flush()
      out.push(fixEmpty(n))
    } else run.push(n)
  }
  flush()
  return out
}
