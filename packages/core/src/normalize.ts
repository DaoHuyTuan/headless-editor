import { nodeText, type OptionsLookup } from './content/text'
import { isOpaque, nearestEditablePoint } from './model/editable'
import { createId } from './model/id'
import { getNode, isElement, isText, sameMarkSet } from './model/node'
import { nextPath } from './model/path'
import { createSelection } from './model/selection'
import type { ElementNode, Mark, Node, Path, Point, TextNode } from './model/types'
import { transformPath } from './ops/transform'
import { contentSource, exprNames, type RegisteredNode, type Registry } from './plugin/registry'
import type { AnyPlugin, PluginContext } from './plugin/types'
import { parseContentExpr } from './schema/content-expr'
import type { ContentMatch } from './schema/content-match'
import { matchChild } from './schema/validate'
import { splitBlockAt } from './transaction/text'
import { touchedElements } from './transaction/touched'
import type { Transaction } from './transaction/transaction'

const MAX_PASSES = 100
const MAX_CORE_FIXES_PER_PASS = 1_000_000

/** Whether the content rule checks an element (null: the doc). */
type Check = (node: ElementNode | null) => boolean

/**
 * Normalizes `tr.doc` in place by appending operations to `tr`: core rules first, then every
 * plugin's `normalize` hook on every node entry. Passes repeat until one adds no operations.
 *
 * The content rule (children matching the schema) runs on the doc and on the elements the tr's ops
 * touched, with their ancestors (`recordTouched`), including those its own fixes touch; on every
 * element when the tr has no doc op yet (a direct call on a doc to normalize, as on load). The
 * other core rules run on the whole doc.
 */
export function normalize(tr: Transaction, getContext: (plugin: AnyPlugin) => PluginContext<any, any>): void {
  const options: OptionsLookup = (plugin) => getContext(plugin).options
  const full = !tr.docChanged
  const check: Check = (node) => full || node === null || touchedElements(tr).has(node.id)
  for (let pass = 0; ; pass++) {
    if (pass >= MAX_PASSES) throw new Error('Normalization did not converge')
    const before = tr.ops.length
    // Core rules always converge (each fix shrinks the work left); the cap is only a safety net.
    for (let fixes = 0; fixOne(tr, options, check); fixes++) {
      if (fixes >= MAX_CORE_FIXES_PER_PASS) throw new Error('Normalization did not converge')
    }
    runPluginHooks(tr, getContext)
    if (tr.ops.length === before) return
  }
}

