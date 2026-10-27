import { createId } from './model/id'
import { getNode, isElement, isText, nodeEntries, sameMarkSet } from './model/node'
import type { ElementNode, Mark, Node, Path, TextNode } from './model/types'
import { transformPath } from './ops/transform'
import type { Registry } from './plugin/registry'
import type { AnyPlugin, PluginContext } from './plugin/types'
import type { Transaction } from './transaction/transaction'

const MAX_PASSES = 100
const MAX_CORE_FIXES_PER_PASS = 1_000_000

/**
 * Normalizes `tr.doc` in place by appending operations to `tr`: core rules first, then every
 * plugin's `normalize` hook on every node entry. Passes repeat until one adds no operations.
 */
export function normalize(tr: Transaction, getContext: (plugin: AnyPlugin) => PluginContext<any, any>): void {
  for (let pass = 0; ; pass++) {
    if (pass >= MAX_PASSES) throw new Error('Normalization did not converge')
    const before = tr.ops.length
    // Core rules always converge (each fix shrinks the work left); the cap is only a safety net.
    for (let fixes = 0; fixOne(tr); fixes++) {
      if (fixes >= MAX_CORE_FIXES_PER_PASS) throw new Error('Normalization did not converge')
    }
    runPluginHooks(tr, getContext)
    if (tr.ops.length === before) return
  }
}

function runPluginHooks(tr: Transaction, getContext: (plugin: AnyPlugin) => PluginContext<any, any>): void {
  const plugins = tr.registry.plugins.filter((p) => p.spec.normalize)
  if (plugins.length === 0) return
  // Snapshot entry paths and map them through every op a hook adds, so they stay valid.
  const paths: (Path | null)[] = [...nodeEntries(tr.doc)].map(([, p]) => p)
  for (let i = 0; i < paths.length; i++) {
    for (const plugin of plugins) {
      const path = paths[i]
      if (!path) break
      const start = tr.ops.length
      plugin.spec.normalize!([getNode(tr.doc, path), path], tr, getContext(plugin))
      for (let o = start; o < tr.ops.length; o++) {
        for (let j = i; j < paths.length; j++) {
          const pj = paths[j]
          if (pj) paths[j] = transformPath(pj, tr.ops[o]!)
        }
      }
    }
  }
}

/** Applies the first core-rule fix found. Returns false when the doc is normal. */
function fixOne(tr: Transaction): boolean {
  const { registry } = tr
  const root = tr.doc.children as Node[]

  // Rule 1: the doc is never empty.
  if (root.length === 0) {
    tr.insertNode([0], emptyBlock(registry))
    return true
  }

  // Rule 2: texts and inline elements at the root are wrapped into a default block.
  for (let i = 0; i < root.length; i++) {
    if (!isInlineContent(root[i]!, registry)) continue
    let end = i
    while (end + 1 < root.length && isInlineContent(root[end + 1]!, registry)) end++
    tr.insertNode([i], { id: createId(), type: registry.defaultBlock, data: {}, children: [] })
    for (let k = 0; k <= end - i; k++) tr.apply({ type: 'move_node', path: [i + 1], newPath: [i, k] })
    return true
  }

  for (let i = 0; i < root.length; i++) {
    const n = root[i]!
    if (isElement(n) && fixElement(tr, n, [i])) return true
  }
  return false
}

function fixElement(tr: Transaction, node: ElementNode, path: Path): boolean {
  const { registry } = tr
  const spec = registry.node(node.type)
  // Rule 7: unknown types are left untouched, including their children.
  if (!spec || spec.atom) return false
  const children = node.children ?? []

  // Rule 5: a non-atom block with no children gets an empty text.
  if (children.length === 0) {
    if (spec.kind !== 'block') return false
    tr.insertNode([...path, 0], { text: '', marks: [] })
    return true
  }

  // Rule 8: a `content: 'text'` block holds only unmarked text.
  if (spec.content === 'text') {
    for (let i = 0; i < children.length; i++) {
      const c = children[i]!
      if (isText(c)) {
        if (c.marks.length === 0) continue
        for (const m of [...c.marks].reverse()) tr.apply({ type: 'remove_mark', path: [...path, i], mark: m })
        return true
      }
      if (registry.node(c.type)?.kind !== 'inline') continue
      // Unwrap the inline element: move its children out before it, then remove it.
      const kids = c.children ?? []
      for (let k = 0; k < kids.length; k++) {
        tr.apply({ type: 'move_node', path: [...path, i + k, 0], newPath: [...path, i + k] })
      }
      tr.removeNode([...path, i + kids.length])
      return true
    }
  }

  for (let i = 0; i < children.length; i++) {
    const c = children[i]!
    if (!isText(c)) continue
    // Rule 3: merge adjacent texts with the same mark set.
    const prev = children[i - 1]
    if (prev && isText(prev) && sameMarkSet(prev.marks, c.marks)) {
      tr.apply({ type: 'merge_node', path: [...path, i], position: prev.text.length, properties: { marks: c.marks } })
      return true
    }
    // Rule 4: drop empty texts when the element has other children.
    if (c.text === '' && children.length > 1) {
      tr.removeNode([...path, i])
      return true
    }
    // Rule 6: marks are sorted by rank (duplicate types keep the first).
    if (fixMarks(tr, c, [...path, i])) return true
  }

  for (let i = 0; i < children.length; i++) {
    const c = children[i]!
    if (isElement(c) && fixElement(tr, c, [...path, i])) return true
  }
  return false
}

function fixMarks(tr: Transaction, text: TextNode, path: Path): boolean {
  const target: Mark[] = []
  for (const m of text.marks) if (!target.some((t) => t.type === m.type)) target.push(m)
  target.sort((a, b) => tr.registry.markRank(a.type) - tr.registry.markRank(b.type))
  if (target.length === text.marks.length && target.every((m, i) => m === text.marks[i])) return false
  // Remove last-to-first so that undo (which appends) restores the original order.
  for (const m of [...text.marks].reverse()) tr.apply({ type: 'remove_mark', path, mark: m })
  for (const m of target) tr.apply({ type: 'add_mark', path, mark: m })
  return true
}

function isInlineContent(n: Node, registry: Registry): boolean {
  return isText(n) || registry.node(n.type)?.kind === 'inline'
}

function emptyBlock(registry: Registry): ElementNode {
  return { id: createId(), type: registry.defaultBlock, data: {}, children: [{ text: '', marks: [] }] }
}
