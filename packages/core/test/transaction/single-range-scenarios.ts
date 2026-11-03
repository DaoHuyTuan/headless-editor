import { setIdGenerator } from '../../src/model/id'
import { single } from '../../src/model/selection'
import type { Doc, ElementNode, Mark, Node, Selection, SelectionRange } from '../../src/model/types'
import { definePlugin } from '../../src/plugin/define'
import { Registry } from '../../src/plugin/registry'
import type { EditorState } from '../../src/state'
import { insertText, replaceSelectedNode, selectAll } from '../../src/transaction/text'
import { Transaction } from '../../src/transaction/transaction'
import { doc, el, txt } from '../../src/testing/builders'
import { testBold, testParagraph } from '../fixtures'

/**
 * Single-range scenarios for every text-editing method converted to run per range (Task 5). The
 * recorded results of the implementation before that change live in `single-range-ops.json`; the
 * parity test checks the new implementation against them.
 */

const atom = definePlugin({ name: 'atom', node: { kind: 'block', atom: true } })
const chip = definePlugin({ name: 'chip', node: { kind: 'inline', atom: true } })
const heading = definePlugin({ name: 'heading', node: { kind: 'block', content: 'inline' } })
export const registry = new Registry([testParagraph, testBold, atom, chip, heading])

const bold: Mark = { type: 'bold', data: {} }
const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))
const caret = (path: number[], offset: number): Selection => single({ anchor: { path, offset }, focus: { path, offset } })
const span = (ap: number[], ao: number, fp: number[], fo: number): Selection =>
  single({ anchor: { path: ap, offset: ao }, focus: { path: fp, offset: fo } })
const nodeSel = (node: number[], path: number[], offset: number): Selection =>
  single({ anchor: { path, offset }, focus: { path, offset }, node })
const range = (ap: number[], ao: number, fp: number[], fo: number): SelectionRange => ({
  anchor: { path: ap, offset: ao },
  focus: { path: fp, offset: fo },
})

export interface Scenario {
  name: string
  doc: () => Doc
  selection: Selection | null
  storedMarks?: Mark[] | null
  run: (tr: Transaction) => unknown
}

const twoParas = () => doc(p('abcd', txt('ef', 'bold')), p('gh'))
const withAtom = () => doc(p('ab'), el('atom'), p('cd'))
const withChip = () => doc(p('ab', el('chip'), 'cd'))