function runPluginHooks(tr: Transaction, getContext: (plugin: AnyPlugin) => PluginContext<any, any>): void {
  const plugins = tr.registry.plugins.filter((p) => p.spec.normalize)
  if (plugins.length === 0) return
  // Snapshot entry paths and map them through every op a hook adds, so they stay valid. Opaque
  // elements (unknown types, atoms) are visited, their descendants not: like the core rules (rule 7),
  // hooks leave what is inside them alone.
  const paths: (Path | null)[] = []
  const walk = (nodes: readonly Node[], parent: Path) =>
    nodes.forEach((n, i) => {
      const path = [...parent, i]
      paths.push(path)
      if (isElement(n) && !isOpaque(n, tr.registry)) walk(n.children ?? [], path)
    })
  walk(tr.doc.children as Node[], [])
  for (let i = 0; i < paths.length; i++) {
    for (const plugin of plugins) {
      const path = paths[i]
      if (!path) break
      const start = tr.ops.length
      plugin.spec.normalize!([getNode(tr.doc, path) as Node, path], tr, getContext(plugin))
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
function fixOne(tr: Transaction, options: OptionsLookup, check: Check): boolean {
  const root = tr.doc.children as Node[]
  // Rules 1 (the doc is never empty: it gets a default block) and 2 (texts and inline elements at
  // the root are wrapped into a default block) are the root case of the content rule.
  if (check(null) && fixContent(tr, null, [], root, options)) return true
  for (let i = 0; i < root.length; i++) {
    const n = root[i]!
    if (isElement(n) && fixElement(tr, n, [i], options, check)) return true
  }
  return false
}

function fixElement(tr: Transaction, node: ElementNode, path: Path, options: OptionsLookup, check: Check): boolean {
  const { registry } = tr
  const spec = registry.node(node.type)
  // Rule 7: unknown types are left untouched, including their children.
  if (!spec || spec.atom) return false
  const children = node.children ?? []
  if (children.length === 0 && spec.kind !== 'block') return false
  const inline = holdsInline(node.type, registry)

  if (check(node)) {
    if (!inline) {
      // The content rule for containers (rules 2 and 5 at any depth).
      if (fixContent(tr, node, path, children, options)) return true
    } else if (children.length === 0) {
      // Rule 5: an empty textblock gets an empty text where text is allowed (else what its content
      // requires, maybe nothing).
      if (registry.allowsInline(node.type, 'text')) {
        tr.insertNode([...path, 0], { text: '', marks: [] })
        return true
      }
      const fill = registry.contentMatch(node.type)!.fillBefore([], true, (t) => isKnown(t, registry))
      if (fill && fill.length > 0) return insertFilled(tr, path, 0, fill)
    } else {
      // Rule 9: inline content has no block children: a nested block is unwrapped (its children
      // are lifted into this element at its position). Repeated passes handle deeper nesting.
      // Unknown types are not blocks here (rule 7 leaves them alone). An atom block has no editable
      // children to lift, so it is hoisted out whole instead (see `hoist`).
      for (let i = 0; i < children.length; i++) {
        const c = children[i]!
        if (isText(c)) continue
        const childSpec = registry.node(c.type)
        if (childSpec?.kind !== 'block') continue
        if (childSpec.atom) {
          // Empty texts first (rule 4, which runs later otherwise): hoisting past them would split off
          // halves holding only them, left behind as stray empty blocks.
          const empty = children.findIndex(
            (t, k) => isText(t) && t.text === '' && !neededByRule10(children, k, registry, true),
          )
          if (empty >= 0) dropEmptyText(tr, children, path, empty)
          else hoist(tr, node, path, i)
        } else unwrap(tr, c, [...path, i])
        return true
      }
    }
  }

  if (inline) {
    // Rule 8: inline content keeps only the marks its element allows (`marks`; none in a
    // `content: 'text'` block) and the inline elements its content allows. Others are unwrapped,
    // except an inline atom with `renderText`, which becomes that text (so a mention keeps its `@label`).
    for (let i = 0; i < children.length; i++) {
      const c = children[i]!
      if (isText(c)) {
        const banned = c.marks.filter((m) => !registry.allowsMark(node.type, m.type))
        if (banned.length === 0) continue
        for (const m of banned.reverse()) tr.apply({ type: 'remove_mark', path: [...path, i], mark: m })
        return true
      }
      const childSpec = registry.node(c.type)
      if (childSpec?.kind !== 'inline' || registry.allowsInline(node.type, c.type)) continue
      if (childSpec.atom && childSpec.plugin.spec.renderText) {
        tr.insertNode([...path, i], { text: nodeText(c, registry, options), marks: [] })
        tr.removeNode([...path, i + 1])
      } else unwrap(tr, c, [...path, i])
      return true
    }
  }

  // Rule 11: `\n` is a line break only in text-only content (`content: 'text'`; HTML collapses it
  // elsewhere, so it would not round-trip). A textblock holding inline content with one (e.g. joined
  // with a code block's text by Backspace, a range delete or a paste) is split there into a block of
  // its type with a fresh id, and the `\n` removed. Every `\n` of the block is split in this one fix
  // (see `splitAtNewlines`), so a many-line text costs one fix, not one restart from the root per line.
  const richInline = inline && !textOnly(node.type, registry)
  if (richInline && spec.kind === 'block') {
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
    if (c.text === '' && children.length > 1 && !neededByRule10(children, i, registry, richInline)) {
      dropEmptyText(tr, children, path, i)
      return true
    }
    // Rule 6: marks are sorted by rank (duplicate types keep the first).
    if (fixMarks(tr, c, [...path, i])) return true
  }

  // Rule 10: in inline content that can hold inline elements and text, every inline element has a
  // text sibling on each side (an empty one is added where needed), so a caret can always sit right
  // before and right after it.
  if (richInline && registry.allowsInline(node.type, 'text')) {
    for (let i = 0; i < children.length; i++) {
      if (!isInlineElement(children[i]!, registry, true)) continue
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
    if (isElement(c) && fixElement(tr, c, [...path, i], options, check)) return true
  }
  return false
}

const isKnown = (type: string, registry: Registry) => type === 'text' || !!registry.node(type)

/**
 * The content rule for the doc (`parent` null) or a container: the first child that does not fit
 * the content expression (`matchChild`; unknown types always fit, rule 7) is fixed, in this order:
 * 1. a run of inline content is wrapped into a textblock (the position's default type, or the
 *    default block inside the wrappers it needs); 2. a block that fits once some nodes are inserted
 *    before it gets them (`fillBefore`); 3. a block that fits inside wrappers is wrapped
 *    (`findWrapping`); 4. a non-atom block is unwrapped; 5. an atom block is hoisted out of its
 *    container; 6. anything else is dropped, its text kept as a default block where one fits (logged
 *    in dev; unreachable with known plugins). Content that fits but is incomplete gets what it
 *    lacks appended (`fillBefore` to the end), so an empty container is filled and never gets a text.
 * Returns whether it made a fix.
 */
function fixContent(tr: Transaction, parent: ElementNode | null, path: Path, children: Node[], options: OptionsLookup): boolean {
  const { registry } = tr
  const known = (t: string) => isKnown(t, registry)
  let state = registry.contentMatch(parent ? parent.type : 'doc')!
  for (let i = 0; i < children.length; i++) {
    const c = children[i]!
    const next = matchChild(state, c, registry)
    if (next) {
      state = next
      continue
    }
    if (isInlineContent(c, registry)) {
      const chain = inlineWrapping(state, registry)
      if (chain) {
        let end = i
        while (end + 1 < children.length && isInlineContent(children[end + 1]!, registry)) end++
        wrap(tr, path, i, end - i + 1, chain)
        return true
      }
    } else {
      const type = (c as ElementNode).type
      const fill = state.fillBefore([type], false, known)
      if (fill && fill.length > 0) return insertFilled(tr, path, i, fill)
      const wrappers = state.findWrapping(type)
      if (wrappers && wrappers.length > 0) {
        wrap(tr, path, i, 1, wrappers)
        return true
      }
      if (!registry.node(type)!.atom) {
        unwrap(tr, c as ElementNode, [...path, i])
        return true
      }
      if (parent) {
        hoist(tr, parent, path, i)
        return true
      }
    }
    drop(tr, state, parent, path, i, options)
    return true
  }
  if (state.validEnd) return false
  const fill = state.fillBefore([], true, known)
  return !!fill && fill.length > 0 && insertFilled(tr, path, children.length, fill)
}

/** The types to wrap an inline run in at `state`, outermost first, ending with a textblock; null if none. */
function inlineWrapping(state: ContentMatch, registry: Registry): string[] | null {
  const type = state.defaultType
  if (type && registry.isTextblock(type)) return [type]
  const wrappers = state.findWrapping(registry.defaultBlock)
  return wrappers ? [...wrappers, registry.defaultBlock] : null
}

/**
 * Inserts an empty element chain of `types` (outermost first, data `{}`, so the schema's output
 * for it) at child `i` of `parent`, then moves the `count` children from `i` into its innermost
 * element, keeping their order (selection points follow).
 */
function wrap(tr: Transaction, parent: Path, i: number, count: number, types: string[]): void {
  let node: ElementNode | null = null
  for (let k = types.length - 1; k >= 0; k--) {
    node = { id: createId(), type: types[k]!, data: {}, children: node ? [node] : [] }
  }
  tr.insertNode([...parent, i], node!)
  const inner = [...parent, i, ...types.slice(1).map(() => 0)]
  for (let k = 0; k < count; k++) tr.apply({ type: 'move_node', path: [...parent, i + 1], newPath: [...inner, k] })
}

/** Inserts a filled node (`createAndFill`, or an empty text) of each of `types` from child `i` of `parent`. */
function insertFilled(tr: Transaction, parent: Path, i: number, types: string[]): boolean {
  types.forEach((type, k) => {
    const node = type === 'text' ? { text: '', marks: [] } : tr.registry.createAndFill(type)
    if (!node) throw new Error(`Normalization could not create a "${type}" node`)
    tr.insertNode([...parent, i + k], node)
  })
  return true
}

/**
 * Removes child `i` of `parent` (at `path`), which fits nowhere: its text, when it has some, is
 * put in its place in a default block if one fits there. Logged in dev.
 */
function drop(tr: Transaction, state: ContentMatch, parent: ElementNode | null, path: Path, i: number, options: OptionsLookup): void {
  const { registry } = tr
  const node = getNode(tr.doc, [...path, i]) as Node
  if (tr.dev) {
    const what = isText(node) ? 'text' : `"${node.type}" node`
    console.warn(`@penline/core: normalization dropped a ${what} that fits nowhere in "${parent ? parent.type : 'doc'}"`)
  }
  const text = nodeText(node, registry, options)
  if (text && state.matchType(registry.defaultBlock)) {
    tr.insertNode([...path, i], { id: createId(), type: registry.defaultBlock, data: {}, children: [{ text, marks: [] }] })
    tr.removeNode([...path, i + 1])
  } else tr.removeNode([...path, i])
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
/**
 * Removes the empty text `children[i]` of the element at `path` (it has other children). Merging it
 * into a previous text keeps a caret inside it valid (it maps to the end of that text); otherwise
 * the selection points in it move to a neighbouring text first (`rehomeSelection`). With no sibling
 * text to move to, a selection lost with the text becomes a caret at the nearest editable point of
 * the doc (`nearestEditablePoint`), as several ranges are re-homed by the transaction.
 */
function dropEmptyText(tr: Transaction, children: Node[], path: Path, i: number): void {
  const prev = children[i - 1]
  const c = children[i] as TextNode
  if (prev && isText(prev)) {
    tr.apply({ type: 'merge_node', path: [...path, i], position: prev.text.length, properties: { marks: c.marks } })
    return
  }
  rehomeSelection(tr, children, path, i)
  const had = tr.selection
  tr.removeNode([...path, i])
  if (had && !tr.selection) {
    const at = nearestEditablePoint(tr.doc, tr.registry, [...path, i])
    if (at) tr.apply({ type: 'set_selection', selection: createSelection([{ anchor: at, focus: at }], 0), prevSelection: null })
  }
}

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

/** Whether an element of `type` (known, not an atom) holds inline content: a textblock or an inline element. */
function holdsInline(type: string, registry: Registry): boolean {
  return registry.isTextblock(type) || registry.node(type)?.kind === 'inline'
}

const textOnlyTypes = new WeakMap<RegisteredNode, boolean>()

/**
 * Whether the content expression of `type` names only `text` (`content: 'text'`, `'text+'`…): such
 * content is plain text, where `\n` is a line break and no inline element goes. Read from the
 * expression, not the compiled match: with no inline plugin registered, `inline*` reaches only text too.
 */
function textOnly(type: string, registry: Registry): boolean {
  const spec = registry.node(type)
  if (!spec) return false
  let out = textOnlyTypes.get(spec)
  if (out === undefined) {
    out = exprNames(parseContentExpr(contentSource(spec))).every((name) => name === 'text')
    textOnlyTypes.set(spec, out)
  }
  return out
}

/**
 * A registered inline element (atom or not), or, in inline content (`inInline`), an unknown type: it
 * stands in the text there as one opaque character (`isInlineOpaque`), so it needs a text on each
 * side too. Its own subtree is still left alone (rule 7).
 */
function isInlineElement(n: Node, registry: Registry, inInline: boolean): boolean {
  if (!isElement(n)) return false
  const spec = registry.node(n.type)
  return spec ? spec.kind === 'inline' : inInline
}

/** Whether the empty text `children[i]` is the only text between an inline element and its other side. */
function neededByRule10(children: Node[], i: number, registry: Registry, inInline: boolean): boolean {
  const prev = children[i - 1]
  const next = children[i + 1]
  const notText = (n: Node | undefined) => !n || !isText(n)
  return (
    (!!prev && isInlineElement(prev, registry, inInline) && notText(next)) ||
    (!!next && isInlineElement(next, registry, inInline) && notText(prev))
  )
}

function isInlineContent(n: Node, registry: Registry): boolean {
  return isText(n) || registry.node(n.type)?.kind === 'inline'
}
