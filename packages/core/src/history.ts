import type { Editor } from './editor'
import { findPathById } from './model/find'
import { deepEqualJson, getNode, isElement } from './model/node'
import type { Data, Doc, ElementNode, Node, Selection } from './model/types'
import { applyOp } from './ops/apply'
import { invertOp } from './ops/invert'
import { rebaseBoth } from './ops/rebase'
import { transformSelection } from './ops/transform'
import type { Operation } from './ops/types'
import { definePlugin } from './plugin/define'
import type { Command, PluginContext } from './plugin/types'
import type { EditorState } from './state'
import type { Transaction } from './transaction/transaction'

export interface HistoryEntry {
  /** Doc ops of the recorded tr(s), normalization ops included, in application order. */
  ops: Operation[]
  selectionBefore: Selection | null
  selectionAfter: Selection | null
  time: number
  /** 'insert' / 'delete' for groupable input; anything else never groups. */
  kind: string
}

export interface HistoryState {
  undo: HistoryEntry[]
  redo: HistoryEntry[]
}

export interface HistoryOptions {
  groupDelay: number
  now: () => number
}

type HistoryAction = 'undo' | 'redo'

const EMPTY: HistoryState = { undo: [], redo: [] }

function entryKind(tr: Transaction): string {
  // A fired input rule is its own step: never merged into the typing before or after it.
  if (tr.meta.origin !== 'input' || tr.meta.inputRule === true) return 'other'
  const inputType = tr.meta.inputType ?? ''
  if (inputType.startsWith('insert')) return 'insert'
  if (inputType.startsWith('delete')) return 'delete'
  return 'other'
}

function isGroupable(kind: string): boolean {
  return kind === 'insert' || kind === 'delete'
}

/** Keys a data-only change sets (`set`) or deletes (`unset`). */
interface DataPatch {
  set: Data
  unset: string[]
}

interface Rewrite {
  id: string
  patch: DataPatch
}

type SetNodeDataOp = Extract<Operation, { type: 'set_node_data' }>

function diffData(prevData: Data, data: Data): DataPatch {
  const set: Data = {}
  for (const [k, v] of Object.entries(data)) {
    if (!(k in prevData) || !deepEqualJson(prevData[k]!, v)) set[k] = v
  }
  return { set, unset: Object.keys(prevData).filter((k) => !(k in data)) }
}

function patchData(data: Data, patches: DataPatch[]): Data {
  let out = data
  for (const { set, unset } of patches) {
    out = { ...out, ...set }
    for (const k of unset) delete out[k]
  }
  return out
}

/** `node` with the data of every element listed in `byId` patched (same reference when untouched). */
function patchNode(node: Node, byId: Map<string, DataPatch[]>): Node {
  if (!isElement(node)) return node
  const patches = byId.get(node.id)
  let children = node.children
  if (children) {
    const next = children.map((c) => patchNode(c, byId))
    if (next.some((c, i) => c !== children![i])) children = next
  }
  if (!patches && children === node.children) return node
  const out: ElementNode = { ...node, data: patches ? patchData(node.data, patches) : node.data }
  if (children) out.children = children
  return out
}

/**
 * The element id each stored `set_node_data` op targets. Ops are path-addressed, so this replays
 * the stacks from `doc` (the doc they are consistent with): undo entries backwards, redo forwards.
 */
function setNodeDataTargets(stacks: HistoryState, doc: Doc): Map<SetNodeDataOp, string> {
  const targets = new Map<SetNodeDataOp, string>()
  const note = (d: Doc, op: Operation) => {
    if (op.type !== 'set_node_data') return
    const node = getNode(d, op.path)
    if (isElement(node)) targets.set(op, node.id)
  }
  let d = doc
  for (let e = stacks.undo.length - 1; e >= 0; e--) {
    const ops = stacks.undo[e]!.ops
    for (let i = ops.length - 1; i >= 0; i--) {
      note(d, ops[i]!)
      d = applyOp(d, invertOp(ops[i]!))
    }
  }
  d = doc
  for (let e = stacks.redo.length - 1; e >= 0; e--) {
    for (const op of stacks.redo[e]!.ops) {
      note(d, op)
      d = applyOp(d, op)
    }
  }
  return targets
}

function patchOp(op: Operation, byId: Map<string, DataPatch[]>, targets: Map<SetNodeDataOp, string>): Operation {
  switch (op.type) {
    case 'insert_node':
    case 'remove_node': {
      const node = patchNode(op.node, byId)
      return node === op.node ? op : { ...op, node }
    }
    case 'split_node':
    case 'merge_node': {
      const props = op.properties as Partial<ElementNode>
      const patches = typeof props.id === 'string' ? byId.get(props.id) : undefined
      if (!patches || !props.data) return op
      return { ...op, properties: { ...props, data: patchData(props.data, patches) } }
    }
    case 'set_node_data': {
      // Both sides get the patch: the op still changes the keys it changed, and never brings back old values.
      const id = targets.get(op)
      const patches = id === undefined ? undefined : byId.get(id)
      if (!patches) return op
      return { ...op, data: patchData(op.data, patches), prevData: patchData(op.prevData, patches) }
    }
    default:
      return op
  }
}

