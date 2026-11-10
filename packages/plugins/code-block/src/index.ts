/**
 * Code block (`@penline/code-block`); React view in `@penline/code-block/react`. The plugin (and node type)
 * name is `codeBlock`; the view marker is kebab-case.
 *
 * Stable `data-*` attributes (view): `data-penline-code-block` on the root `<div>`, `data-selected` when
 * node-selected. HTML output: `<pre><code class="language-x">` (`options.HTMLAttributes` is merged into
 * the `<pre>`). Highlighting adds inline decorations whose classes come from the highlighter
 * (highlight.js `hljs-*`); `<code>` itself gets no `hljs` class.
 *
 * Parts (`classNames` also has `root`): `toolbar`, `languageSelect` (inside the toolbar), `content`
 * (`classNames.content` is on the `<pre>`). Parts and hooks are @experimental. See
 * docs/plugin-authoring.md.
 */
import { z } from 'zod'
import { createId, createSelection, definePlugin, findPathById, getNode, isElement, isNodeRange, isNodeSelection, isText, mainRange, mergeAttrs, nextPath, nodeText, type Command, type Decoration, type DeepReadonly, type Doc, type Editor, type ElementNode, type Fragment, type HTMLAttributes, type Node, type Operation, type OptionsLookup, type Path, type PluginContext, type Point, type Registry, type SelectionRange, type Transaction } from '@penline/core'
import { applyOp } from '@penline/core/internal'
import { defaultHighlighter, type HighlightToken, type Highlighter } from './highlight'

export { defaultHighlighter, type HighlightToken, type Highlighter } from './highlight'

/** The `data` of a code block node. */
export interface CodeBlockData {
  /** A highlighter language name (letters, digits, `+`, `#`, `-`); `'plaintext'` by default. */
  language: string
}

export interface CodeBlockOptions {
  /** Tokenizes a block's text for the syntax-highlighting decorations. Default: highlight.js (`defaultHighlighter`). */
  highlighter: Highlighter
  /** The languages a view offers (e.g. in a language select). Data accepts any safe language name. */
  languages: string[]
  /** Extra attributes merged into the `<pre>`. The `<code>`'s `language-*` class comes from the data. */
  HTMLAttributes: HTMLAttributes
  /** The accessible name of a view's language select (`aria-label`). Default `'Language'`. */
  languageLabel: string
}

const NAME = 'codeBlock'
const INDENT = '  '

type Ctx = PluginContext<CodeBlockOptions, undefined>
type ReadonlyDoc = DeepReadonly<Doc> | Doc

/**
 * The path of the nearest block-level element containing the node at `path` (the node itself when it
 * is a block element), or null. Unknown element types count as blocks.
 */
function blockPathOf(doc: ReadonlyDoc, registry: Registry, path: Path): Path | null {
  for (let depth = path.length; depth >= 1; depth--) {
    let node: DeepReadonly<Node>
    try {
      node = getNode(doc as Doc, path.slice(0, depth))
    } catch {
      return null
    }
    if (isElement(node) && registry.node(node.type)?.kind !== 'inline') return path.slice(0, depth)
  }
  return null
}

/** Whether the node at `path` is inside (or is) a code block. */
function inCodeBlock(doc: ReadonlyDoc, registry: Registry, path: Path): boolean {
  const block = blockPathOf(doc, registry, path)
  return !!block && (getNode(doc as Doc, block) as ElementNode).type === NAME
}

/** A code block holding a selection range, with its (normalized: single, unmarked) text. */
interface CodeAt {
  blockPath: Path
  textPath: Path
  text: string
  /** The range's ordered offsets into `text`. */
  from: number
  to: number
  anchor: number
  focus: number
}

function emptyDefaultBlock(registry: Registry): ElementNode {
  return { id: createId(), type: registry.defaultBlock, data: {}, children: [{ text: '', marks: [] }] }
}

/**
 * The code block holding the whole of `range` (both ends in its single text), or null. Callers pass a
 * range explicitly: with several ranges each is judged on its own (spec §5.5).
 */
