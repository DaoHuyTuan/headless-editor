import { z } from 'zod'
import {
  applyOp,
  createId,
  definePlugin,
  getNode,
  isElement,
  isNodeSelection,
  isText,
  mergeAttrs,
  nextPath,
  nodeEntries,
  type Command,
  type Decoration,
  type DeepReadonly,
  type Doc,
  type ElementNode,
  type Fragment,
  type HTMLAttributes,
  type Node,
  type Path,
  type PluginContext,
  type Point,
  type Registry,
  type Selection,
  type Transaction,
} from '@hte/core'
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
    let node: Node
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

/** A code block holding the selection, with its (normalized: single, unmarked) text. */
interface CodeAt {
  blockPath: Path
  textPath: Path
  text: string
  /** The selection's ordered offsets into `text`. */
  from: number
  to: number
  anchor: number
  focus: number
}

/** The code block holding the whole selection (not a node selection), or null. */
function codeAt(tr: Transaction): CodeAt | null {
  const sel = tr.selection
  if (!sel || isNodeSelection(sel)) return null
  const blockPath = blockPathOf(tr.doc, tr.registry, sel.anchor.path)
  if (!blockPath) return null
  const block = getNode(tr.doc, blockPath) as ElementNode
  const kids = block.children ?? []
  const textPath = [...blockPath, 0]
  const same = (p: Point) => p.path.length === textPath.length && p.path.every((n, i) => n === textPath[i])
  if (block.type !== NAME || kids.length !== 1 || !isText(kids[0]!) || !same(sel.anchor) || !same(sel.focus)) return null
  const { offset: anchor } = sel.anchor
  const { offset: focus } = sel.focus
  return { blockPath, textPath, text: kids[0].text, from: Math.min(anchor, focus), to: Math.max(anchor, focus), anchor, focus }
}

const caret = (path: Path, offset: number): Selection => ({ anchor: { path, offset }, focus: { path, offset } })

function emptyDefaultBlock(registry: Registry): ElementNode {
  return { id: createId(), type: registry.defaultBlock, data: {}, children: [{ text: '', marks: [] }] }
}

