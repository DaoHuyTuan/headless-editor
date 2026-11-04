import { z } from 'zod'
import { FRAGMENT_MIME } from '../../src/content/clipboard'
import type { Editor } from '../../src/editor'
import { setIdGenerator } from '../../src/model/id'
import { mainRange, single } from '../../src/model/selection'
import type { Doc, ElementNode, Mark, Node, Range, Selection, SelectionRange } from '../../src/model/types'
import { definePlugin } from '../../src/plugin/define'
import { Registry } from '../../src/plugin/registry'
import type { InputIntent } from '../../src/plugin/types'
import type { EditorState } from '../../src/state'
import { insertFragment, insertInlineNode, type Fragment } from '../../src/transaction/fragment'
import { Transaction } from '../../src/transaction/transaction'
import { createTestEditor, doc, el, txt } from '../../src/testing/index'
import { testBold, testParagraph } from '../fixtures'

/**
 * Single-range scenarios for the fragment methods, paste, drop and `insertContent` converted to run
 * per range (Task 7). The recorded results of the implementation before that change live in
 * `single-range-fragment-ops.json`; the parity test checks the new implementation against them (ops,
 * metas and the `transformPasted` target included, exactly).
 */

const atom = definePlugin({ name: 'atom', node: { kind: 'block', atom: true } })
const chip = definePlugin({
  name: 'chip',
  node: { kind: 'inline', atom: true },
  data: z.object({ label: z.string() }),
})
const code = definePlugin({ name: 'code', node: { kind: 'block', content: 'text' } })
const box = definePlugin({ name: 'box', node: { kind: 'block', content: 'inline' }, data: z.object({ n: z.number() }) })
const plugins = [testParagraph, testBold, atom, chip, code, box]
export const registry = new Registry(plugins)

const bold: Mark = { type: 'bold', data: {} }
const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))
const pid = (id: string, ...children: (Node | string)[]): ElementNode => ({ ...p(...children), id })
const t = (text: string, ...marks: Mark[]): Node => ({ text, marks })
const c = (label = 'x', id = 'c'): ElementNode => ({ id, type: 'chip', data: { label }, children: [] })
const atomEl = (k: number, id = `a${k}`): ElementNode => ({ id, type: 'atom', data: { k } })
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

const plain = () => doc(pid('p1', 'abcd'), pid('p2', 'efgh'))
const marked = () => doc(pid('p1', 'ab', t('cd', bold), 'ef'), pid('p2', 'gh'))
const withAtom = () => doc(pid('p1', 'ab'), atomEl(0, 'at'), pid('p2', 'cd'))
const withChip = () => doc(pid('p1', 'ab', c('y', 'c0'), 'cd'))
const withEmpty = () => doc(pid('p1', 'ab'), pid('p2', ''))
const withCode = () => doc({ id: 'k1', type: 'code', data: {}, children: [txt('let x')] }, pid('p1', 'ab'))

const twoBlocks = (): Fragment => [pid('f1', 'X'), pid('f2', 'Y')]
const threeBlocks = (): Fragment => [pid('f1', 'X'), pid('f2', t('M', bold)), pid('f3', 'Y')]