function codeAtRange(tr: Transaction, range: SelectionRange): CodeAt | null {
  if (isNodeRange(range)) return null
  const blockPath = blockPathOf(tr.doc, tr.registry, range.anchor.path)
  if (!blockPath) return null
  const block = getNode(tr.doc, blockPath) as ElementNode
  const kids = block.children ?? []
  const textPath = [...blockPath, 0]
  const same = (p: Point) => p.path.length === textPath.length && p.path.every((n, i) => n === textPath[i])
  if (block.type !== NAME || kids.length !== 1 || !isText(kids[0]!) || !same(range.anchor) || !same(range.focus)) return null
  const { offset: anchor } = range.anchor
  const { offset: focus } = range.focus
  return { blockPath, textPath, text: kids[0].text, from: Math.min(anchor, focus), to: Math.max(anchor, focus), anchor, focus }
}

/** The selection's ranges that sit in a code block, with their blocks (none without a selection or for a node selection). */
function codeRanges(tr: Transaction): { range: SelectionRange; code: CodeAt }[] {
  const sel = tr.selection
  if (!sel || isNodeSelection(sel)) return []
  const out: { range: SelectionRange; code: CodeAt }[] = []
  for (const range of sel.ranges) {
    const code = codeAtRange(tr, range)
    if (code) out.push({ range, code })
  }
  return out
}

const caretRange = (path: Path, offset: number): SelectionRange => ({ anchor: { path, offset }, focus: { path, offset } })

/**
 * Runs `onCode` at every range inside a code block and `other` (the editor's default edit) at the
 * rest, on one tr. False, with nothing done, when no range is in a code block: the key falls through
 * to the editor. A caret outside a code block never gets code-block behaviour (no indent, no `\n`).
 */
function eachRange(
  tr: Transaction,
  onCode: (code: CodeAt, range: SelectionRange, t: Transaction) => SelectionRange | null | void,
  other?: (range: SelectionRange, t: Transaction) => void,
): boolean {
  if (codeRanges(tr).length === 0) return false
  tr.forEachRange((range, t) => {
    const code = codeAtRange(t, range)
    if (code) return onCode(code, range, t)
    other?.(range, t)
  })
  return tr.rejected === null
}

/** Inserts an empty default block after the code block; returns the caret range inside it. */
function exitAfter(tr: Transaction, blockPath: Path): SelectionRange {
  const at = nextPath(blockPath)
  tr.insertNode(at, emptyDefaultBlock(tr.registry))
  return caretRange([...at, 0], 0)
}

/**
 * The starts of the lines the range `from..to` of `text` touches: the line of `from`, plus every
 * later line starting before `to` (a range ending at a line start leaves that line out).
 */
