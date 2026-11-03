import type { Editor } from '../editor'
import { nextPath, pointEquals } from '../model/path'
import type { Path, Point, Selection } from '../model/types'
import { transformPath } from '../ops/transform'
import type { Operation } from '../ops/types'
import type { EditorState } from '../state'
import type { Transaction } from '../transaction/transaction'
import { attachClipboard } from './clipboard'
import { attachComposition } from './composition'
import { attachDrop } from './drop'
import { modelToDom, readDomSelection, writeDomSelection } from './dom-selection'
import { isInIgnoredElement } from './ignore'
import { attachInput } from './input'
import { attachMutation } from './mutation'
import { attachNodeSelect } from './node-select'
import { Renderer } from './renderer'

/** The leaf an IME composition owns, and the current model path of the text it shows. */
export interface CompositionTarget {
  leaf: HTMLElement
  path: Path
}

export interface InputRecord {
  inputType: string
  data: string | null
  time: number
}

/** A view module (input, composition, mutation, clipboard) attaches its listeners and returns their disposer. */
export type ViewModule = (view: EditorView) => () => void

const RECENT_INPUT_SIZE = 20

/**
 * Follows the composing text through `tr`; null when it was removed, or split or merged (the leaf
 * would then no longer show the whole text at its path).
 */
function mapComposition(target: CompositionTarget, tr: Transaction): CompositionTarget | null {
  let path: Path | null = target.path
  for (const op of tr.ops) {
    if (touchesText(op, path)) return null
    path = transformPath(path, op)
    if (!path) return null
  }
  return path === target.path ? target : { leaf: target.leaf, path }
}

/**
 * Whether `op` changes the content or marks of the text at `path` (including a merge of its next
 * sibling into it): the composing leaf would no longer match the model text, so the commit diff
 * would undo that change.
 */
function touchesText(op: Operation, path: Path): boolean {
  switch (op.type) {
    case 'insert_text':
    case 'remove_text':
    case 'add_mark':
    case 'remove_mark':
    case 'set_node_data':
    case 'split_node':
      return samePath(op.path, path)
    case 'merge_node':
      return samePath(op.path, path) || samePath(op.path, nextPath(path))
    default:
      return false
  }
}

function samePath(a: Path, b: Path): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

interface DomSelectionSnapshot {
  anchorNode: globalThis.Node | null
  anchorOffset: number
  focusNode: globalThis.Node | null
  focusOffset: number
}

function snapshot(domSel: globalThis.Selection): DomSelectionSnapshot {
  const { anchorNode, anchorOffset, focusNode, focusOffset } = domSel
  return { anchorNode, anchorOffset, focusNode, focusOffset }
}

function sameSnapshot(a: DomSelectionSnapshot, b: DomSelectionSnapshot): boolean {
  return (
    a.anchorNode === b.anchorNode &&
    a.anchorOffset === b.anchorOffset &&
    a.focusNode === b.focusNode &&
    a.focusOffset === b.focusOffset
  )
}

function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (a === null || b === null) return a === b
  if (pointEquals(a.anchor, b.anchor) && pointEquals(a.focus, b.focus)) {
    return a.node === undefined || b.node === undefined ? a.node === b.node : samePath(a.node, b.node)
  }
  return false
}

/**
 * Glues an editor to a contenteditable root: renders every transaction, keeps the DOM selection and
 * the model selection in sync, and owns the DOM listeners. `destroy` removes all of them (the
 * rendered content stays in place).
 */
export class EditorView {
  readonly renderer: Renderer
  /** True while an IME composition is in progress (driven by the composition module). */
  composing = false
  /**
   * While composing, the leaf the IME writes into: renders never touch it and pin it to `path`,
   * which follows every transaction. Null when there is none (or its text was removed).
   */
  composition: CompositionTarget | null = null

  private readonly _recentInput: InputRecord[] = []
  private readonly disposers: (() => void)[] = []
  /** True while the view itself writes the DOM selection. */
  private writingSelection = false
  private destroyed = false
  /** What the plugins' `onMount` hooks returned, in call order. */
  private mountCleanups: (() => void)[] = []
  /** Whether focus is inside the root (as tracked by focusin/focusout). */
  private focusInside = false
  /**
   * The DOM selection as it was when the model selection could not be written because its leaf is
   * not placed yet (see `syncSelection`); null otherwise.
   */
  private staleDomSelection: DomSelectionSnapshot | null = null