/** Inserts an empty default block after the code block and puts the caret in it. */
function exitAfter(tr: Transaction, blockPath: Path): boolean {
  const at = nextPath(blockPath)
  tr.insertNode(at, emptyDefaultBlock(tr.registry))
  tr.setSelection(caret([...at, 0], 0))
  return tr.rejected === null
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

/** Tab: two spaces at the caret (replacing a selection within one line), or indents every selected line. */
function indent(tr: Transaction): boolean {
  const code = codeAt(tr)
  if (!code) return false
  const starts = code.from === code.to ? [] : lineStarts(code.text, code.from, code.to)
  if (starts.length < 2) return tr.insertText(INDENT) && true
  // Last line first, so earlier offsets stay valid; the selection is mapped by every op.
  for (const start of starts.reverse()) tr.apply({ type: 'insert_text', path: code.textPath, offset: start, text: INDENT })
  return true
}

/** Shift-Tab: removes up to two leading spaces from every line the selection touches. */
function dedent(tr: Transaction): boolean {
  const code = codeAt(tr)
  if (!code) return false
  for (const start of lineStarts(code.text, code.from, code.to).reverse()) {
    let n = 0
    while (n < INDENT.length && code.text[start + n] === ' ') n++
    if (n > 0) tr.apply({ type: 'remove_text', path: code.textPath, offset: start, text: code.text.slice(start, start + n) })
  }
  // Consumed even when nothing was removed, so Shift-Tab never moves the focus out of the block.
  return true
}

/** Enter: a newline; at the end of a block ending with two newlines, removes them and exits to a new paragraph. */
function newline(tr: Transaction): boolean {
  const code = codeAt(tr)
  if (!code) return false
  if (code.from === code.to && code.to === code.text.length && code.text.endsWith('\n\n')) {
    tr.apply({ type: 'remove_text', path: code.textPath, offset: code.text.length - 2, text: '\n\n' })
    return exitAfter(tr, code.blockPath)
  }
  return tr.insertText('\n') && true
}

/** Swaps the block at `path` for `replacement`, putting the selection at `selection` (paths inside the new block). */
function replaceBlock(tr: Transaction, path: Path, replacement: ElementNode, selection: (path: Path) => Selection): boolean {
  // Insert after, move the selection in, then remove the old block: the selection never sits in a removed node.
  const after = nextPath(path)
  tr.insertNode(after, replacement)
  if (tr.rejected !== null) return false
  tr.setSelection(selection(after))
  tr.removeNode(path)
  return true
}

/** Backspace at the start of an empty code block: turns it into a paragraph (the default block). */
function unsetIfEmpty(tr: Transaction): boolean {
  const code = codeAt(tr)
  if (!code || code.text !== '' || code.to !== 0) return false
  return replaceBlock(tr, code.blockPath, emptyDefaultBlock(tr.registry), (p) => caret([...p, 0], 0))
}

/** The editable texts of `node` (not inside atoms or unknown elements), with paths relative to it, in order. */
function textsOf(node: Node, registry: Registry, path: Path = []): { path: Path; text: string }[] {
  if (isText(node)) return [{ path, text: node.text }]
  const spec = registry.node(node.type)
  if (path.length > 0 && (!spec || spec.atom)) return []
  return (node.children ?? []).flatMap((c, i) => textsOf(c, registry, [...path, i]))
}

/**
 * `setCodeBlock`: there is no op that changes a node's type, so the block is replaced: a code block
 * holding the block's plain text (marks and inline atoms dropped) is inserted after it, the selection
 * is moved into it at the same text offsets, and the block is removed. One undo step restores it.
 */
function toCodeBlock(tr: Transaction, language: string | undefined): boolean {
  const sel = tr.selection
  if (!sel || isNodeSelection(sel)) return false
  const blockPath = blockPathOf(tr.doc, tr.registry, sel.anchor.path)
  const focusBlock = blockPathOf(tr.doc, tr.registry, sel.focus.path)
  if (!blockPath || !focusBlock || blockPath.join() !== focusBlock.join()) return false
  const block = getNode(tr.doc, blockPath) as ElementNode
  if (tr.registry.node(block.type)?.content !== 'inline') return false
  const texts = textsOf(block, tr.registry)
  const offsetOf = (p: Point): number => {
    const rel = p.path.slice(blockPath.length).join()
    let at = 0
    for (const t of texts) {
      if (t.path.join() === rel) return at + p.offset
      at += t.text.length
    }
    return 0
  }
  const node: ElementNode = {
    id: createId(),
    type: NAME,
    data: language === undefined ? {} : { language },
    children: [{ text: texts.map((t) => t.text).join(''), marks: [] }],
  }
  const [anchor, focus] = [offsetOf(sel.anchor), offsetOf(sel.focus)]
  return replaceBlock(tr, blockPath, node, (p) => ({
    anchor: { path: [...p, 0], offset: anchor },
    focus: { path: [...p, 0], offset: focus },
  }))
}

/** Runs `edit` on a fresh tr and dispatches it when it applied with changes (like a bound command). */
function run(ctx: Ctx, edit: (tr: Transaction) => boolean): boolean {
  const tr = ctx.editor.createTransaction()
  tr.meta.origin = 'command'
  if (!edit(tr) || tr.rejected !== null) return false
  if (tr.ops.length > 0) ctx.editor.dispatch(tr)
  return true
}

/** Whether `tr` adds a mark to a code block's text or inserts an inline element into one. */
function addsFormatting(tr: Transaction): boolean {
  const { registry } = tr
  let doc: Doc = tr.before.doc as Doc
  for (const op of tr.ops) {
    if (op.type === 'add_mark' && inCodeBlock(doc, registry, op.path)) return true
    if (
      op.type === 'insert_node' &&
      isElement(op.node) &&
      registry.node(op.node.type)?.kind === 'inline' &&
      inCodeBlock(doc, registry, op.path.slice(0, -1))
    )
      return true
    if (op.type !== 'set_selection') doc = applyOp(doc, op)
  }
  // A caret in a code block never gets stored marks (e.g. toggling bold at the caret).
  const sel = tr.selection
  return (
    !!sel &&
    !!tr.storedMarks &&
    tr.storedMarks.length > 0 &&
    tr.storedMarks !== tr.before.storedMarks &&
    inCodeBlock(tr.doc, registry, sel.focus.path)
  )
}

function plainText(node: Node): string {
  return isText(node) ? node.text : (node.children ?? []).map(plainText).join('')
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

/** Per code block node (nodes are immutable), the tokens last computed and the highlighter that made them. */
const tokenCache = new WeakMap<object, { highlighter: Highlighter; tokens: HighlightToken[] }>()

function tokensFor(block: DeepReadonly<ElementNode>, text: string, highlighter: Highlighter): HighlightToken[] {
  const cached = tokenCache.get(block)
  if (cached && cached.highlighter === highlighter) return cached.tokens
  const language = typeof block.data.language === 'string' ? block.data.language : 'plaintext'
  let tokens: HighlightToken[] = []
  try {
    const raw = highlighter(text, language)
    tokens = Array.isArray(raw) ? raw : []
  } catch (error) {
    // A throwing highlighter only loses the highlighting, never the render.
    console.error('@hte/code-block:', error)
  }
  tokenCache.set(block, { highlighter, tokens })
  return tokens
}

/**
 * Code block: a block holding plain text only (`content: 'text'`: no marks, no inline nodes), with
 * `\n` as its line breaks and `data: { language }`.
 *
 * - Keys, only with the selection in a code block: Tab inserts two spaces (indents each line of a
 *   multi-line selection), Shift-Tab removes up to two leading spaces per line, Enter inserts `\n`
 *   (at the end of a block ending with `\n\n` it removes them and exits to a new paragraph),
 *   Mod-Enter exits, Backspace at the start of an empty block turns it into a paragraph.
 * - Marks and inline nodes are blocked: a tr adding a mark to a code block's text, inserting an
 *   inline element into one or storing marks at a caret in one is filtered out (so `toggleBold` and
 *   `insertMention` return false there), and normalization strips any that arrive otherwise.
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
  } as CodeBlockOptions,
  // `commands` comes before every hook taking `ctx`: TypeScript types those hooks in order.
  commands: () => ({
    /** Turns the block holding the selection (a paragraph or other inline-content block) into a code block. */
    setCodeBlock:
      (language?: string): Command =>
      ({ tr }) =>
        toCodeBlock(tr, language),
    /** Sets the language of the code block holding the selection. False outside one or for an unsafe name. */
    setLanguage:
      (language: string): Command =>
      ({ tr }) => {
        const code = codeAt(tr)
        if (!code) return false
        tr.setNodeData(code.blockPath, { language })
        return tr.rejected === null
      },
    /** Inserts a paragraph after the code block holding the selection and moves the caret into it. */
    exitCodeBlock: (): Command => ({ tr }) => {
      const code = codeAt(tr)
      return !!code && exitAfter(tr, code.blockPath)
    },
  }),
  keymap: (ctx) => ({
    Tab: () => run(ctx, indent),
    'Shift-Tab': () => run(ctx, dedent),
    Enter: () => run(ctx, newline),
    'Mod-Enter': () => ctx.commands.exitCodeBlock(),
    Backspace: () => run(ctx, unsetIfEmpty),
  }),
  // Loaded content with an invalid (e.g. unsafe) language keeps its code, as plaintext.
  onInvalidData: () => ({ language: 'plaintext' }),
  filterTransaction: (tr) => !addsFormatting(tr),
  transformPasted: (fragment, ctx) => {
    const { state, registry } = ctx.editor
    const sel = state.selection
    if (sel && !isNodeSelection(sel) && inCodeBlock(state.doc, registry, sel.anchor.path)) {
      const text = fragment.map(plainText).join(isBlockFragment(fragment, registry) ? '\n' : '')
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
    for (const [node, path] of nodeEntries(state.doc)) {
      if (!isElement(node) || node.type !== ctx.name) continue
      const kids = node.children ?? []
      const only = kids[0]
      if (kids.length !== 1 || !only || !isText(only) || only.text === '') continue
      const text = only.text
      const at = (offset: number): Point => ({ path: [...path, 0], offset })
      for (const t of tokensFor(node, text, highlighter)) {
        const ok = Number.isInteger(t.from) && Number.isInteger(t.to) && t.from >= 0 && t.to > t.from && t.to <= text.length
        if (ok && typeof t.className === 'string') out.push({ type: 'inline', from: at(t.from), to: at(t.to), attrs: { class: t.className } })
      }
    }
    return out
  },
})