function lineStarts(text: string, from: number, to: number): number[] {
  const starts = [from === 0 ? 0 : text.lastIndexOf('\n', from - 1) + 1]
  for (let i = text.indexOf('\n', from); i !== -1 && i + 1 < to; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  return starts
}

/** A text edit planned against the doc as it was: remove `remove` at `offset`, then insert `insert`. */
interface Edit {
  offset: number
  remove: string
  insert: string
}

type Plan = Map<string, { path: Path; edits: Edit[] }>

function planFor(plan: Plan, code: CodeAt): Edit[] {
  const key = code.textPath.join()
  let entry = plan.get(key)
  if (!entry) plan.set(key, (entry = { path: code.textPath, edits: [] }))
  return entry.edits
}

/** Applies the planned edits per text, last offset first so earlier offsets stay valid; every op maps the selection. */
function applyPlan(tr: Transaction, plan: Plan): void {
  for (const { path, edits } of plan.values()) {
    for (const e of edits.sort((a, b) => b.offset - a.offset)) {
      if (e.remove) tr.apply({ type: 'remove_text', path, offset: e.offset, text: e.remove })
      if (e.insert) tr.apply({ type: 'insert_text', path, offset: e.offset, text: e.insert })
    }
  }
}

/** Whether a range indents lines (spans two or more) rather than inserting the indent at itself. */
const indentsLines = (code: CodeAt): boolean => code.from !== code.to && lineStarts(code.text, code.from, code.to).length >= 2

/**
 * Tab at every range in a code block: two spaces at a caret (replacing a selection within one line),
 * or an indent of every line a multi-line selection touches. A line touched by several ranges is
 * indented once: a caret or single-line selection on a line another range indents adds nothing of its
 * own. A multi-line selection ending at the start of a line another range indents keeps ending
 * before that line's new indent. Ranges outside a code block are left alone (Tab has no default edit
 * for them).
 */
function indent(tr: Transaction): boolean {
  const ranges = codeRanges(tr)
  if (ranges.length === 0) return false
  // One range: the caret / selection edit exactly as before.
  if (tr.selection!.ranges.length === 1) {
    const { code } = ranges[0]!
    if (!indentsLines(code)) return tr.insertText(INDENT) && true
    // Last line first, so earlier offsets stay valid; the selection is mapped by every op.
    for (const start of lineStarts(code.text, code.from, code.to).reverse())
      tr.apply({ type: 'insert_text', path: code.textPath, offset: start, text: INDENT })
    return true
  }
  // Several ranges: plan every edit against the doc as it is, then apply last offset first.
  const lines = new Map<string, Set<number>>()
  for (const { code } of ranges) {
    if (!indentsLines(code)) continue
    const set = lines.get(code.textPath.join()) ?? new Set<number>()
    lineStarts(code.text, code.from, code.to).forEach((s) => set.add(s))
    lines.set(code.textPath.join(), set)
  }
  const plan: Plan = new Map()
  for (const { code } of ranges) {
    if (indentsLines(code) || lines.get(code.textPath.join())?.has(lineStarts(code.text, code.from, code.from)[0]!)) continue
    planFor(plan, code).push({ offset: code.from, remove: code.text.slice(code.from, code.to), insert: INDENT })
  }
  for (const [key, set] of lines) {
    const { code } = ranges.find((r) => r.code.textPath.join() === key)!
    for (const start of set) planFor(plan, code).push({ offset: start, remove: '', insert: INDENT })
  }
  // A multi-line selection ending at a line start leaves that line out; when another range indents
  // that line, the mapping would carry the end over the new indent. Those ends are put back before it.
  const before = tr.selection!
  const pullBack = before.ranges.map((range) => {
    const code = codeAtRange(tr, range)
    if (!code || !indentsLines(code) || !lines.get(code.textPath.join())?.has(code.to)) return null
    return code.anchor > code.focus ? 'anchor' : 'focus'
  })
  applyPlan(tr, plan)
  const after = tr.selection!
  if (tr.rejected === null && pullBack.some(Boolean) && after.ranges.length === before.ranges.length) {
    tr.setSelection(
      createSelection(
        after.ranges.map((range, i) => {
          const end = pullBack[i]
          if (!end) return range
          return { ...range, [end]: { ...range[end], offset: range[end].offset - INDENT.length } }
        }),
        after.main,
      ),
    )
  }
  return tr.rejected === null
}

/** Shift-Tab: removes up to two leading spaces from every distinct line the code ranges touch. */
function dedent(tr: Transaction): boolean {
  const ranges = codeRanges(tr)
  if (ranges.length === 0) return false
  const lines = new Map<string, { code: CodeAt; starts: Set<number> }>()
  for (const { code } of ranges) {
    const entry = lines.get(code.textPath.join()) ?? { code, starts: new Set<number>() }
    lineStarts(code.text, code.from, code.to).forEach((s) => entry.starts.add(s))
    lines.set(code.textPath.join(), entry)
  }
  const plan: Plan = new Map()
  for (const { code, starts } of lines.values()) {
    for (const start of starts) {
      let n = 0
      while (n < INDENT.length && code.text[start + n] === ' ') n++
      if (n > 0) planFor(plan, code).push({ offset: start, remove: code.text.slice(start, start + n), insert: '' })
    }
  }
  applyPlan(tr, plan)
  // Consumed even when nothing was removed, so Shift-Tab never moves the focus out of the block.
  return tr.rejected === null
}

/**
 * Enter at every range: in a code block a newline (a caret at the end of a block ending with two
 * newlines removes them and exits to a new paragraph); outside one, the editor's default split.
 */
function newline(tr: Transaction): boolean {
  return eachRange(
    tr,
    (code, range, t) => {
      if (code.from === code.to && code.to === code.text.length && code.text.endsWith('\n\n')) {
        t.apply({ type: 'remove_text', path: code.textPath, offset: code.text.length - 2, text: '\n\n' })
        return exitAfter(t, code.blockPath)
      }
      t.insertText('\n', range)
    },
    (range, t) => void t.splitBlock(range),
  )
}

/** Shift-Enter: a newline in a code block, never an exit; the editor's default split elsewhere. */
function lineBreak(tr: Transaction): boolean {
  return eachRange(
    tr,
    (_code, range, t) => void t.insertText('\n', range),
    (range, t) => void t.splitBlock(range),
  )
}

/** A block to replace, and the block that replaces it. */
interface Swap {
  /** Path of the block to replace (in the doc the swap starts from). */
  path: Path
  replacement: ElementNode
}

/**
 * Replaces blocks. There is no op that changes a node's type, so each replacement is inserted after
 * its block, the selection is moved into the new blocks, and then the old blocks are removed: the
 * selection never sits in a removed node, and one undo step restores everything. `place(i, range)`
 * says where the selection's range `i` goes: the index into `swaps` and the offsets in that block's
 * text (null: the range stays where it is). Every swap's replacement holds a single text child.
 */
function swapBlocks(
  tr: Transaction,
  swaps: Swap[],
  place: (index: number, range: SelectionRange) => { swap: number; anchor: number; focus: number } | null,
): boolean {
  const sel = tr.selection
  if (!sel || swaps.length === 0) return false
  const byPath = [...swaps.keys()].sort((a, b) => comparePaths(swaps[b]!.path, swaps[a]!.path))
  const oldIds = swaps.map((s) => (getNode(tr.doc, s.path) as ElementNode).id)
  // Last block first: an insert after a block moves only the later siblings.
  for (const i of byPath) {
    tr.insertNode(nextPath(swaps[i]!.path), swaps[i]!.replacement)
    if (tr.rejected !== null) return false
  }
  const newPaths = swaps.map((s) => findPathById(tr.doc, s.replacement.id)!)
  const current = tr.selection!
  tr.setSelection(
    createSelection(
      current.ranges.map((range, i) => {
        const to = place(i, sel.ranges[i]!)
        if (!to) return range
        const text = [...newPaths[to.swap]!, 0]
        return { anchor: { path: text, offset: to.anchor }, focus: { path: text, offset: to.focus } }
      }),
      current.main,
    ),
  )
  const oldPaths = oldIds.map((id) => findPathById(tr.doc, id)!).sort((a, b) => comparePaths(b, a))
  for (const path of oldPaths) tr.removeNode(path)
  return tr.rejected === null
}

/** Document order of two paths. */
function comparePaths(a: Path, b: Path): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!
  return a.length - b.length
}