/**
 * Applies `rewrites` to every payload in both stacks that carries the element's data: node subtrees,
 * split/merge properties (by id) and `set_node_data` ops (by the id their path resolves to from `doc`).
 */
function rewriteStacks(prev: HistoryState, doc: Doc, rewrites: Rewrite[]): HistoryState {
  if (rewrites.length === 0 || (prev.undo.length === 0 && prev.redo.length === 0)) return prev
  const byId = new Map<string, DataPatch[]>()
  for (const { id, patch } of rewrites) byId.set(id, [...(byId.get(id) ?? []), patch])
  let targets: Map<SetNodeDataOp, string>
  try {
    targets = setNodeDataTargets(prev, doc)
  } catch {
    return EMPTY // stacks not replayable from `doc`: fall back to the M1 behaviour
  }
  const entry = (e: HistoryEntry): HistoryEntry => {
    const ops = e.ops.map((op) => patchOp(op, byId, targets))
    return ops.every((op, i) => op === e.ops[i]) ? e : { ...e, ops }
  }
  return { undo: prev.undo.map(entry), redo: prev.redo.map(entry) }
}

/** The inverse of a recorded op sequence: inverted ops, in reverse order. */
function invertAll(ops: Operation[]): Operation[] {
  return ops.map(invertOp).reverse()
}

/** `sel` mapped through `ops`; `undefined` when it can't be (a point's text node was removed). */
function mapSelection(sel: Selection | null, ops: Operation[]): Selection | null | undefined {
  let out = sel
  for (const op of ops) {
    if (out === null) return null
    const next = transformSelection(out, op)
    if (!next) return undefined
    out = next
  }
  return out
}

/**
 * Rebases one stack over `over`, the doc ops of an outside-history tr that start from the current doc.
 *
 * Both stacks' top entries meet at the current doc: an undo entry's inverse ops start there (then
 * the next entry's inverse, going down), and so do a redo entry's forward ops. So each stack is one
 * op sequence starting at the current doc, concurrent with `over`: walking it top-down, each
 * entry's ops are rebased over `over` (`rebaseBoth`), and `over` is carried past the entry for the
 * one below. Selections map through `over` at their end of the entry.
 *
 * The first entry that can't be rebased (see `rebaseOps`) is dropped along with every entry below
 * it: those only make sense after it. Entries above it stay.
 */
function rebaseStack(stack: HistoryEntry[], over: Operation[], action: HistoryAction): HistoryEntry[] {
  const out: HistoryEntry[] = []
  let rest = over
  for (let i = stack.length - 1; i >= 0; i--) {
    const e = stack[i]!
    const ops = action === 'undo' ? invertAll(e.ops) : e.ops
    // The selection at the current-doc end of the entry, and the one at its far end.
    const near = mapSelection(action === 'undo' ? e.selectionAfter : e.selectionBefore, rest)
    const res = rebaseBoth(ops, rest)
    if (!res || near === undefined) break
    const far = mapSelection(action === 'undo' ? e.selectionBefore : e.selectionAfter, res.over)
    if (far === undefined) break
    rest = res.over
    const [selectionBefore, selectionAfter] = action === 'undo' ? [far, near] : [near, far]
    out.push({ ...e, ops: action === 'undo' ? invertAll(res.ops) : res.ops, selectionBefore, selectionAfter })
  }
  return out.reverse()
}

function isHistoryRewrite(v: unknown): v is { id: string; data: Data } {
  if (typeof v !== 'object' || v === null) return false
  const r = v as { id?: unknown; data?: unknown }
  return typeof r.id === 'string' && typeof r.data === 'object' && r.data !== null && !Array.isArray(r.data)
}

/**
 * Joins an appended tr (ops `a`, taking the doc from D to D') to the entries around the current doc.
 *
 * Invariant: the top undo entry's ops end at the current doc, and the top redo entry's ops start
 * from it. The append moves that boundary state from D to D', so:
 * - top undo entry U: `U.ops := [...U.ops, ...a]` (it now ends at D'; undoing it inverts `a` first);
 * - top redo entry R: `R.ops := [...inverse(a), ...R.ops]` (it now starts from D'; redoing it
 *   first takes the doc back to D, then re-applies its own ops),
 * with `inverse(a)` = the inverted ops of `a`, in reverse order. Both entries' selections at the
 * boundary become the appended tr's selection.
 *
 * - `'record'` root: U is the entry just recorded (the redo stack is empty), so the append simply
 *   becomes part of that step.
 * - `'history'` root (undo): R is the entry just undone, U the one below it. A later redo of R first
 *   reverts the append, then redoes; undoing U reverts the append too. (redo: U is the entry just
 *   redone, R the next one.) Neither stack is cleared, so undo→redo cycles stay op-consistent
 *   however many times the append fires, and each fold only grows the entries it touches.
 *
 * `kind` and `time` are left alone, so grouping of later input is unaffected.
 */