export const scenarios: Scenario[] = [
  // insertFragment: inline content
  { name: 'fragment inline text mid-text', doc: plain, selection: caret([0, 0], 2), run: (tr) => insertFragment(tr, [t('XY')]) },
  { name: 'fragment inline text at text end', doc: plain, selection: caret([0, 0], 4), run: (tr) => insertFragment(tr, [t('XY')]) },
  { name: 'fragment inline text at text start', doc: plain, selection: caret([1, 0], 0), run: (tr) => insertFragment(tr, [t('XY')]) },
  { name: 'fragment inline marked over a range', doc: plain, selection: span([0, 0], 1, [0, 0], 3), run: (tr) => insertFragment(tr, [t('X'), t('Y', bold)]) },
  { name: 'fragment inline over a backward range', doc: plain, selection: span([0, 0], 3, [0, 0], 1), run: (tr) => insertFragment(tr, [t('X')]) },
  { name: 'fragment inline over a cross-block range', doc: plain, selection: span([0, 0], 2, [1, 0], 1), run: (tr) => insertFragment(tr, [t('X')]) },
  { name: 'fragment inline over marked texts', doc: marked, selection: span([0, 0], 1, [0, 2], 1), run: (tr) => insertFragment(tr, [t('X')]) },
  { name: 'fragment inline with stored marks', doc: plain, selection: caret([0, 0], 2), storedMarks: [bold], run: (tr) => insertFragment(tr, [t('X')]) },
  { name: 'fragment inline chip', doc: plain, selection: caret([0, 0], 2), run: (tr) => insertFragment(tr, [t('X'), c('q', 'cq')]) },
  { name: 'fragment inline chip in the middle', doc: plain, selection: caret([0, 0], 2), run: (tr) => insertFragment(tr, [t('X'), c('q', 'cq'), t('Y')]) },
  { name: 'fragment inline chip with a colliding id', doc: withChip, selection: caret([0, 2], 1), run: (tr) => insertFragment(tr, [c('q', 'c0')]) },
  { name: 'fragment inline into a code block', doc: withCode, selection: caret([0, 0], 3), run: (tr) => insertFragment(tr, [t('XY')]) },
  // insertFragment: block content
  { name: 'fragment two blocks at a caret', doc: plain, selection: caret([0, 0], 2), run: (tr) => insertFragment(tr, twoBlocks()) },
  { name: 'fragment three blocks at a caret', doc: plain, selection: caret([0, 0], 2), run: (tr) => insertFragment(tr, threeBlocks()) },
  { name: 'fragment three blocks over a cross-block range', doc: plain, selection: span([0, 0], 1, [1, 0], 3), run: (tr) => insertFragment(tr, threeBlocks()) },
  { name: 'fragment two blocks at text end', doc: plain, selection: caret([1, 0], 4), run: (tr) => insertFragment(tr, twoBlocks()) },
  { name: 'fragment blocks, last empty', doc: plain, selection: caret([0, 0], 2), run: (tr) => insertFragment(tr, [pid('f1', 'X'), pid('f2', '')]) },
  { name: 'fragment one non-opaque block', doc: plain, selection: caret([0, 0], 2), run: (tr) => insertFragment(tr, [pid('f1', 'X', t('Y', bold))]) },
  { name: 'fragment lone atom block mid-text', doc: plain, selection: caret([0, 0], 2), run: (tr) => insertFragment(tr, [atomEl(1)]) },
  { name: 'fragment lone atom block in an empty block', doc: withEmpty, selection: caret([1, 0], 0), run: (tr) => insertFragment(tr, [atomEl(1)]) },
  { name: 'fragment lone atom block over a range', doc: plain, selection: span([0, 0], 1, [0, 0], 3), run: (tr) => insertFragment(tr, [atomEl(1)]) },
  { name: 'fragment atom edge blocks', doc: plain, selection: caret([0, 0], 2), run: (tr) => insertFragment(tr, [atomEl(1), pid('f1', 'X'), atomEl(2)]) },
  { name: 'fragment atom first block', doc: plain, selection: caret([0, 0], 2), run: (tr) => insertFragment(tr, [atomEl(1), pid('f1', 'X')]) },
  { name: 'fragment atom last block', doc: plain, selection: caret([0, 0], 2), run: (tr) => insertFragment(tr, [pid('f1', 'X'), atomEl(2)]) },
  { name: 'fragment blocks with colliding ids', doc: plain, selection: caret([0, 0], 2), run: (tr) => insertFragment(tr, [pid('p1', 'X'), pid('p1', 'M'), pid('p2', 'Y')]) },
  { name: 'fragment blocks with rejected data', doc: plain, selection: caret([0, 0], 2), run: (tr) => insertFragment(tr, [pid('f1', 'X'), { id: 'b', type: 'box', data: { n: 'x' }, children: [txt('M')] }, pid('f2', 'Y')]) },
  { name: 'fragment blocks around an atom block', doc: withAtom, selection: caret([2, 0], 1), run: (tr) => insertFragment(tr, twoBlocks()) },
  // insertFragment: empty
  { name: 'fragment empty at a caret', doc: plain, selection: caret([0, 0], 2), run: (tr) => insertFragment(tr, []) },
  { name: 'fragment empty over a range', doc: plain, selection: span([0, 0], 1, [1, 0], 2), run: (tr) => insertFragment(tr, []) },
  // insertFragment: node selection
  { name: 'fragment node selection, empty', doc: withAtom, selection: nodeSel([1], [0, 0], 2), run: (tr) => insertFragment(tr, []) },
  { name: 'fragment node selection, inline text', doc: withAtom, selection: nodeSel([1], [0, 0], 2), run: (tr) => insertFragment(tr, [t('XY', bold)]) },
  { name: 'fragment node selection, plain blocks', doc: withAtom, selection: nodeSel([1], [0, 0], 2), run: (tr) => insertFragment(tr, twoBlocks()) },
  { name: 'fragment node selection, lone atom', doc: withAtom, selection: nodeSel([1], [0, 0], 2), run: (tr) => insertFragment(tr, [atomEl(1)]) },
  { name: 'fragment node selection, atom first', doc: withAtom, selection: nodeSel([1], [0, 0], 2), run: (tr) => insertFragment(tr, [atomEl(1), pid('f1', 'X')]) },
  { name: 'fragment node selection, atom last', doc: withAtom, selection: nodeSel([1], [0, 0], 2), run: (tr) => insertFragment(tr, [pid('f1', 'X'), atomEl(2)]) },
  { name: 'fragment node selection, atom only blocks', doc: withAtom, selection: nodeSel([1], [0, 0], 2), run: (tr) => insertFragment(tr, [atomEl(1), atomEl(2)]) },
  { name: 'fragment node selection, last atom of the doc', doc: () => doc(pid('p1', 'ab'), atomEl(0, 'at')), selection: nodeSel([1], [0, 0], 2), run: (tr) => insertFragment(tr, [pid('f1', 'X'), atomEl(2)]) },
  { name: 'fragment node selection, rejected', doc: withAtom, selection: nodeSel([1], [0, 0], 2), run: (tr) => insertFragment(tr, [{ id: 'b', type: 'box', data: { n: 'x' }, children: [txt('M')] }, atomEl(2)]) },
  // insertFragment: explicit target / no selection
  { name: 'fragment explicit range elsewhere', doc: plain, selection: caret([1, 0], 2), run: (tr) => insertFragment(tr, [t('X')], range([0, 0], 1, [0, 0], 3)) },
  { name: 'fragment explicit range before the caret, blocks', doc: plain, selection: caret([1, 0], 2), run: (tr) => insertFragment(tr, twoBlocks(), range([0, 0], 1, [0, 0], 1)) },
  { name: 'fragment explicit range, no selection', doc: plain, selection: null, run: (tr) => insertFragment(tr, [t('X')], range([0, 0], 1, [0, 0], 1)) },
  { name: 'fragment explicit range over a node selection', doc: withAtom, selection: nodeSel([1], [0, 0], 2), run: (tr) => insertFragment(tr, [t('X')], range([2, 0], 1, [2, 0], 1)) },
  { name: 'fragment no selection', doc: plain, selection: null, run: (tr) => insertFragment(tr, [t('X')]) },
  { name: 'fragment (tr method)', doc: plain, selection: caret([0, 0], 2), run: (tr) => tr.insertFragment(twoBlocks()) },
  { name: 'fragment (tr method) at a range', doc: plain, selection: caret([0, 0], 2), run: (tr) => tr.insertFragment([t('X')], range([1, 0], 1, [1, 0], 2)) },
  // insertInlineNode
  { name: 'inline node mid-text', doc: plain, selection: caret([0, 0], 2), run: (tr) => insertInlineNode(tr, c()) },
  { name: 'inline node at text end', doc: plain, selection: caret([0, 0], 4), run: (tr) => insertInlineNode(tr, c()) },
  { name: 'inline node at text start', doc: plain, selection: caret([1, 0], 0), run: (tr) => insertInlineNode(tr, c()) },
  { name: 'inline node over a range', doc: plain, selection: span([0, 0], 1, [0, 0], 3), run: (tr) => insertInlineNode(tr, c()) },
  { name: 'inline node over a backward cross-block range', doc: plain, selection: span([1, 0], 1, [0, 0], 3), run: (tr) => insertInlineNode(tr, c()) },
  { name: 'inline node in marked text', doc: marked, selection: caret([0, 1], 1), run: (tr) => insertInlineNode(tr, c()) },
  { name: 'inline node with stored marks', doc: plain, selection: caret([0, 0], 2), storedMarks: [bold], run: (tr) => insertInlineNode(tr, c()) },
  { name: 'inline node next to a chip, colliding id', doc: withChip, selection: caret([0, 2], 0), run: (tr) => insertInlineNode(tr, c('z', 'c0')) },
  { name: 'inline node on a node selection', doc: withAtom, selection: nodeSel([1], [0, 0], 2), run: (tr) => insertInlineNode(tr, c()) },
  { name: 'inline node in a text-only block', doc: withCode, selection: caret([0, 0], 2), run: (tr) => insertInlineNode(tr, c()) },
  { name: 'inline node of a block type', doc: plain, selection: caret([0, 0], 2), run: (tr) => insertInlineNode(tr, atomEl(1)) },
  { name: 'inline node rejected data', doc: plain, selection: caret([0, 0], 2), run: (tr) => insertInlineNode(tr, { id: 'c', type: 'chip', data: { label: 3 }, children: [] }) },
  { name: 'inline node no selection', doc: plain, selection: null, run: (tr) => insertInlineNode(tr, c()) },
  { name: 'inline node (tr method)', doc: plain, selection: caret([0, 0], 2), run: (tr) => tr.insertInlineNode(c()) },
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

// --- editor level: paste, drop and insertContent ---

/** A DataTransfer stand-in. */
const transfer = (data: Record<string, string>): DataTransfer =>
  ({ getData: (type: string) => data[type] ?? '', types: Object.keys(data), files: [] }) as unknown as DataTransfer
const json = (nodes: Node[]) => ({ [FRAGMENT_MIME]: JSON.stringify(nodes) })

export interface EditorScenario {
  name: string
  doc: () => Doc
  selection: Selection
  run: (editor: Editor) => unknown
}

const paste = (data: Record<string, string>, at?: SelectionRange | null) => (editor: Editor) =>
  editor.handleIntent({
    inputType: 'insertFromPaste',
    data: null,
    dataTransfer: transfer(data),
    range: at === undefined ? editor.state.selection && mainRange(editor.state.selection) : at,
  } satisfies InputIntent)
const drop = (data: Record<string, string>, at: SelectionRange | null) => (editor: Editor) =>
  editor.handleIntent({ inputType: 'insertFromDrop', data: null, dataTransfer: transfer(data), range: at } satisfies InputIntent)
const point = (path: number[], offset: number): SelectionRange => ({ anchor: { path, offset }, focus: { path, offset } })

export const editorScenarios: EditorScenario[] = [
  { name: 'paste text at a caret', doc: plain, selection: caret([0, 0], 2), run: paste({ 'text/plain': 'XY' }) },
  { name: 'paste two lines at a caret', doc: plain, selection: caret([0, 0], 2), run: paste({ 'text/plain': 'X\nY' }) },
  { name: 'paste html blocks over a range', doc: plain, selection: span([0, 0], 1, [1, 0], 2), run: paste({ 'text/html': '<p>X<strong>Y</strong></p><p>Z</p>', 'text/plain': 'XY\nZ' }) },
  { name: 'paste json with the doc ids', doc: plain, selection: caret([1, 0], 2), run: paste(json([pid('p1', 'X'), pid('p2', 'Y')])) },
  { name: 'paste with a null range', doc: plain, selection: caret([0, 0], 2), run: paste({ 'text/plain': 'XY' }, null) },
  { name: 'paste with a range other than the selection', doc: plain, selection: caret([0, 0], 2), run: paste({ 'text/plain': 'XY' }, point([1, 0], 1)) },
  { name: 'paste nothing usable', doc: plain, selection: caret([0, 0], 2), run: paste({ 'text/html': '<p></p>' }) },
  { name: 'paste text over a node selection', doc: withAtom, selection: nodeSel([1], [0, 0], 2), run: paste({ 'text/plain': 'XY' }) },
  { name: 'paste atom json over a node selection', doc: withAtom, selection: nodeSel([1], [0, 0], 2), run: paste(json([pid('f1', 'X'), atomEl(2)])) },
  { name: 'paste plain blocks over a node selection', doc: withAtom, selection: nodeSel([1], [0, 0], 2), run: paste(json([pid('f1', 'X'), pid('f2', 'Y')])) },
  { name: 'paste lone atom at a caret', doc: plain, selection: caret([0, 0], 2), run: paste(json([atomEl(1)])) },
  { name: 'drop text at another point', doc: plain, selection: caret([0, 0], 1), run: drop({ 'text/plain': 'XY' }, point([1, 0], 2)) },
  { name: 'drop blocks at the selection point', doc: plain, selection: caret([0, 0], 1), run: drop({ 'text/plain': 'X\nY' }, point([0, 0], 1)) },
  { name: 'drop with a null range', doc: plain, selection: caret([0, 0], 1), run: drop({ 'text/plain': 'XY' }, null) },
  { name: 'drop over a node selection', doc: withAtom, selection: nodeSel([1], [0, 0], 2), run: drop({ 'text/plain': 'XY' }, point([2, 0], 1)) },
  { name: 'insertContent at a caret', doc: plain, selection: caret([0, 0], 2), run: (e) => e.commands.insertContent([pid('f1', 'X'), pid('f2', 'Y')]) },
  { name: 'insertContent over a range', doc: plain, selection: span([0, 0], 1, [0, 0], 3), run: (e) => e.commands.insertContent([t('X'), c('q', 'cq')]) },
  { name: 'insertContent over a node selection', doc: withAtom, selection: nodeSel([1], [0, 0], 2), run: (e) => e.commands.insertContent([atomEl(1)]) },
  { name: 'insertContent sanitizes unknown types', doc: plain, selection: caret([0, 0], 2), run: (e) => e.commands.insertContent([t('X'), { id: 'u', type: 'nope', data: {}, children: [txt('Z')] }]) },
]

export interface EditorRecorded {
  returned: unknown
  /** `transformPasted`'s `info.at`, per call. */
  pastedAt: unknown[]
  trs: { meta: unknown; ops: unknown[] }[]
  selection: Selection | null
  storedMarks: Mark[] | null
  doc: Doc
}

/** Runs `s` on a fresh test editor (deterministic ids) and records every dispatched tr. */
export function recordEditor(s: EditorScenario): EditorRecorded {
  const pastedAt: unknown[] = []
  const spy = definePlugin({
    name: 'spy',
    transformPasted: (fragment, _ctx, info) => {
      pastedAt.push(info.at)
      return fragment
    },
  })
  const editor = createTestEditor({ plugins: [...plugins, spy], doc: s.doc(), selection: s.selection })
  try {
    const trs: EditorRecorded['trs'] = []
    editor.on('transaction', ({ tr }) => trs.push({ meta: { ...tr.meta }, ops: [...tr.ops] }))
    const out = s.run(editor as unknown as Editor)
    return JSON.parse(
      JSON.stringify({
        returned: out,
        pastedAt,
        trs,
        selection: editor.state.selection,
        storedMarks: editor.state.storedMarks,
        doc: editor.getJSON(),
      }),
    )
  } finally {
    editor.destroy()
    setIdGenerator(null)
  }
}