/**
 * Backspace at the start of an empty code block: turns it into a paragraph (the default block). With
 * several ranges, only when every range is such a caret (each distinct block is turned): any other
 * mix is left to the editor, which deletes backward at every range.
 */
function unsetIfEmpty(tr: Transaction): boolean {
  const sel = tr.selection
  const ranges = codeRanges(tr)
  if (!sel || ranges.length !== sel.ranges.length || !ranges.every(({ code }) => code.text === '' && code.to === 0)) return false
  const swaps: Swap[] = []
  const swapOf = new Map<string, number>()
  for (const { code } of ranges) {
    const key = code.blockPath.join()
    if (!swapOf.has(key)) {
      swapOf.set(key, swaps.length)
      swaps.push({ path: code.blockPath, replacement: emptyDefaultBlock(tr.registry) })
    }
  }
  return swapBlocks(tr, swaps, (i) => ({ swap: swapOf.get(ranges[i]!.code.blockPath.join())!, anchor: 0, focus: 0 }))
}

/**
 * The texts of `node` with paths relative to it, in order: its editable texts, plus each atom with a
 * `renderText` as that text (other atoms and unknown elements have none).
 */
function textsOf(node: Node, registry: Registry, options: OptionsLookup, path: Path = []): { path: Path; text: string }[] {
  if (isText(node)) return [{ path, text: node.text }]
  const spec = registry.node(node.type)
  if (path.length > 0 && spec?.atom && spec.plugin.spec.renderText) return [{ path, text: nodeText(node, registry, options) }]
  if (path.length > 0 && (!spec || spec.atom)) return []
  return (node.children ?? []).flatMap((c, i) => textsOf(c, registry, options, [...path, i]))
}