  constructor(
    readonly editor: Editor,
    readonly root: HTMLElement,
  ) {
    this.renderer = new Renderer(root, editor)
    this.renderer.render(editor.state.doc, { decorations: editor.getDecorations(editor.state) })

    this.disposers.push(
      editor.on('options', ({ editor: ed, plugin }) => {
        const spec = ed.registry.node(plugin)
        if (spec) this.renderer.invalidate(plugin)
        if (ed.registry.mark(plugin)) this.renderer.invalidateMark(plugin)
        this.update(ed.state)
      }),
    )
    this.disposers.push(editor.on('transaction', ({ editor: ed, tr }) => this.onTransaction(ed.state, tr)))
    this.listen(root.ownerDocument, 'selectionchange', () => this.onSelectionChange())
    this.attach(attachInput)
    this.attach(attachComposition)
    this.attach(attachMutation)
    this.attach(attachClipboard)
    this.attach(attachNodeSelect)
    this.attach(attachDrop)
    // Already focused (e.g. a remount on the same root): no onFocus now, but leaving is a blur.
    const active = root.ownerDocument.activeElement
    this.focusInside = !!active && root.contains(active)
    this.listen(root, 'focusin', (e) => this.onFocusIn(e as FocusEvent))
    this.listen(root, 'focusout', (e) => this.onFocusOut(e as FocusEvent))

    // Plugins' onMount hooks run last, on a fully set-up view. If one throws, the view is torn
    // down (running the cleanups already returned) and the first error is rethrown.
    const { cleanups, errors } = editor.handleMount(this)
    this.mountCleanups = cleanups
    if (errors.length > 0) {
      try {
        this.destroy()
      } catch {
        // The onMount error is the one reported.
      }
      throw errors[0]
    }
  }

  /** The last 20 input events, oldest first. */
  get recentInput(): ReadonlyArray<InputRecord> {
    return this._recentInput
  }

  recordInput(entry: InputRecord): void {
    this._recentInput.push(entry)
    if (this._recentInput.length > RECENT_INPUT_SIZE) this._recentInput.shift()
  }

  /**
   * Renders `state` and, when the editor has focus, shows its selection in the DOM. While composing,
   * the composing leaf is left to the IME and the DOM selection is not touched. The plugins'
   * decorations are computed for `state` on every update; the composing leaf gets them once the
   * composition ends.
   */
  update(state: EditorState): void {
    if (this.destroyed) return
    const target = this.composing ? this.composition : null
    const selectedNode = state.selection?.node
    const decorations = this.editor.getDecorations(state)
    this.renderer.render(
      state.doc,
      target
        ? { skipLeaf: target.leaf, skipPath: target.path, selectedNode, decorations }
        : { selectedNode, decorations },
    )
    if (!this.composing && this.hasFocus()) this.writeSelection(state.selection)
  }

  focus(): void {
    if (this.destroyed) return
    this.root.focus()
    this.writeSelection(this.editor.state.selection)
  }

  /**
   * Viewport coordinates of the caret position at `point` (left edge, top and bottom of its line), or
   * null when the point has no rendered leaf. A collapsed range can report an all-zero rect (e.g. in an
   * empty leaf), so this falls back to the first client rect, then to the leaf element's left edge.
   */
  coordsAt(point: Point): { left: number; top: number; bottom: number } | null {
    if (this.destroyed) return null
    const leaf = this.renderer.leafAt(point.path)
    if (!leaf) return null
    let range: Range | null = null
    try {
      const pos = modelToDom(this.renderer, point)
      range = this.root.ownerDocument.createRange()
      range.setStart(pos.node, pos.offset)
      range.collapse(true)
    } catch {
      range = null
    }
    const empty = (r: { left: number; top: number; bottom: number }): boolean =>
      r.left === 0 && r.top === 0 && r.bottom === 0
    if (range) {
      const bounding = range.getBoundingClientRect()
      if (!empty(bounding)) return { left: bounding.left, top: bounding.top, bottom: bounding.bottom }
      const first = range.getClientRects()[0]
      if (first && !empty(first)) return { left: first.left, top: first.top, bottom: first.bottom }
    }
    const rect = leaf.getBoundingClientRect()
    return { left: rect.left, top: rect.top, bottom: rect.bottom }
  }