function joinAppended(prev: HistoryState, tr: Transaction): HistoryState {
  return joinOps(
    prev,
    tr.ops.filter((op) => op.type !== 'set_selection'),
    tr.selection,
  )
}

/** The fold of `joinAppended`, for doc ops `ops` that moved the boundary doc, ending at `selection`. */
function joinOps(prev: HistoryState, ops: Operation[], selection: Selection | null): HistoryState {
  const u = prev.undo[prev.undo.length - 1]
  const r = prev.redo[prev.redo.length - 1]
  const inverse = ops.map(invertOp).reverse()
  return {
    undo: u ? [...prev.undo.slice(0, -1), { ...u, ops: [...u.ops, ...ops], selectionAfter: selection }] : prev.undo,
    redo: r ? [...prev.redo.slice(0, -1), { ...r, ops: [...inverse, ...r.ops], selectionBefore: selection }] : prev.redo,
  }
}

function applyHistory(prev: HistoryState, tr: Transaction, options: HistoryOptions): HistoryState {
  const appended = tr.meta.addToHistory !== false && (tr.meta.appendedTo === 'record' || tr.meta.appendedTo === 'history')
  if (!tr.docChanged) {
    if (tr.meta.historyClear === true) return EMPTY
    const rewrite = tr.meta.historyRewrite
    // Only for elements outside the doc: patching the stacks of one in the doc would desync them.
    if (isHistoryRewrite(rewrite) && findPathById(tr.doc, rewrite.id) === null)
      return rewriteStacks(prev, tr.doc, [{ id: rewrite.id, patch: { set: rewrite.data, unset: [] } }])
    // A selection-only append still moves the selection the joined step restores.
    if (appended) return joinAppended(prev, tr)
    return prev
  }

  // With nothing to join (no stacks), the change cannot desync anything: fall through to recording.
  if (appended && (prev.undo.length > 0 || prev.redo.length > 0)) return joinAppended(prev, tr)

  if (tr.meta.origin === 'history') {
    const action = tr.meta.historyAction as HistoryAction | undefined
    const [from, to] = action === 'redo' ? [prev.redo, prev.undo] : [prev.undo, prev.redo]
    const entry = from[from.length - 1]
    if (!entry || (action !== 'undo' && action !== 'redo')) return prev
    const rest = from.slice(0, -1)
    const moved = [...to, entry]
    let undo = action === 'undo' ? rest : moved
    const redo = action === 'undo' ? moved : rest
    // Nothing typed after an undo/redo may merge into the entry now on top of the undo stack.
    const top = undo[undo.length - 1]
    if (top && top.time !== -Infinity) undo = [...undo.slice(0, -1), { ...top, time: -Infinity }]
    // The tr is the entry's ops (inverted and reversed for undo), then whatever normalization added:
    // a rebased entry can land on a doc that is not normalized (e.g. two adjacent plain text nodes).
    const docOps = tr.ops.filter((op) => op.type !== 'set_selection')
    const own = action === 'undo' ? invertAll(entry.ops) : entry.ops
    if (docOps.length < own.length || !own.every((op, i) => deepEqualJson(op as never, docOps[i] as never))) return EMPTY
    const extra = docOps.slice(own.length)
    // Fold the normalization ops in like an appended tr: on undo, the entry below (new undo top) ends
    // with them and the moved redo entry first reverts them; on redo, the moved entry (new undo top)
    // ends with them and the next redo entry first reverts them.
    return extra.length === 0 ? { undo, redo } : joinOps({ undo, redo }, extra, tr.selection)
  }

  if (tr.meta.addToHistory === false) {
    // Data-only changes keep the structure, so the stacks stay valid once their payloads agree.
    const docOps = tr.ops.filter((op) => op.type !== 'set_selection')
    if (docOps.every((op) => op.type === 'set_node_data')) {
      const rewrites: Rewrite[] = []
      for (const op of docOps as Extract<Operation, { type: 'set_node_data' }>[]) {
        const node = getNode(tr.before.doc, op.path)
        if (isElement(node)) rewrites.push({ id: node.id, patch: diffData(op.prevData, op.data) })
      }
      return rewriteStacks(prev, tr.before.doc as Doc, rewrites)
    }
    // Structural changes: map both stacks through them, dropping what can't be rebased.
    const undo = rebaseStack(prev.undo, docOps, 'undo')
    // Typing right after must not merge into the rebased top entry: it is its own step.
    const top = undo[undo.length - 1]
    if (top && top.time !== -Infinity) undo[undo.length - 1] = { ...top, time: -Infinity }
    return { undo, redo: rebaseStack(prev.redo, docOps, 'redo') }
  }

  const ops = tr.ops.filter((op) => op.type !== 'set_selection')
  const time = options.now()
  const kind = entryKind(tr)
  const last = prev.undo[prev.undo.length - 1]
  if (last && isGroupable(kind) && last.kind === kind && time - last.time <= options.groupDelay) {
    const merged: HistoryEntry = { ...last, ops: [...last.ops, ...ops], selectionAfter: tr.selection, time }
    return { undo: [...prev.undo.slice(0, -1), merged], redo: [] }
  }
  const entry: HistoryEntry = { ops, selectionBefore: tr.before.selection, selectionAfter: tr.selection, time, kind }
  return { undo: [...prev.undo, entry], redo: [] }
}