/** `renderText` options: the editor's current plugin options. */
const editorOptions =
  (editor: Editor): OptionsLookup =>
  (plugin) =>
    editor.getPluginOptions(plugin.name)

/**
 * `setCodeBlock`: a code block holding the block's plain text (marks dropped, inline atoms as their
 * `renderText`) replaces every block that holds a range (see `swapBlocks`): a block with several
 * ranges is converted once, and each range keeps its text offsets. Blocks that cannot convert (not
 * inline content, already code, or a range spanning blocks) are left as they are; false when none can.
 */
function toCodeBlock(tr: Transaction, editor: Editor, language: string | undefined): boolean {
  const sel = tr.selection
  if (!sel || isNodeSelection(sel)) return false
  const options = editorOptions(editor)
  const swaps: Swap[] = []
  const swapOf = new Map<string, number>()
  const offsets: ({ swap: number; anchor: number; focus: number } | null)[] = []
  for (const range of sel.ranges) {
    const blockPath = blockPathOf(tr.doc, tr.registry, range.anchor.path)
    const focusBlock = blockPathOf(tr.doc, tr.registry, range.focus.path)
    const block = blockPath && (getNode(tr.doc, blockPath) as ElementNode)
    if (!blockPath || !focusBlock || blockPath.join() !== focusBlock.join() || !block || tr.registry.node(block.type)?.content !== 'inline') {
      offsets.push(null)
      continue
    }
    const texts = textsOf(block, tr.registry, options)
    const offsetOf = (p: Point): number => {
      const rel = p.path.slice(blockPath.length).join()
      let at = 0
      for (const t of texts) {
        if (t.path.join() === rel) return at + p.offset
        at += t.text.length
      }
      return 0
    }
    const key = blockPath.join()
    if (!swapOf.has(key)) {
      swapOf.set(key, swaps.length)
      swaps.push({
        path: blockPath,
        replacement: {
          id: createId(),
          type: NAME,
          data: language === undefined ? {} : { language },
          children: [{ text: texts.map((t) => t.text).join(''), marks: [] }],
        },
      })
    }
    offsets.push({ swap: swapOf.get(key)!, anchor: offsetOf(range.anchor), focus: offsetOf(range.focus) })
  }
  return swapBlocks(tr, swaps, (i) => offsets[i]!)
}

/**
 * Runs `edit` on a fresh tr and dispatches it when it applied with changes. Like a bound command,
 * false when the pipeline dropped the tr (e.g. another plugin's `filterTransaction`).
 */
function run(ctx: Ctx, edit: (tr: Transaction) => boolean): boolean {
  const tr = ctx.editor.createTransaction()
  tr.meta.origin = 'command'
  if (!edit(tr) || tr.rejected !== null) return false
  if (tr.ops.length === 0) return true
  const before = ctx.editor.state
  ctx.editor.dispatch(tr)
  return ctx.editor.state !== before
}

const isInlineInsert = (op: Operation, registry: Registry): op is Extract<Operation, { type: 'insert_node' }> =>
  op.type === 'insert_node' && isElement(op.node) && registry.node(op.node.type)?.kind === 'inline'

/**
 * Whether `tr` must be vetoed: it inserts an inline element into a code block, its marks all land in
 * code blocks (a mark only partly inside one is let through: normalization strips that part), or it
 * stores marks while every caret is in a code block (e.g. toggling bold at the caret). With carets
 * elsewhere too, the stored marks are let through, and so are marks that all land in code blocks in
 * the same tr: they type rich text at those carets, and normalization strips them from the code
 * block's text. Never asked for history
 * trs (`meta.origin === 'history'`): the filter lets every undo/redo through.
 */
