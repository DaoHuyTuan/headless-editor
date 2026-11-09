import { nodeText, type OptionsLookup } from './content/text'
import { isOpaque } from './model/editable'
import { createId } from './model/id'
import { getNode, isElement, isText, nodeEntries, sameMarkSet } from './model/node'
import { nextPath } from './model/path'
import { createSelection } from './model/selection'
import type { ElementNode, Mark, Node, Path, Point, TextNode } from './model/types'
import { transformPath } from './ops/transform'
import type { Registry } from './plugin/registry'
import type { AnyPlugin, PluginContext } from './plugin/types'
import { splitBlockAt } from './transaction/text'
import type { Transaction } from './transaction/transaction'

const MAX_PASSES = 100
const MAX_CORE_FIXES_PER_PASS = 1_000_000

/**
 * Normalizes `tr.doc` in place by appending operations to `tr`: core rules first, then every
 * plugin's `normalize` hook on every node entry. Passes repeat until one adds no operations.
 */
export function normalize(tr: Transaction, getContext: (plugin: AnyPlugin) => PluginContext<any, any>): void {
  const options: OptionsLookup = (plugin) => getContext(plugin).options
  for (let pass = 0; ; pass++) {
    if (pass >= MAX_PASSES) throw new Error('Normalization did not converge')
    const before = tr.ops.length
    // Core rules always converge (each fix shrinks the work left); the cap is only a safety net.
    for (let fixes = 0; fixOne(tr, options); fixes++) {
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
function fixOne(tr: Transaction, options: OptionsLookup): boolean {
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
    if (isElement(n) && fixElement(tr, n, [i], options)) return true
  }
  return false
}

function fixElement(tr: Transaction, node: ElementNode, path: Path, options: OptionsLookup): boolean {
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

  // Rule 9: a block holding inline content (or text) has no block children: a nested block is
  // unwrapped (its children are lifted into this block at its position). Repeated passes handle
  // deeper nesting. Unknown types are not blocks here (rule 7 leaves them alone). An atom block
  // has no editable children to lift, so it is hoisted out whole instead (see `hoist`).
  if (spec.kind === 'block' && (spec.content === 'inline' || spec.content === 'text')) {
    for (let i = 0; i < children.length; i++) {
      const c = children[i]!
      if (isText(c)) continue
      const childSpec = registry.node(c.type)
      if (childSpec?.kind !== 'block') continue
      if (childSpec.atom) hoist(tr, node, path, i)
      else unwrap(tr, c, [...path, i])
      return true
    }
  }

  // Rule 8: a `content: 'text'` block holds only unmarked text. Inline elements are unwrapped, except
  // an inline atom with `renderText`, which becomes that text (so a mention keeps its `@label`).
  if (spec.content === 'text') {
    for (let i = 0; i < children.length; i++) {
      const c = children[i]!
      if (isText(c)) {
        if (c.marks.length === 0) continue
        for (const m of [...c.marks].reverse()) tr.apply({ type: 'remove_mark', path: [...path, i], mark: m })
        return true
      }
      const childSpec = registry.node(c.type)
      if (childSpec?.kind !== 'inline') continue
      if (childSpec.atom && childSpec.plugin.spec.renderText) {
        tr.insertNode([...path, i], { text: nodeText(c, registry, options), marks: [] })
        tr.removeNode([...path, i + 1])
      } else unwrap(tr, c, [...path, i])
      return true
    }
  }

  // Rule 11: `\n` is a line break only in `content: 'text'` blocks (HTML collapses it elsewhere, so it
  // would not round-trip). A `content: 'inline'` block holding one (e.g. joined with a code block's
  // text by Backspace, a range delete or a paste) is split there into a block of its type with a fresh
  // id, and the `\n` removed. Every `\n` of the block is split in this one fix (see `splitAtNewlines`),
  // so a many-line text costs one fix, not one restart from the root per line.
  if (spec.kind === 'block' && spec.content === 'inline') {
    const at = newlines(node, path, registry)
    if (at.length > 0) {
      splitAtNewlines(tr, node, path, at)
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
    // Rule 4: drop empty texts when the element has other children, except one that rule 10 needs
    // (beside an inline element, with no other text on that side).
    // Merging into a previous text keeps a caret inside it valid (it maps to the end of `prev`).
    if (c.text === '' && children.length > 1 && !neededByRule10(children, i, registry)) {
      if (prev && isText(prev)) {
        tr.apply({ type: 'merge_node', path: [...path, i], position: prev.text.length, properties: { marks: c.marks } })
      } else {
        rehomeSelection(tr, children, path, i)
        tr.removeNode([...path, i])
      }
      return true
    }
    // Rule 6: marks are sorted by rank (duplicate types keep the first).
    if (fixMarks(tr, c, [...path, i])) return true
  }

  // Rule 10: in inline content, every inline element has a text sibling on each side (an empty one
  // is added where needed), so a caret can always sit right before and right after it.
  if (holdsInline(spec)) {
    for (let i = 0; i < children.length; i++) {
      if (!isInlineElement(children[i]!, registry)) continue
      const prev = children[i - 1]
      const next = children[i + 1]
      if (!prev || !isText(prev)) {
        tr.insertNode([...path, i], { text: '', marks: [] })
        return true
      }
      if (!next || !isText(next)) {
        tr.insertNode([...path, i + 1], { text: '', marks: [] })
        return true
      }
    }
  }

  for (let i = 0; i < children.length; i++) {
    const c = children[i]!
    if (isElement(c) && fixElement(tr, c, [...path, i], options)) return true
  }
  return false
}

/** Every `\n` in the editable texts of `node`, in document order (inside non-atom inline elements too, not in opaque ones). */
function newlines(node: ElementNode, path: Path, registry: Registry, out: Point[] = []): Point[] {
  const kids = node.children ?? []
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i]!
    if (isText(c)) {
      for (let offset = c.text.indexOf('\n'); offset !== -1; offset = c.text.indexOf('\n', offset + 1)) {
        out.push({ path: [...path, i], offset })
      }
    } else if (registry.node(c.type)?.kind === 'inline' && !isOpaque(c, registry)) {
      newlines(c, [...path, i], registry, out)
    }
  }
  return out
}

/**
 * Splits the block at `path` right after each `\n` of `at` (in document order), last to first so the
 * earlier points stay valid: a split only moves content after its point, and each new block lands
 * right after `path`, ahead of the pieces split off before it. Each split goes through any inline
 * ancestors (which get fresh ids); each new block gets a fresh id and the block's type and data, and
 * the first piece keeps the id. The `\n`, now at the end of the left piece, is then removed. Marks
 * stay on each piece; a caret before a `\n` stays at the end of its line and one after it lands at
 * the start of the next block (points map forward through the split).
 */
function splitAtNewlines(tr: Transaction, block: ElementNode, path: Path, at: Point[]): void {
  for (let k = at.length - 1; k >= 0; k--) {
    const { path: textPath, offset } = at[k]!
    splitBlockAt(tr, { path: textPath, offset: offset + 1 }, path, { id: createId(), type: block.type, data: block.data })
    tr.apply({ type: 'remove_text', path: textPath, offset, text: '\n' })
  }
}

/** Moves the children of the element at `at` out before it (selection points follow), then removes it. */
function unwrap(tr: Transaction, node: ElementNode, at: Path): void {
  const parent = at.slice(0, -1)
  const i = at[at.length - 1]!
  const kids = node.children ?? []
  for (let k = 0; k < kids.length; k++) {
    tr.apply({ type: 'move_node', path: [...parent, i + k, 0], newPath: [...parent, i + k] })
  }
  tr.removeNode([...parent, i + kids.length])
}

/**
 * Moves the atom child `i` of the block at `path` out next to that block, keeping text order: at
 * the start it goes before the block, at the end after it; in the middle the block is first split
 * after the atom (the right half gets a fresh id) and the atom then goes between the halves.
 */
function hoist(tr: Transaction, block: ElementNode, path: Path, i: number): void {
  const count = (block.children ?? []).length
  if (i === 0) {
    tr.apply({ type: 'move_node', path: [...path, 0], newPath: path })
    return
  }
  if (i < count - 1) {
    tr.apply({ type: 'split_node', path, position: i + 1, properties: { id: createId(), type: block.type, data: block.data } })
  }
  tr.apply({ type: 'move_node', path: [...path, i], newPath: nextPath(path) })
}

function fixMarks(tr: Transaction, text: TextNode, path: Path): boolean {
  const target: Mark[] = []
  for (const m of text.marks) if (!target.some((t) => t.type === m.type)) target.push(m)
  target.sort((a, b) => tr.registry.markRank(a.type) - tr.registry.markRank(b.type))
  if (target.length === text.marks.length && target.every((m, i) => m === text.marks[i])) return false
  if (target.length < text.marks.length) {
    // Repeated types: no mark op sequence can be undone back to this state (`add_mark` refuses a type
    // that is already there), so the text node is replaced instead; its inverse restores the original.
    // The doc keeps its shape, so the selection (and the stored marks) is put back exactly as it was.
    const sel = tr.selection
    tr.apply({ type: 'remove_node', path, node: text })
    tr.apply({ type: 'insert_node', path, node: { ...text, marks: target } })
    if (tr.selection !== sel) tr.apply({ type: 'set_selection', selection: sel, prevSelection: tr.selection })
    return true
  }
  // Remove last-to-first so that undo (which appends) restores the original order.
  for (const m of [...text.marks].reverse()) tr.apply({ type: 'remove_mark', path, mark: m })
  for (const m of target) tr.apply({ type: 'add_mark', path, mark: m })
  return true
}

/** First (`last` = false) or last editable text inside `node` (itself if a text), with its path. */
function edgeText(node: Node, path: Path, last: boolean, registry: Registry): [TextNode, Path] | null {
  if (isText(node)) return [node, path]
  if (isOpaque(node, registry)) return null
  const kids = node.children ?? []
  for (let k = 0; k < kids.length; k++) {
    const idx = last ? kids.length - 1 - k : k
    const found = edgeText(kids[idx]!, [...path, idx], last, registry)
    if (found) return found
  }
  return null
}

/**
 * Before removing the empty text at `[...parent, i]`, moves selection points inside it to the
 * end of the closest editable text among the previous siblings, or else the start of the closest
 * one among the next siblings (opaque elements are skipped), so the selection survives the removal.
 * Every range is moved; the result is normalized (moved ranges may merge), `main` following its range.
 */
function rehomeSelection(tr: Transaction, siblings: Node[], parent: Path, i: number): void {
  const sel = tr.selection
  if (!sel) return
  const at = [...parent, i]
  const inside = (p: Path) => p.length === at.length && p.every((v, k) => v === at[k])
  if (!sel.ranges.some((r) => inside(r.anchor.path) || inside(r.focus.path))) return
  let target: Point | null = null
  for (let k = i - 1; k >= 0 && !target; k--) {
    const found = edgeText(siblings[k]!, [...parent, k], true, tr.registry)
    if (found) target = { path: found[1], offset: found[0].text.length }
  }
  for (let k = i + 1; k < siblings.length && !target; k++) {
    const found = edgeText(siblings[k]!, [...parent, k], false, tr.registry)
    if (found) target = { path: found[1], offset: 0 }
  }
  if (!target) return
  const move = (pt: Point) => (inside(pt.path) ? target : pt)
  // Applied as an op directly so stored marks are kept (Transaction.setSelection clears them).
  const moved = sel.ranges.map((range) => ({ ...range, anchor: move(range.anchor), focus: move(range.focus) }))
  tr.apply({ type: 'set_selection', selection: createSelection(moved, sel.main), prevSelection: sel })
}

/** Whether an element of `spec` holds inline content: a `content: 'inline'` block or a (non-atom) inline element. */
function holdsInline(spec: { kind: 'block' | 'inline'; content?: 'inline' | 'text' }): boolean {
  return spec.kind === 'inline' || spec.content === 'inline'
}

/** A registered inline element (atom or not); unknown types are left alone (rule 7). */
function isInlineElement(n: Node, registry: Registry): boolean {
  return isElement(n) && registry.node(n.type)?.kind === 'inline'
}

/** Whether the empty text `children[i]` is the only text between an inline element and its other side. */
function neededByRule10(children: Node[], i: number, registry: Registry): boolean {
  const prev = children[i - 1]
  const next = children[i + 1]
  const notText = (n: Node | undefined) => !n || !isText(n)
  return (
    (!!prev && isInlineElement(prev, registry) && notText(next)) ||
    (!!next && isInlineElement(next, registry) && notText(prev))
  )
}

function isInlineContent(n: Node, registry: Registry): boolean {
  return isText(n) || registry.node(n.type)?.kind === 'inline'
}

function emptyBlock(registry: Registry): ElementNode {
  return { id: createId(), type: registry.defaultBlock, data: {}, children: [{ text: '', marks: [] }] }
}
