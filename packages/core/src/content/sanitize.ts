import { coerceDoc, preview, type DropHandler } from '../load'
import { createId } from '../model/id'
import { isElement, isText } from '../model/node'
import type { ElementNode, Mark, Node, TextNode } from '../model/types'
import type { Registry } from '../plugin/registry'
import type { ContentMatch } from '../schema/content-match'
import { inlineWrapping, matchChild, wrapChain } from '../schema/validate'
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
 * Collects what `coerceDoc` drops, to report it as one warning: untrusted content (a paste) can
 * hold any number of malformed nodes, and one warning each would flood the console.
 */
export function dropCollector(): { onDrop: DropHandler; warn: (source: string) => void } {
  let count = 0
  let first = ''
  return {
    onDrop: (what, raw, reason) => {
      if (count++ === 0) first = `${what} (${reason}): ${preview(raw)}`
    },
    warn: (source) => {
      if (count === 0) return
      console.warn(`[penline] Dropped ${count} malformed node(s) or mark(s) from ${source}; the first: ${first}`)
      count = 0
    },
  }
}

/**
 * The children of container `type` (a known non-atom block that is not a textblock), each fixed
 * by `fix`, with every inline run wrapped into the textblock the content expects at its position
 * (a run in a list becomes a list item holding a paragraph; the default block where nothing fits).
 */
function wrapInlineRuns(type: string, children: Node[], registry: Registry, fix: (n: Node) => Node): Node[] {
  let state: ContentMatch | null = registry.contentMatch(type) ?? null
  const out: Node[] = []
  const push = (n: Node) => {
    out.push(n)
    if (state) state = matchChild(state, n, registry) ?? state
  }
  let run: Node[] = []
  const flush = () => {
    if (run.length > 0) push(wrapChain((state && inlineWrapping(state, registry)) ?? [registry.defaultBlock], run))
    run = []
  }
  for (const n of children) {
    if (isBlock(n, registry)) {
      flush()
      push(fix(n))
    } else run.push(n)
  }
  flush()
  return out
}

/**
 * Makes untrusted content safe to insert: `coerceDoc` validates every node's and mark's data
 * (repairing via `onInvalidData` or dropping the node), unknown types and marks are dropped, and
 * the result is either all inline content or all blocks (inline runs beside blocks are wrapped into
 * default blocks). At every depth, inline runs in a container are wrapped into the textblock its
 * content expects there, an empty textblock gets an empty text and an empty container the content
 * its schema requires. What `coerceDoc` drops goes to `onDrop`; without it, one warning sums it all up.
 */
export function sanitizeFragment(raw: unknown[], registry: Registry, onDrop?: DropHandler): Fragment {
  const drops = onDrop ? null : dropCollector()
  const coerced = coerceDoc({ type: 'doc', children: raw }, registry, onDrop ?? drops!.onDrop).children as Node[]
  drops?.warn('inserted content')
  const nodes = dropUnknown(coerced, registry)
  const fix = (n: Node): Node => {
    if (isText(n) || n.children === undefined) return n
    const spec = registry.node(n.type)
    if (!spec || spec.atom || spec.kind !== 'block') return n
    if (registry.isTextblock(n.type)) return n.children.length > 0 ? n : { ...n, children: [{ text: '', marks: [] }] }
    const children = wrapInlineRuns(n.type, n.children, registry, fix)
    return { ...n, children: children.length > 0 ? children : (registry.createAndFill(n.type, n.data)?.children ?? []) }
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
      out.push(fix(n))
    } else run.push(n)
  }
  flush()
  return out
}