function addsFormatting(tr: Transaction): boolean {
  const { registry } = tr
  const sel = tr.selection
  const storesMarks = !!sel && !!tr.storedMarks && tr.storedMarks.length > 0 && tr.storedMarks !== tr.before.storedMarks
  const someOutside = !!sel && sel.ranges.some((r) => !inCodeBlock(tr.doc, registry, r.focus.path))
  if (storesMarks && !someOutside) return true
  // Plain typing has neither: no replay.
  if (!tr.ops.some((op) => op.type === 'add_mark' || isInlineInsert(op, registry))) return false
  let doc: Doc = tr.before.doc as Doc
  let marks = 0
  let marksInCode = 0
  for (const op of tr.ops) {
    if (op.type === 'add_mark') {
      marks++
      if (inCodeBlock(doc, registry, op.path)) marksInCode++
    }
    if (isInlineInsert(op, registry) && inCodeBlock(doc, registry, op.path.slice(0, -1))) return true
    if (op.type !== 'set_selection') doc = applyOp(doc, op)
  }
  // Marks only in code blocks are vetoed, unless the tr also stores marks for a caret outside one
  // (normalization strips the marks in the code blocks).
  return marks > 0 && marksInCode === marks && !(storesMarks && someOutside)
}

const isBlockFragment = (fragment: Fragment, registry: Registry): boolean => {
  const first = fragment[0]
  return !!first && isElement(first) && registry.node(first.type)?.kind !== 'inline'
}

/**
 * Inline content holding newlines (text copied from inside a code block) split into default blocks,
 * one per line, so pasting it outside a code block keeps the lines.
 */
function linesToBlocks(fragment: Fragment, registry: Registry): Fragment {
  const lines: Node[][] = [[]]
  for (const node of fragment) {
    if (isText(node) && node.text.includes('\n')) {
      node.text.split('\n').forEach((part, i) => {
        if (i > 0) lines.push([])
        if (part) lines[lines.length - 1]!.push({ text: part, marks: node.marks })
      })
    } else lines[lines.length - 1]!.push(node)
  }
  return lines.map((children) => ({
    id: createId(),
    type: registry.defaultBlock,
    data: {},
    children: children.length > 0 ? children : [{ text: '', marks: [] }],
  }))
}

/** A valid highlight token of a code block below some subtree root: `path` is its text's, relative to that root. */
interface SubtreeToken {
  path: Path
  from: number
  to: number
  className: string
}

/**
 * Per element node (nodes are immutable and unchanged subtrees keep their identity), the highlight
 * tokens of the code blocks below it and the highlighter and code block type that made them. An
 * update walks only the elements that changed: an unchanged subtree, code block or not, is reused
 * without being walked or highlighted again.
 */
const subtreeCache = new WeakMap<object, { highlighter: Highlighter; name: string; tokens: readonly SubtreeToken[] }>()

/** The valid tokens `highlighter` gives a code block with a single non-empty text (others have none). */
function blockTokens(block: ElementNode, highlighter: Highlighter): SubtreeToken[] {
  const kids = block.children ?? []
  const only = kids[0]
  if (kids.length !== 1 || !only || !isText(only) || only.text === '') return []
  const text = only.text
  const language = typeof block.data.language === 'string' ? block.data.language : 'plaintext'
  let raw: HighlightToken[] = []
  try {
    const result = highlighter(text, language)
    raw = Array.isArray(result) ? result : []
  } catch (error) {
    // A throwing highlighter only loses the highlighting, never the render.
    console.error('@penline/code-block:', error)
  }
  const out: SubtreeToken[] = []
  for (const t of raw) {
    const ok = Number.isInteger(t.from) && Number.isInteger(t.to) && t.from >= 0 && t.to > t.from && t.to <= text.length
    if (ok && typeof t.className === 'string') out.push({ path: [0], from: t.from, to: t.to, className: t.className })
  }
  return out
}

/** The tokens of the code blocks (type `name`) in the subtree of `node`, in document order, cached per node. */
function subtreeTokens(node: Node, name: string, highlighter: Highlighter): readonly SubtreeToken[] {
  if (!isElement(node)) return []
  const cached = subtreeCache.get(node)
  if (cached && cached.highlighter === highlighter && cached.name === name) return cached.tokens
  const tokens: SubtreeToken[] = node.type === name ? blockTokens(node, highlighter) : []
  ;(node.children ?? []).forEach((child, i) => {
    for (const t of subtreeTokens(child, name, highlighter)) tokens.push({ ...t, path: [i, ...t.path] })
  })
  subtreeCache.set(node, { highlighter, name, tokens })
  return tokens
}