export const scenarios: Scenario[] = [
  // insertText
  { name: 'insertText at a caret', doc: twoParas, selection: caret([0, 0], 2), run: (tr) => tr.insertText('X') },
  { name: 'insertText at a caret, stored marks', doc: twoParas, selection: caret([0, 0], 2), storedMarks: [bold], run: (tr) => tr.insertText('X') },
  { name: 'insertText over a range', doc: twoParas, selection: span([0, 0], 1, [0, 0], 3), run: (tr) => tr.insertText('X') },
  { name: 'insertText over a backward range', doc: twoParas, selection: span([0, 0], 3, [0, 0], 1), run: (tr) => tr.insertText('X') },
  { name: 'insertText over a cross-block range', doc: twoParas, selection: span([0, 0], 1, [1, 0], 1), storedMarks: [bold], run: (tr) => tr.insertText('X') },
  { name: 'insertText empty over a range', doc: twoParas, selection: span([0, 0], 1, [0, 1], 1), run: (tr) => tr.insertText('') },
  { name: 'insertText at an explicit range elsewhere', doc: twoParas, selection: caret([1, 0], 1), run: (tr) => tr.insertText('X', range([0, 0], 1, [0, 0], 2)) },
  { name: 'insertText at an explicit range, no selection', doc: twoParas, selection: null, run: (tr) => tr.insertText('X', range([0, 0], 1, [0, 0], 2)) },
  { name: 'insertText on a node selection', doc: withAtom, selection: nodeSel([1], [0, 0], 2), run: (tr) => tr.insertText('X') },
  { name: 'insertText empty on a node selection', doc: withAtom, selection: nodeSel([1], [0, 0], 2), run: (tr) => tr.insertText('') },
  { name: 'insertText (fn) returns', doc: twoParas, selection: caret([0, 0], 2), run: (tr) => insertText(tr, 'X') },
  { name: 'insertText no selection', doc: twoParas, selection: null, run: (tr) => insertText(tr, 'X') },
  // deleteRange
  { name: 'deleteRange cross-block', doc: twoParas, selection: caret([1, 0], 2), run: (tr) => tr.deleteRange({ start: { path: [0, 0], offset: 1 }, end: { path: [1, 0], offset: 1 } }) },
  { name: 'deleteRange empty', doc: twoParas, selection: caret([1, 0], 2), run: (tr) => tr.deleteRange({ start: { path: [0, 0], offset: 1 }, end: { path: [0, 0], offset: 1 } }) },
  { name: 'deleteRange over an atom', doc: withAtom, selection: caret([0, 0], 0), run: (tr) => tr.deleteRange({ start: { path: [0, 0], offset: 1 }, end: { path: [2, 0], offset: 1 } }) },
  // deleteBackward / deleteForward
  { name: 'deleteBackward character', doc: twoParas, selection: caret([0, 0], 2), run: (tr) => tr.deleteBackward() },
  { name: 'deleteBackward word', doc: () => doc(p('foo bar baz')), selection: caret([0, 0], 11), run: (tr) => tr.deleteBackward('word') },
  { name: 'deleteBackward line', doc: () => doc(p('foo bar baz')), selection: caret([0, 0], 7), run: (tr) => tr.deleteBackward('line') },
  { name: 'deleteBackward at block start merges', doc: twoParas, selection: caret([1, 0], 0), storedMarks: [bold], run: (tr) => tr.deleteBackward() },
  { name: 'deleteBackward at doc start', doc: twoParas, selection: caret([0, 0], 0), run: (tr) => tr.deleteBackward() },
  { name: 'deleteBackward over a range', doc: twoParas, selection: span([0, 0], 1, [1, 0], 1), run: (tr) => tr.deleteBackward() },
  { name: 'deleteBackward next to an atom node-selects', doc: withAtom, selection: caret([2, 0], 0), run: (tr) => tr.deleteBackward() },
  { name: 'deleteBackward on a node selection', doc: withAtom, selection: nodeSel([1], [0, 0], 2), run: (tr) => tr.deleteBackward() },
  { name: 'deleteBackward after an inline atom', doc: withChip, selection: caret([0, 2], 0), run: (tr) => tr.deleteBackward() },
  { name: 'deleteForward character', doc: twoParas, selection: caret([0, 0], 2), run: (tr) => tr.deleteForward() },
  { name: 'deleteForward word', doc: () => doc(p('foo bar baz')), selection: caret([0, 0], 3), run: (tr) => tr.deleteForward('word') },
  { name: 'deleteForward at block end merges', doc: twoParas, selection: caret([0, 1], 2), run: (tr) => tr.deleteForward() },
  { name: 'deleteForward next to an atom node-selects', doc: withAtom, selection: caret([0, 0], 2), run: (tr) => tr.deleteForward() },
  { name: 'deleteForward before an inline atom', doc: withChip, selection: caret([0, 0], 2), run: (tr) => tr.deleteForward() },
  // splitBlock
  { name: 'splitBlock mid', doc: twoParas, selection: caret([0, 0], 2), storedMarks: [bold], run: (tr) => tr.splitBlock() },
  { name: 'splitBlock at the end of a heading', doc: () => doc(el('heading', txt('ab'))), selection: caret([0, 0], 2), run: (tr) => tr.splitBlock() },
  { name: 'splitBlock over a range', doc: twoParas, selection: span([0, 0], 1, [1, 0], 1), run: (tr) => tr.splitBlock() },
  { name: 'splitBlock on a node selection', doc: withAtom, selection: nodeSel([1], [0, 0], 2), run: (tr) => tr.splitBlock() },
  // insertBlockNode
  { name: 'insertBlockNode mid', doc: twoParas, selection: caret([0, 0], 2), run: (tr) => tr.insertBlockNode(el('atom')) },
  { name: 'insertBlockNode at block start', doc: twoParas, selection: caret([1, 0], 0), run: (tr) => tr.insertBlockNode(el('atom')) },
  { name: 'insertBlockNode at doc end', doc: twoParas, selection: caret([1, 0], 2), run: (tr) => tr.insertBlockNode(el('atom')) },
  { name: 'insertBlockNode in an empty block', doc: () => doc(p('ab'), p('')), selection: caret([1, 0], 0), run: (tr) => tr.insertBlockNode(el('atom')) },
  { name: 'insertBlockNode over a range', doc: twoParas, selection: span([0, 0], 1, [1, 0], 1), run: (tr) => tr.insertBlockNode(el('atom')) },
  { name: 'insertBlockNode on a node selection', doc: withAtom, selection: nodeSel([1], [0, 0], 2), run: (tr) => tr.insertBlockNode(el('atom')) },
  // selectAll
  { name: 'selectAll', doc: twoParas, selection: caret([0, 0], 2), storedMarks: [bold], run: (tr) => selectAll(tr) },
  // replaceSelectedNode
  { name: 'replaceSelectedNode delete', doc: withAtom, selection: nodeSel([1], [0, 0], 2), run: (tr) => replaceSelectedNode(tr, 'delete') },
  { name: 'replaceSelectedNode split', doc: withAtom, selection: nodeSel([1], [0, 0], 2), run: (tr) => replaceSelectedNode(tr, 'split') },
  { name: 'replaceSelectedNode text', doc: withAtom, selection: nodeSel([1], [0, 0], 2), storedMarks: [bold], run: (tr) => replaceSelectedNode(tr, { text: 'X' }) },
  { name: 'replaceSelectedNode node', doc: withAtom, selection: nodeSel([1], [0, 0], 2), run: (tr) => replaceSelectedNode(tr, { node: el('atom') }) },
  { name: 'replaceSelectedNode last node', doc: () => doc(p('ab'), el('atom')), selection: nodeSel([1], [0, 0], 2), run: (tr) => replaceSelectedNode(tr, { node: el('atom') }) },
  { name: 'replaceSelectedNode without a node selection', doc: twoParas, selection: caret([0, 0], 2), run: (tr) => replaceSelectedNode(tr, 'delete') },
]

export interface Recorded {
  returned: unknown
  ops: unknown[]
  selection: Selection | null
  storedMarks: Mark[] | null
  doc: Doc
}

/** Runs `s` on a fresh tr with deterministic ids; the returned value is recorded only when it is not the tr. */
export function record(s: Scenario): Recorded {
  let n = 0
  setIdGenerator(() => `id${n++}`)
  try {
    const state: EditorState = { doc: s.doc(), selection: s.selection, storedMarks: s.storedMarks ?? null, pluginStates: new Map() }
    const tr = new Transaction(state, registry)
    const out = s.run(tr)
    return {
      returned: out instanceof Transaction ? 'tr' : out,
      ops: JSON.parse(JSON.stringify(tr.ops)),
      selection: tr.selection,
      storedMarks: tr.storedMarks,
      doc: JSON.parse(JSON.stringify(tr.doc)),
    }
  } finally {
    setIdGenerator(null)
  }
}
