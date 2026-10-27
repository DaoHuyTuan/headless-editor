import type { Selection } from './model/types'
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

function applyHistory(prev: HistoryState, tr: Transaction, options: HistoryOptions): HistoryState {
  if (!tr.docChanged) return prev

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

  // Safe M1 fallback: unmapped changes would make the stacks' ops invalid, so drop them.
  if (tr.meta.addToHistory === false) return EMPTY

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
 * Built-in undo/redo plugin, prepended by the Editor unless `history: false`.
 * Records every doc-changing tr (as finally normalized); consecutive input of the same kind
 * within `groupDelay` ms is one step. Trs with `addToHistory: false` clear both stacks (M1).
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