/** Fills `tr` with the undo (inverted ops, reversed) or redo of the top entry. False when there is none. */
function fillHistoryTr(action: HistoryAction, tr: Transaction, state: EditorState): boolean {
  const stacks = (state.pluginStates.get('history') as HistoryState | undefined) ?? EMPTY
  const stack = action === 'undo' ? stacks.undo : stacks.redo
  const entry = stack[stack.length - 1]
  if (!entry) return false
  if (action === 'undo') {
    for (let i = entry.ops.length - 1; i >= 0; i--) tr.apply(invertOp(entry.ops[i]!))
    tr.setSelection(entry.selectionBefore)
  } else {
    for (const op of entry.ops) tr.apply(op)
    tr.setSelection(entry.selectionAfter)
  }
  tr.meta.origin = 'history'
  tr.meta.historyAction = action
  return true
}

/** Undo/redo on a fresh tr, dispatched (keymap and intents; commands go through the Editor). */
function runHistory(action: HistoryAction, ctx: PluginContext<HistoryOptions, HistoryState>): boolean {
  const tr = ctx.editor.createTransaction()
  if (!fillHistoryTr(action, tr, ctx.editor.state)) return false
  ctx.editor.dispatch(tr)
  return true
}

/**
 * Rewrites the stored history data of element `id` (merging `data` into every stored copy), for an
 * element that is not in the doc (e.g. an undone image whose upload finished). For one in the doc,
 * use `setNodeData` with `addToHistory: false` instead: history rewrites itself from that.
 */
export function rewriteHistoryData(editor: Editor, id: string, data: Data): void {
  const tr = editor.createTransaction()
  tr.meta.origin = 'plugin'
  tr.meta.addToHistory = false
  tr.meta.historyRewrite = { id, data }
  editor.dispatch(tr)
}

/**
 * Empties both history stacks (a tr with no doc ops and meta `historyClear: true`), e.g. when stored
 * entries would bring back content that can no longer be valid (an image whose upload failed while
 * it was undone or deleted).
 */
export function clearHistory(editor: Editor): void {
  const tr = editor.createTransaction()
  tr.meta.origin = 'plugin'
  tr.meta.addToHistory = false
  tr.meta.historyClear = true
  editor.dispatch(tr)
}

/**
 * Built-in undo/redo plugin, prepended by the Editor unless `history: false`.
 * Records every doc-changing tr (as finally normalized); consecutive input of the same kind
 * within `groupDelay` ms is one step. Trs with `addToHistory: false` don't record: data-only ones
 * (all `set_node_data`) rewrite the stored payloads of the changed elements; structural ones map both
 * stacks through their ops (`rebaseStack`), dropping entries that can't be rebased and all below them.
 * `appendTransaction` trs (meta `appendedTo`) join the triggering step (see `joinAppended`).
 */
export const historyPlugin = definePlugin({
  name: 'history',
  priority: 0,
  options: { groupDelay: 500, now: () => Date.now() } as HistoryOptions,
  state: {
    init: (): HistoryState => EMPTY,
    apply: (tr, prev, ctx) => applyHistory(prev, tr, ctx.options),
  },
  commands: () => ({
    undo: (): Command => ({ tr, state }) => fillHistoryTr('undo', tr, state),
    redo: (): Command => ({ tr, state }) => fillHistoryTr('redo', tr, state),
  }),
  keymap: (ctx) => ({
    'Mod-z': () => runHistory('undo', ctx),
    'Shift-Mod-z': () => runHistory('redo', ctx),
    'Mod-y': () => runHistory('redo', ctx),
  }),
  onBeforeInput: (intent, ctx) => {
    if (intent.inputType === 'historyUndo') return runHistory('undo', ctx)
    if (intent.inputType === 'historyRedo') return runHistory('redo', ctx)
    return false
  },
})
