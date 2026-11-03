import { z } from 'zod'
import { setIdGenerator } from '../../src/model/id'
import { single } from '../../src/model/selection'
import type { Doc, ElementNode, Mark, Node, Range, Selection } from '../../src/model/types'
import { definePlugin } from '../../src/plugin/define'
import { Registry } from '../../src/plugin/registry'
import type { EditorState } from '../../src/state'
import { addMark, isMarkActive, marksAt, marksOfRange, removeMark, toggleMark } from '../../src/transaction/marks'
import { Transaction } from '../../src/transaction/transaction'
import { doc, el, txt } from '../../src/testing/builders'
import { testBold, testParagraph } from '../fixtures'

/**
 * Single-range scenarios for every mark method converted to run per range (Task 6). The recorded
 * results of the implementation before that change live in `single-range-mark-ops.json`; the parity
 * test checks the new implementation against them (ops included, exactly).
 */

const italic = definePlugin({ name: 'italic', mark: { render: () => ({ tag: 'em' }) } })
const fontSize = definePlugin({
  name: 'fontSize',
  mark: { render: () => ({ tag: 'span' }) },
  data: z.object({ size: z.string().regex(/^\d+px$/) }),
})
const atom = definePlugin({ name: 'atom', node: { kind: 'block', atom: true } })
export const registry = new Registry([testParagraph, testBold, italic, fontSize, atom])

const bold: Mark = { type: 'bold', data: {} }
const ital: Mark = { type: 'italic', data: {} }
const size = (s: string): Mark => ({ type: 'fontSize', data: { size: s } })
const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))
const t = (text: string, ...marks: Mark[]): Node => ({ text, marks })
const caret = (path: number[], offset: number): Selection => single({ anchor: { path, offset }, focus: { path, offset } })
const span = (ap: number[], ao: number, fp: number[], fo: number): Selection =>
  single({ anchor: { path: ap, offset: ao }, focus: { path: fp, offset: fo } })
const nodeSel = (node: number[], path: number[], offset: number): Selection =>
  single({ anchor: { path, offset }, focus: { path, offset }, node })
const range = (sp: number[], so: number, ep: number[], eo: number): Range => ({
  start: { path: sp, offset: so },
  end: { path: ep, offset: eo },
})

export interface Scenario {
  name: string
  doc: () => Doc
  selection: Selection | null
  storedMarks?: Mark[] | null
  run: (tr: Transaction) => unknown
}

// "ab" + "cd"(bold) + "ef"(bold, italic) | "gh"(fontSize 12px) + "ij"
const mixed = () => doc(p('ab', t('cd', bold), t('ef', bold, ital)), p(t('gh', size('12px')), 'ij'))
const plain = () => doc(p('abcd'), p('efgh'))
const withAtom = () => doc(p('ab'), el('atom'), p('cd'))
const view = (tr: Transaction) => ({ doc: tr.doc, selection: tr.selection, storedMarks: tr.storedMarks })