/**
 * Code block: a block holding plain text only (`content: 'text'`: no marks, no inline nodes), with
 * `\n` as its line breaks and `data: { language }`.
 *
 * - Keys, only with the selection in a code block: Tab inserts two spaces (indents each line of a
 *   multi-line selection), Shift-Tab removes up to two leading spaces per line (both are always
 *   consumed there, so focus never tabs out of the block), Enter inserts `\n` (at the end of a block
 *   ending with `\n\n` it removes them and exits to a new paragraph), Shift-Enter inserts `\n`,
 *   Mod-Enter exits the block to a new paragraph after it, Backspace at the start of an empty block
 *   turns it into a paragraph. `insertParagraph` / `insertLineBreak` intents behave like Enter (a
 *   mention popup open at the main caret claims `insertParagraph` first: `@penline/mention` has the
 *   higher priority).
 * - Several ranges: every key works per range. Code-block behaviour applies only to ranges inside a
 *   code block; Enter and Shift-Enter give the other ranges the editor's default split, Tab and
 *   Shift-Tab leave them alone, and Backspace is the editor's unless every range is at the start of an
 *   empty code block. A line touched by several ranges is indented once. The commands act on every
 *   distinct block holding a range. A multi-range paste gives plain text to carets inside code blocks
 *   and the rich fragment to the others.
 * - Marks and inline nodes are blocked: a tr whose added marks all fall in code blocks, that inserts
 *   an inline element into one or that stores marks at a caret in one is filtered out (so
 *   `toggleBold` and `insertMention` return false there); a mark over a paragraph and a code block
 *   applies to the paragraph only, as normalization strips marks inside code blocks.
 * - Paste inside a code block inserts the clipboard's plain text, blocks joined by `\n`. Text copied
 *   from a code block and pasted outside one becomes one paragraph per line.
 * - HTML: `<pre><code class="language-x">…</code></pre>`, both ways.
 * - Syntax highlighting: inline decorations from `options.highlighter` (`hljs-*` classes with the
 *   default highlight.js adapter; include a highlight.js theme to style them).
 */
