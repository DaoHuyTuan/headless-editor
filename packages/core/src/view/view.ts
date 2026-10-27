import type { Editor } from '../editor'
import { pointEquals } from '../model/path'
import type { Selection } from '../model/types'
import type { EditorState } from '../state'
import { readDomSelection, writeDomSelection } from './dom-selection'
import { attachInput } from './input'
import { Renderer } from './renderer'

export interface InputRecord {
  inputType: string
  data: string | null
  time: number
}

/** A view module (input, composition, mutation, clipboard) attaches its listeners and returns their disposer. */
export type ViewModule = (view: EditorView) => () => void

const RECENT_INPUT_SIZE = 20

function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (a === null || b === null) return a === b
  return pointEquals(a.anchor, b.anchor) && pointEquals(a.focus, b.focus)
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

  private readonly _recentInput: InputRecord[] = []
  private readonly disposers: (() => void)[] = []
  /** True while the view itself writes the DOM selection. */
  private writingSelection = false
  private destroyed = false

  constructor(
    readonly editor: Editor,
    readonly root: HTMLElement,
  ) {
    this.renderer = new Renderer(root, editor)
    this.renderer.render(editor.state.doc)

    this.disposers.push(editor.on('transaction', ({ editor: ed }) => this.update(ed.state)))
    this.listen(root.ownerDocument, 'selectionchange', () => this.onSelectionChange())
    this.attach(attachInput)
  }

  /** The last 20 input events, oldest first. */
  get recentInput(): ReadonlyArray<InputRecord> {
    return this._recentInput
  }

  recordInput(entry: InputRecord): void {
    this._recentInput.push(entry)
    if (this._recentInput.length > RECENT_INPUT_SIZE) this._recentInput.shift()
  }

  /** Renders `state` and, when the editor has focus, shows its selection in the DOM. */
  update(state: EditorState): void {
    if (this.destroyed) return
    this.renderer.render(state.doc)
    if (this.hasFocus()) this.writeSelection(state.selection)
  }

  focus(): void {
    if (this.destroyed) return
    this.root.focus()
    this.writeSelection(this.editor.state.selection)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const dispose of this.disposers.splice(0).reverse()) dispose()
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
    if (this.destroyed || this.composing) return
    const domSel = this.domSelection()
    const anchor = domSel?.anchorNode
    if (!domSel || !anchor || !this.root.contains(anchor)) return
    const sel = readDomSelection(this.renderer, domSel)
    // Also covers the async selectionchange fired after our own writes: it maps back to the model.
    if (!sel || sameSelection(sel, this.editor.state.selection)) return
    const tr = this.editor.createTransaction()
    tr.setSelection(sel).setMeta('origin', 'selection').setMeta('addToHistory', false)
    this.editor.dispatch(tr)
  }

  // --- internals ---

  private domSelection(): globalThis.Selection | null {
    return this.root.ownerDocument.getSelection()
  }

  private hasFocus(): boolean {
    const active = this.root.ownerDocument.activeElement
    if (active && this.root.contains(active)) return true
    const anchor = this.domSelection()?.anchorNode
    return !!anchor && this.root.contains(anchor)
  }

  private writeSelection(sel: Selection | null): void {
    const domSel = this.domSelection()
    if (!domSel) return
    this.writingSelection = true
    try {
      writeDomSelection(this.renderer, sel, domSel)
    } finally {
      this.writingSelection = false
    }
  }

  private onSelectionChange(): void {
    if (!this.writingSelection) this.syncSelection()
  }
}
