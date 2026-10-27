import type { Editor } from './editor'
import { findPathById } from './model/find'
import { deepEqualJson, getNode, isElement } from './model/node'
import type { Data, Doc, ElementNode, Node, Selection } from './model/types'
import { applyOp } from './ops/apply'
import { invertOp } from './ops/invert'
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
  if (tr.meta.origin !== 'input') return 'other'
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

function isHistoryRewrite(v: unknown): v is { id: string; data: Data } {
  if (typeof v !== 'object' || v === null) return false
  const r = v as { id?: unknown; data?: unknown }
  return typeof r.id === 'string' && typeof r.data === 'object' && r.data !== null && !Array.isArray(r.data)
}

function applyHistory(prev: HistoryState, tr: Transaction, options: HistoryOptions): HistoryState {
  if (!tr.docChanged) {
    const rewrite = tr.meta.historyRewrite
    // Only for elements outside the doc: patching the stacks of one in the doc would desync them.
    if (isHistoryRewrite(rewrite) && findPathById(tr.doc, rewrite.id) === null)
      return rewriteStacks(prev, tr.doc, [{ id: rewrite.id, patch: { set: rewrite.data, unset: [] } }])
    return prev
  }

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
    return { undo, redo }
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
    // Structural changes made outside history would make the stacks' ops invalid, so drop them.
    return EMPTY
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
 * Built-in undo/redo plugin, prepended by the Editor unless `history: false`.
 * Records every doc-changing tr (as finally normalized); consecutive input of the same kind
 * within `groupDelay` ms is one step. Trs with `addToHistory: false` clear both stacks, except
 * data-only ones (all `set_node_data`), which rewrite the stored payloads of the changed elements.
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
