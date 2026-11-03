import { createId } from '../model/id'
import { getNode, isElement, isText } from '../model/node'
import { nearestEditablePoint } from '../model/editable'
import { createSelection, selectionEquals } from '../model/selection'
import type { Data, Doc, ElementNode, Mark, Node, Path, Point, Range, Selection, SelectionRange, TextNode } from '../model/types'
import { applyOp } from '../ops/apply'
import { transformRange, transformSelection } from '../ops/transform'
import type { Operation } from '../ops/types'
import type { Registry } from '../plugin/registry'
import type { EditorState } from '../state'
import * as fragmentEdit from './fragment'
import type { Fragment } from './fragment'
import * as markEdit from './marks'
import { forEachRange, inForEachRange, mapRun } from './ranges'
import type { RangeStep } from './ranges'
import * as textEdit from './text'
import type { DeleteUnit } from './text'

export interface TransactionMeta {
  origin?: 'input' | 'paste' | 'command' | 'history' | 'plugin' | 'selection' | 'load'
  addToHistory?: boolean
  inputType?: string
  /**
   * Set by the Editor on every `appendTransaction` tr whose root was an undo/redo (`'history'`) or
   * was recorded in history (`'record'`): history joins it to that entry instead of recording it.
   */
  appendedTo?: 'history' | 'record'
  [k: string]: unknown
}

/** Fills in missing id/data/marks, recursively. */
function normalizeNode(node: ElementNode | TextNode): Node {
  if (isText(node)) return { ...node, marks: node.marks ?? [] }
  const out: ElementNode = { ...node, id: node.id ?? createId(), data: node.data ?? {} }
  if (node.children) out.children = node.children.map(normalizeNode)
  return out
}

export class Transaction {
  readonly before: EditorState
  readonly registry: Registry
  readonly ops: Operation[] = []
  readonly meta: TransactionMeta = {}
  rejected: string | null = null
  /** Dev mode (the editor's `dev` option): misuse that would otherwise be tolerated throws. */
  readonly dev: boolean

  private _doc: Doc
  private _selection: Selection | null
  private _storedMarks: Mark[] | null

  constructor(state: EditorState, registry: Registry, options: { dev?: boolean } = {}) {
    this.before = state
    this.registry = registry
    this.dev = options.dev ?? false
    // Operations never mutate a doc (they copy along the changed path), so sharing it is safe.
    this._doc = state.doc as Doc
    this._selection = state.selection
    this._storedMarks = state.storedMarks
  }

  get doc(): Doc {
    return this._doc
  }
  get selection(): Selection | null {
    return this._selection
  }
  get storedMarks(): Mark[] | null {
    return this._storedMarks
  }
  get docChanged(): boolean {
    return this.ops.some((op) => op.type !== 'set_selection')
  }
  /** True while a `forEachRange` callback runs. */
  get inForEachRange(): boolean {
    return inForEachRange(this)
  }

  /**
   * Runs `fn` once per selection range, in document order, on this tr; each range is mapped through
   * the ops added before its call. The selection becomes the returned ranges (null drops one),
   * normalized, with `main` kept on its range. Stored marks survive the per-range selection moves.
   * See `forEachRange` in `./ranges`.
   */
  forEachRange(fn: RangeStep): this {
    forEachRange(this, fn)
    return this
  }

  apply(op: Operation): this {
    if (op.type === 'set_selection') {
      this._selection = op.selection
    } else {
      this._doc = applyOp(this._doc, op)
      if (this._selection) this._selection = this.mapSelection(this._selection, op)
      mapRun(this, op)
    }
    this.ops.push(op)
    return this
  }

  /**
   * `sel` mapped through `op` (just applied), every range on its own. Live-edit re-homing lives here;
   * `transformSelection` only maps and drops. With several ranges, a range that can't be mapped (a
   * point's text was removed) becomes a caret at the nearest editable point of the new doc
   * (`nearestEditablePoint` at the removed path), even when every range was lost; it is dropped only
   * if there is none, and the selection is null only when no range is left. A single range keeps the
   * plain rule: null when it can't be mapped. (Several ranges never hold a node range.)
   */
  private mapSelection(sel: Selection, op: Operation): Selection | null {
    if (sel.ranges.length === 1) return transformSelection(sel, op)
    let target: Point | null | undefined
    const rehome = () => {
      if (target === undefined)
        target = op.type === 'remove_node' ? nearestEditablePoint(this._doc, this.registry, op.path) : null
      return target
    }
    const out: SelectionRange[] = []
    let main = 0
    sel.ranges.forEach((range, i) => {
      let next = transformRange(range, op)
      if (!next) {
        // Collapsed at the re-homed point, so a half-lost range does not stretch across blocks.
        const at = rehome()
        if (!at) return
        next = { anchor: at, focus: at }
      }
      if (i <= sel.main) main = out.length
      out.push(next)
    })
    return out.length === 0 ? null : createSelection(out, main)
  }

  /**
   * Normalizes `sel` (`createSelection`: sorted, colliding ranges merged, `main` kept on its range).
   * No-op when equal to the current selection (every range's anchor, focus and `node`, and `main` compared).
   */
  setSelection(sel: Selection | null): this {
    if (sel) sel = createSelection(sel.ranges, sel.main)
    if (selectionEquals(sel, this._selection)) return this
    this.apply({ type: 'set_selection', selection: sel, prevSelection: this._selection })
    this._storedMarks = null
    return this
  }

