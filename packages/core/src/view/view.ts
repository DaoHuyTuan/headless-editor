import type { Editor } from '../editor'
import { nextPath, pointEquals } from '../model/path'
import { mainRange } from '../model/selection'
import type { Path, Point, Selection, SelectionRange } from '../model/types'
import { transformPath } from '../ops/transform'
import type { Operation } from '../ops/types'
import type { EditorState } from '../state'
import type { Transaction } from '../transaction/transaction'
import { attachClipboard } from './clipboard'
import { attachComposition } from './composition'
import { attachDrop } from './drop'
import { hasEditorFocus } from './focus'
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

/** The attributes the renderer sets on the root (besides `white-space`). */
const ROOT_ATTRS = ['contenteditable', 'role', 'aria-multiline']

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

/** Compared by main range: the DOM shows only main, so a DOM selection at it keeps the other ranges. */
function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (a === null || b === null) return a === b
  return sameRange(mainRange(a), mainRange(b))
}

function sameRange(a: SelectionRange, b: SelectionRange): boolean {
  if (pointEquals(a.anchor, b.anchor) && pointEquals(a.focus, b.focus)) {
    return a.node === undefined || b.node === undefined ? a.node === b.node : samePath(a.node, b.node)
  }
  return false
}

/**
 * Glues an editor to a contenteditable root: renders every transaction, keeps the DOM selection and
 * the model selection in sync, and owns the DOM listeners. `destroy` removes all of them and makes
 * the root non-editable again (the rendered content stays in place).
 *
 * A view is bound to one root for its lifetime. Remounting (a new view, e.g. `editor.mount` after
 * `unmount`, or on another element) always renders from scratch, on the same root too: the old
 * view's node views were destroyed with it, so its DOM is not adopted; the new render replaces the
 * root's children. `editor.mount` on the root it is already mounted on keeps the current view.
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
  /** A primary button press in the root, until its `mouseup`: the click then picks one range. */
  private pressed = false
  /** The root's own values of what the renderer sets on it, restored on `destroy`. */
  private readonly rootBefore: { attrs: Record<string, string | null>; whiteSpace: string; hadStyle: boolean }

  constructor(
    readonly editor: Editor,
    readonly root: HTMLElement,
  ) {
    this.rootBefore = {
      attrs: Object.fromEntries(ROOT_ATTRS.map((name) => [name, root.getAttribute(name)])),
      whiteSpace: root.style.whiteSpace,
      hadStyle: root.hasAttribute('style'),
    }
    this.renderer = new Renderer(root, editor)
    // The initial selection is shown too: a node selection marks its node, as later renders do.
    const selectedNode = editor.state.selection ? mainRange(editor.state.selection).node : undefined
    this.renderer.render(editor.state.doc, { selectedNode, decorations: editor.getDecorations(editor.state) })

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
    // A click on the main caret moves no DOM selection, so no selectionchange collapses the other
    // ranges: the click's mouseup does (spec §5.6).
    this.listen(root, 'mousedown', (e) => {
      if ((e as MouseEvent).button === 0) this.pressed = true
    })
    this.listen(root, 'mouseup', () => {
      if (!this.pressed) return
      this.pressed = false
      this.syncSelection(true)
    })
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
    const selectedNode = state.selection ? mainRange(state.selection).node : undefined
    const decorations = this.editor.getDecorations(state)
    this.renderer.render(
      state.doc,
      target
        ? { skipLeaf: target.leaf, skipPath: target.path, selectedNode, decorations }
        : { selectedNode, decorations },
    )
    if (!this.composing && hasEditorFocus(this)) this.writeSelection(state.selection)
  }

  focus(): void {
    if (this.destroyed) return
    this.root.focus()
    this.writeSelection(this.editor.state.selection)
  }

  /**
   * Viewport coordinates of the caret position at `point` (left edge, top and bottom of its line).
   * Only rects with a height count: the collapsed range's bounding rect, then its first client rect,
   * then the character at the offset (its left edge; the character before it, right edge, at the
   * end of the text), then the leaf's first line box, then the leaf's bounding rect.
   *
   * Null when the point has no rendered leaf, when its leaf is not placed in the root yet (a node
   * view that has not mounted its `contentDOM`, e.g. before `<NodeContent />` commits), or when
   * nothing measured has a height (not laid out, `display: none`): callers hide what they position
   * rather than place it at a made-up rect.
   */
  coordsAt(point: Point): { left: number; top: number; bottom: number } | null {
    if (this.destroyed) return null
    const leaf = this.renderer.leafAt(point.path)
    if (!leaf) return null
    // Only a rect with a height locates a line: a zero-height one (a collapsed range in an empty or
    // not laid-out leaf) is skipped.
    const line = (r: DOMRect | undefined): r is DOMRect => !!r && r.bottom > r.top
    const at = (r: DOMRect, left = r.left) => ({ left, top: r.top, bottom: r.bottom })
    const doc = this.root.ownerDocument
    let pos: { node: globalThis.Node; offset: number } | null = null
    try {
      pos = modelToDom(this.renderer, point)
    } catch {
      pos = null
    }
    if (pos) {
      const range = doc.createRange()
      range.setStart(pos.node, pos.offset)
      range.collapse(true)
      const bounding = range.getBoundingClientRect()
      if (line(bounding)) return at(bounding)
      const first = Array.from(range.getClientRects()).find(line)
      if (first) return at(first)
      // The character at the offset (its left edge), or before it at the end of the text (its right
      // edge): its line, not the whole (possibly wrapped) leaf.
      const length = pos.node.nodeType === 3 ? (pos.node as Text).length : 0
      if (length > 0) {
        const char = doc.createRange()
        const after = pos.offset < length
        char.setStart(pos.node, after ? pos.offset : pos.offset - 1)
        char.setEnd(pos.node, after ? pos.offset + 1 : pos.offset)
        const rect = char.getBoundingClientRect()
        if (line(rect)) return at(rect, after ? rect.left : rect.right)
      }
    }
    // The leaf's first line box: its bounding rect would span every line of a wrapped leaf.
    const box = Array.from(leaf.getClientRects()).find(line)
    if (box) return at(box)
    const rect = leaf.getBoundingClientRect()
    return line(rect) ? at(rect) : null
  }

  /**
   * Runs the plugins' `onMount` cleanups in reverse order, then removes every listener, destroys
   * the renderer (and its node views) and gives the root back its own `contenteditable`, `role`,
   * `aria-multiline` and `white-space`; the rendered content stays. A throwing cleanup does not stop
   * the rest; the first error is rethrown at the end. Idempotent.
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
    this.restoreRoot()
    if (errors.length > 0) throw errors[0]
  }

  /**
   * Attaches a view module; its disposer runs on `destroy`, or earlier (once) through the returned
   * function. After `destroy` this is a no-op: the module is not called and the result is a no-op.
   */
  attach(module: ViewModule): () => void {
    if (this.destroyed) return () => {}
    return this.track(module(this))
  }

  /**
   * Adds a DOM listener that `destroy` removes, or earlier (once) the returned function. After
   * `destroy` this is a no-op: nothing is added and the result is a no-op.
   */
  listen(target: EventTarget, type: string, fn: (e: Event) => void, options?: AddEventListenerOptions): () => void {
    if (this.destroyed) return () => {}
    target.addEventListener(type, fn, options)
    return this.track(() => target.removeEventListener(type, fn, options))
  }

  /**
   * Makes the model selection match the DOM selection when it is inside the root, dispatching a
   * selection-only tr if they differ. Input handlers call it first: `selectionchange` is async. A
   * DOM selection away from the main range replaces the selection with that one range (spec §5.6).
   * With `click` (the end of a click in the root), a selection of several ranges collapses to the
   * DOM one even when it is the main range.
   */
  syncSelection(click = false): void {
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
    const current = this.editor.state.selection
    if (!sel || (sameSelection(sel, current) && !(click && current && current.ranges.length > 1))) return
    const tr = this.editor.createTransaction()
    tr.setSelection(sel).setMeta('origin', 'selection').setMeta('addToHistory', false)
    this.editor.dispatch(tr)
  }

  /**
   * Shows the model selection in the DOM again when the editor has focus and is not composing:
   * called when a node view placed its `contentDOM` after the render (e.g. a React portal commit).
   */
  refreshSelection(): void {
    if (this.destroyed || this.composing || !hasEditorFocus(this)) return
    this.writeSelection(this.editor.state.selection)
  }

  // --- internals ---

  /** Registers `dispose` for `destroy` and returns a function running it early, once. */
  private track(dispose: () => void): () => void {
    let done = false
    const once = (): void => {
      if (done) return
      done = true
      const i = this.disposers.indexOf(once)
      if (i >= 0) this.disposers.splice(i, 1)
      dispose()
    }
    this.disposers.push(once)
    return once
  }

  /** Gives the root back the attributes and `white-space` the renderer set on it, as they were before. */
  private restoreRoot(): void {
    const { root, rootBefore } = this
    for (const [name, value] of Object.entries(rootBefore.attrs)) {
      if (value === null) root.removeAttribute(name)
      else root.setAttribute(name, value)
    }
    root.style.whiteSpace = rootBefore.whiteSpace
    if (!rootBefore.hadStyle && root.getAttribute('style') === '') root.removeAttribute('style')
  }

  /** Whether a point of the model selection is in a rendered leaf that is not inside the root. */
  private selectionDetached(): boolean {
    const sel = this.editor.state.selection
    if (!sel) return false
    const range = mainRange(sel)
    return this.renderer.isLeafDetached(range.anchor.path) || this.renderer.isLeafDetached(range.focus.path)
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