export const codeBlock = definePlugin({
  name: NAME,
  priority: 150,
  node: { kind: 'block', content: 'text' },
  data: z.object({ language: z.string().regex(/^[a-z0-9+#-]*$/i).default('plaintext') }),
  options: {
    highlighter: defaultHighlighter,
    languages: ['plaintext', 'javascript', 'typescript', 'json', 'css', 'html', 'python', 'bash'],
    HTMLAttributes: {},
    languageLabel: 'Language',
  } as CodeBlockOptions,
  // `commands` comes before every hook taking `ctx`: TypeScript types those hooks in order.
  commands: () => ({
    /** Turns every block holding a range (a paragraph or other inline-content block) into a code block. */
    setCodeBlock:
      (language?: string): Command =>
      ({ tr, editor }) =>
        toCodeBlock(tr, editor, language),
    /** Sets the language of every code block holding a range. False outside one or for an unsafe name. */
    setLanguage:
      (language: string): Command =>
      ({ tr }) => {
        const blocks = new Map<string, Path>()
        for (const { code } of codeRanges(tr)) blocks.set(code.blockPath.join(), code.blockPath)
        if (blocks.size === 0) return false
        for (const path of blocks.values()) tr.setNodeData(path, { language })
        return tr.rejected === null
      },
    /**
     * Inserts a paragraph after every code block holding a range and moves the caret into it; the
     * ranges of one block become that one caret. Ranges outside a code block stay.
     */
    exitCodeBlock: (): Command => ({ tr }) => {
      const exited = new Set<string>()
      return eachRange(tr, (code, _range, t) => {
        // The block's id: its path moves as earlier blocks get their paragraph.
        const id = (getNode(t.doc, code.blockPath) as ElementNode).id
        if (exited.has(id)) return null
        exited.add(id)
        return exitAfter(t, code.blockPath)
      })
    },
  }),
  keymap: (ctx) => ({
    Tab: () => run(ctx, indent),
    'Shift-Tab': () => run(ctx, dedent),
    Enter: () => run(ctx, newline),
    'Shift-Enter': () => run(ctx, lineBreak),
    'Mod-Enter': () => ctx.commands.exitCodeBlock(),
    Backspace: () => run(ctx, unsetIfEmpty),
  }),
  // An Enter that arrives only as `beforeinput` (Android keyboards; desktop Shift-Enter when no
  // keydown binding ran) would otherwise split the block: inside a code block both line-break intents
  // take Enter's newline / exit path.
  // Consumed whenever a range is in a code block, even when the pipeline drops the tr: falling
  // through would let the core split the code block instead.
  onBeforeInput: (intent, ctx) => {
    if (intent.inputType !== 'insertParagraph' && intent.inputType !== 'insertLineBreak') return false
    let applied = false
    run(ctx, (tr) => (applied = newline(tr)))
    return applied
  },
  // Loaded content with an invalid (e.g. unsafe) language keeps its code, as plaintext.
  onInvalidData: () => ({ language: 'plaintext' }),
  // History is never vetoed: an undo/redo tr is the inverse of states the pipeline already accepted,
  // and may transiently re-add a mark or atom inside a code block before its own split restores the
  // paragraph (rule 8 normalization strips anything still left inside).
  filterTransaction: (tr) => tr.meta.origin === 'history' || !addsFormatting(tr),
  // Decided by where the fragment goes: the drop point of a drop, else the selection.
  transformPasted: (fragment, ctx, { at }) => {
    const { state, registry } = ctx.editor
    const target = at ?? (state.selection && mainRange(state.selection))
    if (target && !isNodeRange(target) && inCodeBlock(state.doc, registry, target.anchor.path)) {
      const options = editorOptions(ctx.editor)
      // One line per block, nested ones (a list's items) included; inline content joins as is.
      const isBlockEl = (n: Node): n is ElementNode => isElement(n) && registry.node(n.type)?.kind !== 'inline'
      const lines = (n: Node): string[] => {
        const kids = isBlockEl(n) && !registry.node(n.type)?.plugin.spec.renderText ? (n.children ?? []) : []
        return kids.length > 0 && kids.every(isBlockEl) ? kids.flatMap(lines) : [nodeText(n, registry, options)]
      }
      const text = isBlockFragment(fragment, registry)
        ? fragment.flatMap(lines).join('\n')
        : fragment.map((n) => nodeText(n, registry, options)).join('')
      return text ? [{ text, marks: [] }] : []
    }
    if (!isBlockFragment(fragment, registry) && fragment.some((n) => isText(n) && n.text.includes('\n')))
      return linesToBlocks(fragment, registry)
    return fragment
  },
  parseHTML: [
    {
      tag: 'pre',
      getData: (el) => ({
        language: /language-([\w+#-]+)/.exec(el.querySelector('code')?.className ?? '')?.[1] ?? 'plaintext',
      }),
    },
  ],
  // The language is schema-checked (`[a-z0-9+#-]`), so it is safe in a class name.
  renderHTML: (node, { options }) => [
    'pre',
    mergeAttrs(options.HTMLAttributes, {}),
    ['code', { class: `language-${typeof node.data.language === 'string' ? node.data.language : 'plaintext'}` }, 0],
  ],
  decorations: (state, ctx): Decoration[] => {
    const out: Decoration[] = []
    const highlighter = ctx.options.highlighter
    if (typeof highlighter !== 'function') return out
    // Only the top-level blocks are visited on every update; below them, `subtreeTokens` reuses
    // every subtree that did not change.
    ;(state.doc as Doc).children.forEach((block, i) => {
      for (const t of subtreeTokens(block, ctx.name, highlighter)) {
        const at = (offset: number): Point => ({ path: [i, ...t.path], offset })
        out.push({ type: 'inline', from: at(t.from), to: at(t.to), attrs: { class: t.className } })
      }
    })
    return out
  },
})
