import { createId } from '../model/id'
import { deepEqualJson, getNode, isElement, isText } from '../model/node'
import type { Data, Doc, ElementNode, Json, Mark, Node, Path, Range, Selection, TextNode } from '../model/types'
import { applyOp } from '../ops/apply'
import { transformSelection } from '../ops/transform'
import type { Operation } from '../ops/types'
import type { Registry } from '../plugin/registry'
import type { EditorState } from '../state'
import * as fragmentEdit from './fragment'
import type { Fragment } from './fragment'
import * as markEdit from './marks'
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

function selectionEquals(a: Selection | null, b: Selection | null): boolean {
  if (a === null || b === null) return a === b
  return deepEqualJson(a as unknown as Json, b as unknown as Json)
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

  private _doc: Doc
  private _selection: Selection | null
  private _storedMarks: Mark[] | null

  constructor(state: EditorState, registry: Registry) {
    this.before = state
    this.registry = registry
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

  apply(op: Operation): this {
    if (op.type === 'set_selection') {
      this._selection = op.selection
    } else {
      this._doc = applyOp(this._doc, op)
      if (this._selection) this._selection = transformSelection(this._selection, op)
    }
    this.ops.push(op)
    return this
  }

  /** No-op when equal to the current selection (anchor, focus and `node` compared). */
  setSelection(sel: Selection | null): this {
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

  /** Deletes the selection (or `at`) and inserts `text`; the caret ends after it. */
  insertText(text: string, at?: Selection | Range): this {
    textEdit.insertText(this, text, at)
    return this
  }

  /** Deletes `range`, merging across blocks; the caret ends at its start. */
  deleteRange(range: Range): this {
    textEdit.deleteRange(this, range)
    return this
  }

  deleteBackward(unit: DeleteUnit = 'character'): this {
    textEdit.deleteBackward(this, unit)
    return this
  }

  deleteForward(unit: DeleteUnit = 'character'): this {
    textEdit.deleteForward(this, unit)
    return this
  }

  /**
   * Inserts the block-level `node` at the selection (replacing a selected node or an empty block,
   * else before/after/splitting the caret's block); the caret ends in the editable text after it.
   * Invalid data leaves the tr `rejected`.
   */
  insertBlockNode(node: ElementNode): this {
    textEdit.insertBlockNode(this, node)
    return this
  }

  /** Splits the block at the caret (after deleting the selection); the caret ends in the new block. */
  splitBlock(): this {
    textEdit.splitBlock(this)
    return this
  }

  /**
   * Deletes `at` (default: the selection) and inserts `fragment` at the caret, giving inserted
   * elements fresh ids where theirs already exist; the caret ends after the inserted content.
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