export const scenarios: Scenario[] = [
  // addMark
  { name: 'addMark over a range', doc: plain, selection: span([0, 0], 1, [0, 0], 3), run: (tr) => addMark(tr, bold) },
  { name: 'addMark over a backward range', doc: plain, selection: span([0, 0], 3, [0, 0], 1), run: (tr) => addMark(tr, bold) },
  { name: 'addMark cross-block', doc: mixed, selection: span([0, 0], 1, [1, 1], 1), run: (tr) => addMark(tr, ital) },
  { name: 'addMark already there', doc: mixed, selection: span([0, 1], 0, [0, 2], 2), run: (tr) => addMark(tr, bold) },
  { name: 'addMark replaces other data', doc: mixed, selection: span([1, 0], 1, [1, 1], 1), run: (tr) => addMark(tr, size('20px')) },
  { name: 'addMark at a caret stores', doc: mixed, selection: caret([0, 1], 1), run: (tr) => addMark(tr, ital) },
  { name: 'addMark at a caret with stored marks', doc: mixed, selection: caret([0, 0], 1), storedMarks: [ital], run: (tr) => addMark(tr, bold) },
  { name: 'addMark at a caret replaces stored data', doc: mixed, selection: caret([1, 0], 1), run: (tr) => addMark(tr, size('20px')) },
  { name: 'addMark explicit range elsewhere', doc: plain, selection: caret([1, 0], 2), storedMarks: [ital], run: (tr) => addMark(tr, bold, range([0, 0], 1, [0, 0], 3)) },
  { name: 'addMark explicit collapsed range', doc: plain, selection: caret([1, 0], 2), run: (tr) => addMark(tr, bold, range([0, 0], 1, [0, 0], 1)) },
  { name: 'addMark explicit range, no selection', doc: plain, selection: null, run: (tr) => addMark(tr, bold, range([0, 0], 1, [1, 0], 3)) },
  { name: 'addMark no selection', doc: plain, selection: null, run: (tr) => addMark(tr, bold) },
  { name: 'addMark unknown type', doc: plain, selection: span([0, 0], 1, [0, 0], 3), run: (tr) => addMark(tr, { type: 'nope', data: {} }) },
  { name: 'addMark invalid data', doc: plain, selection: span([0, 0], 1, [0, 0], 3), run: (tr) => addMark(tr, size('big')) },
  { name: 'addMark on a node selection', doc: withAtom, selection: nodeSel([1], [0, 0], 2), run: (tr) => addMark(tr, bold) },
  { name: 'addMark (tr method)', doc: plain, selection: span([0, 0], 1, [0, 0], 3), run: (tr) => tr.addMark(bold) },
  // removeMark
  { name: 'removeMark over part of a text', doc: mixed, selection: span([0, 1], 1, [0, 2], 1), run: (tr) => removeMark(tr, 'bold') },
  { name: 'removeMark cross-block', doc: mixed, selection: span([0, 0], 1, [1, 0], 1), run: (tr) => removeMark(tr, 'fontSize') },
  { name: 'removeMark absent', doc: plain, selection: span([0, 0], 1, [0, 0], 3), run: (tr) => removeMark(tr, 'bold') },
  { name: 'removeMark at a caret stores', doc: mixed, selection: caret([0, 2], 1), run: (tr) => removeMark(tr, 'bold') },
  { name: 'removeMark at a caret with stored marks', doc: plain, selection: caret([0, 0], 1), storedMarks: [bold, ital], run: (tr) => removeMark(tr, 'italic') },
  { name: 'removeMark explicit range elsewhere', doc: mixed, selection: caret([1, 1], 1), storedMarks: [ital], run: (tr) => removeMark(tr, 'bold', range([0, 1], 0, [0, 2], 1)) },
  { name: 'removeMark explicit collapsed range', doc: mixed, selection: caret([1, 1], 1), run: (tr) => removeMark(tr, 'bold', range([0, 1], 1, [0, 1], 1)) },
  { name: 'removeMark no selection', doc: mixed, selection: null, run: (tr) => removeMark(tr, 'bold') },
  { name: 'removeMark (tr method)', doc: mixed, selection: span([0, 1], 1, [0, 2], 1), run: (tr) => tr.removeMark('bold') },
  // toggleMark
  { name: 'toggleMark adds over a range', doc: plain, selection: span([0, 0], 1, [0, 0], 3), run: (tr) => toggleMark(tr, 'bold') },
  { name: 'toggleMark removes over a range', doc: mixed, selection: span([0, 1], 0, [0, 2], 2), run: (tr) => toggleMark(tr, 'bold') },
  { name: 'toggleMark adds over a partly marked range', doc: mixed, selection: span([0, 0], 1, [0, 1], 1), run: (tr) => toggleMark(tr, 'bold') },
  { name: 'toggleMark with data, other data present', doc: mixed, selection: span([1, 0], 0, [1, 0], 2), run: (tr) => toggleMark(tr, 'fontSize', { size: '20px' }) },
  { name: 'toggleMark with data, same data', doc: mixed, selection: span([1, 0], 0, [1, 0], 2), run: (tr) => toggleMark(tr, 'fontSize', { size: '12px' }) },
  { name: 'toggleMark at a caret in plain text', doc: mixed, selection: caret([0, 0], 1), run: (tr) => toggleMark(tr, 'bold') },
  { name: 'toggleMark at a caret in bold text', doc: mixed, selection: caret([0, 1], 1), run: (tr) => toggleMark(tr, 'bold') },
  { name: 'toggleMark at a caret, caret rule at offset 0', doc: mixed, selection: caret([0, 2], 0), run: (tr) => toggleMark(tr, 'italic') },
  { name: 'toggleMark at a caret with stored marks', doc: mixed, selection: caret([0, 1], 1), storedMarks: [ital], run: (tr) => toggleMark(tr, 'italic') },
  { name: 'toggleMark at a caret with empty stored marks', doc: mixed, selection: caret([0, 1], 1), storedMarks: [], run: (tr) => toggleMark(tr, 'bold') },
  { name: 'toggleMark on a node selection', doc: withAtom, selection: nodeSel([1], [0, 0], 2), run: (tr) => toggleMark(tr, 'bold') },
  { name: 'toggleMark no selection', doc: plain, selection: null, run: (tr) => toggleMark(tr, 'bold') },
  { name: 'toggleMark unknown type', doc: plain, selection: caret([0, 0], 1), run: (tr) => toggleMark(tr, 'nope') },
  { name: 'toggleMark invalid data', doc: plain, selection: caret([0, 0], 1), run: (tr) => toggleMark(tr, 'fontSize', { size: 'x' }) },
  { name: 'toggleMark (tr method)', doc: mixed, selection: span([0, 1], 0, [0, 2], 2), run: (tr) => tr.toggleMark('bold') },
  // queries
  { name: 'isMarkActive over a fully marked range', doc: mixed, selection: span([0, 1], 0, [0, 2], 2), run: (tr) => isMarkActive(view(tr), 'bold', undefined, tr.registry) },
  { name: 'isMarkActive over a partly marked range', doc: mixed, selection: span([0, 0], 1, [0, 1], 1), run: (tr) => isMarkActive(view(tr), 'bold', undefined, tr.registry) },
  { name: 'isMarkActive with data', doc: mixed, selection: span([1, 0], 0, [1, 0], 1), run: (tr) => [isMarkActive(view(tr), 'fontSize', { size: '12px' }), isMarkActive(view(tr), 'fontSize', { size: '20px' })] },
  { name: 'isMarkActive at a caret', doc: mixed, selection: caret([0, 2], 0), run: (tr) => [isMarkActive(view(tr), 'bold'), isMarkActive(view(tr), 'italic')] },
  { name: 'isMarkActive at a caret with stored marks', doc: mixed, selection: caret([0, 0], 1), storedMarks: [ital], run: (tr) => [isMarkActive(view(tr), 'bold'), isMarkActive(view(tr), 'italic')] },
  { name: 'isMarkActive over a block boundary only', doc: mixed, selection: span([0, 2], 2, [1, 0], 0), run: (tr) => isMarkActive(view(tr), 'italic') },
  { name: 'isMarkActive no selection', doc: mixed, selection: null, run: (tr) => isMarkActive(view(tr), 'bold') },
  { name: 'marksAt a caret', doc: mixed, selection: caret([0, 2], 1), run: (tr) => marksAt(view(tr)) },
  { name: 'marksAt a backward range', doc: mixed, selection: span([0, 2], 1, [0, 1], 1), run: (tr) => marksAt(view(tr)) },
  { name: 'marksAt with stored marks', doc: mixed, selection: caret([0, 2], 1), storedMarks: [bold], run: (tr) => marksAt(view(tr)) },
  { name: 'marksAt no selection', doc: mixed, selection: null, run: (tr) => marksAt(view(tr)) },
  { name: 'marksOfRange', doc: mixed, selection: null, run: (tr) => [marksOfRange(tr.doc, range([0, 0], 2, [0, 2], 1)), marksOfRange(tr.doc, range([0, 0], 1, [0, 0], 1))] },
]

export interface Recorded {
  returned: unknown
  ops: unknown[]
  selection: Selection | null
  storedMarks: Mark[] | null
  rejected: string | null
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
    return JSON.parse(
      JSON.stringify({
        returned: out instanceof Transaction ? 'tr' : out,
        ops: tr.ops,
        selection: tr.selection,
        storedMarks: tr.storedMarks,
        rejected: tr.rejected,
        doc: tr.doc,
      }),
    )
  } finally {
    setIdGenerator(null)
  }
}