  /**
   * Runs the plugins' `onMount` cleanups in reverse order, then removes every listener and destroys
   * the renderer. A throwing cleanup does not stop the rest; the first error is rethrown at the end.
   */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    const errors: unknown[] = []
    for (const cleanup of this.mountCleanups.splice(0).reverse()) {
      try {
        cleanup()
      } catch (error) {
        errors.push(error)
      }
    }
    for (const dispose of this.disposers.splice(0).reverse()) dispose()
    this.renderer.destroy()
    if (errors.length > 0) throw errors[0]
  }

  /** Attaches a view module; its disposer runs on `destroy`. */
  attach(module: ViewModule): void {
    this.disposers.push(module(this))
  }

  /** Adds a DOM listener that `destroy` removes. */
  listen(target: EventTarget, type: string, fn: (e: Event) => void, options?: AddEventListenerOptions): void {
    target.addEventListener(type, fn, options)
    this.disposers.push(() => target.removeEventListener(type, fn, options))
  }

  /**
   * Makes the model selection match the DOM selection when it is inside the root, dispatching a
   * selection-only tr if they differ. Input handlers call it first: `selectionchange` is async.
   */
  syncSelection(): void {
    if (this.destroyed || this.composing || this.focusIgnored()) return
    const domSel = this.domSelection()
    const anchor = domSel?.anchorNode
    if (!domSel || !anchor || !this.root.contains(anchor)) return
    // The model selection is in a leaf whose node view has not placed its contentDOM yet: the DOM
    // selection cannot show it, and reading a stale one (the caret left where it was when the write
    // was skipped, or one the browser collapsed into the root) would overwrite it. A DOM selection
    // the user moved since, into leaves, is still read.
    if (this.selectionDetached()) {
      const stale = this.staleDomSelection
      if (stale && sameSnapshot(stale, snapshot(domSel))) return
      if (!(this.inLeaf(anchor) && this.inLeaf(domSel.focusNode))) return
    } else {
      this.staleDomSelection = null
    }
    const sel = readDomSelection(this.renderer, domSel)
    // Also covers the async selectionchange fired after our own writes: it maps back to the model.
    if (!sel || sameSelection(sel, this.editor.state.selection)) return
    const tr = this.editor.createTransaction()
    tr.setSelection(sel).setMeta('origin', 'selection').setMeta('addToHistory', false)
    this.editor.dispatch(tr)
  }

  /**
   * Shows the model selection in the DOM again when the editor has focus and is not composing:
   * called when a node view placed its `contentDOM` after the render (e.g. a React portal commit).
   */
  refreshSelection(): void {
    if (this.destroyed || this.composing || !this.hasFocus()) return
    this.writeSelection(this.editor.state.selection)
  }

  // --- internals ---

  /** Whether a point of the model selection is in a rendered leaf that is not inside the root. */
  private selectionDetached(): boolean {
    const sel = this.editor.state.selection
    if (!sel) return false
    return this.renderer.isLeafDetached(sel.anchor.path) || this.renderer.isLeafDetached(sel.focus.path)
  }

  /** Whether `node` is inside a rendered leaf of the root. */
  private inLeaf(node: globalThis.Node | null): boolean {
    let cur: globalThis.Node | null = node
    while (cur && cur !== this.root) {
      if (cur.nodeType === 1 && this.renderer.pathOfLeaf(cur as Element)) return true
      cur = cur.parentNode
    }
    return false
  }

  private onTransaction(state: EditorState, tr: Transaction): void {
    if (this.composition) {
      this.composition = mapComposition(this.composition, tr)
      // The composing text was changed or removed by someone else: give up on this composition (its
      // in-flight text may be lost) rather than let the commit diff overwrite the model; render normally.
      if (!this.composition) this.composing = false
      // Listeners see the final state: with appended trs, render once the path is mapped through all of them.
      if (this.composing && tr.doc !== state.doc) return
    }
    this.update(state)
  }

  /** Focus entering the root from outside it is a plugin focus; moves inside the root are not. */
  private onFocusIn(e: FocusEvent): void {
    if (this.destroyed || this.focusInside) return
    this.focusInside = true
    this.editor.handleFocus(e)
  }

  /** A focusout whose `relatedTarget` is still inside the root is a move inside it, not a blur. */
  private onFocusOut(e: FocusEvent): void {
    if (this.destroyed || !this.focusInside) return
    // Focus events only carry an Element (or null) here; no `instanceof Node`, which fails across realms.
    const next = e.relatedTarget as Node | null
    if (next && this.root.contains(next)) return
    this.focusInside = false
    this.editor.handleBlur(e)
  }

  private domSelection(): globalThis.Selection | null {
    return this.root.ownerDocument.getSelection()
  }

  private hasFocus(): boolean {
    const active = this.root.ownerDocument.activeElement
    if (active && this.root.contains(active)) return true
    const anchor = this.domSelection()?.anchorNode
    return !!anchor && this.root.contains(anchor)
  }

  /** Whether the focus is inside a `data-editor-ignore` element of the root (e.g. a node view's input). */
  private focusIgnored(): boolean {
    return isInIgnoredElement(this, this.root.ownerDocument.activeElement)
  }

  private writeSelection(sel: Selection | null): void {
    // Never take the selection (and the focus) away from an ignored element.
    if (this.focusIgnored()) return
    const domSel = this.domSelection()
    if (!domSel) return
    this.writingSelection = true
    try {
      writeDomSelection(this.renderer, sel, domSel)
    } finally {
      this.writingSelection = false
    }
    // Not shown (its leaf is not placed yet): the DOM selection left as it is is stale.
    this.staleDomSelection = this.selectionDetached() ? snapshot(domSel) : null
  }

  private onSelectionChange(): void {
    if (!this.writingSelection) this.syncSelection()
  }
}