  setStoredMarks(marks: Mark[] | null): this {
    this._storedMarks = marks
    return this
  }

  setMeta(key: string, value: unknown): this {
    this.meta[key] = value
    return this
  }

  /**
   * Inserts `node`, validating the data of every element in its subtree (registered types only:
   * unknown types and their subtrees pass unchanged, so loading stays lossless). The first failure sets `rejected` and emits
   * nothing; validated output (e.g. defaults) is what gets stored.
   */
  insertNode(path: Path, node: ElementNode | TextNode): this {
    const normalized = normalizeNode(node)
    const checked = this.validateSubtree(normalized)
    if (checked === null) return this
    return this.apply({ type: 'insert_node', path, node: checked })
  }

  /** The node with validated data throughout, or null (and `rejected` set) at the first invalid element. */
  private validateSubtree(node: Node): Node | null {
    // Unknown types are opaque: like `coerceDoc`, nothing below them is validated.
    if (isText(node) || !this.registry.node(node.type)) return node
    const result = this.registry.validateData(node.type, node.data)
    if (!result.ok) {
      this.rejected = result.message
      return null
    }
    const out: ElementNode = { ...node, data: result.data }
    if (node.children) {
      const children: Node[] = []
      for (const child of node.children) {
        const checked = this.validateSubtree(child)
        if (checked === null) return null
        children.push(checked)
      }
      out.children = children
    }
    return out
  }

  removeNode(path: Path): this {
    return this.apply({ type: 'remove_node', path, node: getNode(this._doc, path) })
  }

  /**
   * Deletes every selection range and inserts `text` there; each caret ends after its insert. With
   * `at`, only there: the range it touches (else the main one) becomes the caret after the insert,
   * the other ranges are mapped. Inside `forEachRange`, pass the callback's range.
   */
  insertText(text: string, at?: SelectionRange | Range): this {
    textEdit.insertText(this, text, at)
    return this
  }

  /**
   * Deletes `range` (default: every selection range), merging across blocks; the caret ends at its
   * start. With `range`, the other selection ranges are mapped (as for `insertText` with `at`).
   */
  deleteRange(range?: Range): this {
    textEdit.deleteRange(this, range)
    return this
  }

  /**
   * Deletes one `unit` before every caret (a non-empty range is deleted instead); with `at`, only
   * there. With several ranges, a caret next to an opaque block does nothing for this press (with one,
   * the block is node-selected).
   */
  deleteBackward(unit: DeleteUnit = 'character', at?: SelectionRange | Range): this {
    textEdit.deleteBackward(this, unit, at)
    return this
  }

  /** As `deleteBackward`, after every caret. */
  deleteForward(unit: DeleteUnit = 'character', at?: SelectionRange | Range): this {
    textEdit.deleteForward(this, unit, at)
    return this
  }

  /**
   * Inserts the block-level `node` at every selection range (replacing a selected node or an empty
   * block, else before/after/splitting the caret's block; copies after the first get fresh ids); each
   * caret ends in the editable text after its node. With `at`, only there. Invalid data leaves the tr
   * `rejected`.
   */
  insertBlockNode(node: ElementNode, at?: SelectionRange | Range): this {
    textEdit.insertBlockNode(this, node, at)
    return this
  }

  /**
   * Inserts the inline element `node` (e.g. an inline atom) at the caret, replacing the selection;
   * the caret ends right after it. Its id is refreshed when already in the doc. Does nothing in a
   * text-only block or for a type that is not a registered inline type; invalid data leaves the tr `rejected`.
   */
  insertInlineNode(node: ElementNode): this {
    fragmentEdit.insertInlineNode(this, node)
    return this
  }

  /**
   * Splits the block at every caret (after deleting each range); each caret ends at the start of its
   * new block. With `at`, only there.
   */
  splitBlock(at?: SelectionRange | Range): this {
    textEdit.splitBlock(this, at)
    return this
  }

  /**
   * Deletes `at` (default: the selection) and inserts `fragment` at the caret, giving inserted
   * elements fresh ids where theirs already exist; the caret ends after the inserted content. A node
   * selection (without `at`) is replaced in place: the content goes where the node was.
   */
  insertFragment(fragment: Fragment, at?: Range): this {
    fragmentEdit.insertFragment(this, fragment, at)
    return this
  }

  /** Adds `mark` over `range` (default: the selection); a same-type mark with other data is replaced. */
  addMark(mark: Mark, range?: Range): this {
    markEdit.addMark(this, mark, range)
    return this
  }

  /** Removes marks of `type` over `range` (default: the selection). */
  removeMark(type: string, range?: Range): this {
    markEdit.removeMark(this, type, range)
    return this
  }

  /** Removes the mark if active on the whole selection, else adds it; a caret toggles stored marks. */
  toggleMark(type: string, data?: Data): this {
    markEdit.toggleMark(this, type, data)
    return this
  }

  setNodeData(path: Path, partial: Data): this {
    const node = getNode(this._doc, path)
    if (!isElement(node)) throw new Error(`Expected an element at [${path}]`)
    const result = this.registry.validateData(node.type, { ...node.data, ...partial })
    if (!result.ok) {
      this.rejected = result.message
      return this
    }
    return this.apply({ type: 'set_node_data', path, data: result.data, prevData: node.data })
  }
}
