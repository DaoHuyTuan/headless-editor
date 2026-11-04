import { definePlugin } from '../../src/plugin/define'
import { single } from '../../src/model/selection'
import type { Doc, ElementNode, Mark, Node, Selection, SelectionRange } from '../../src/model/types'
import type { InputRule } from '../../src/plugin/types'
import { createTestEditor, doc, el, txt } from '../../src/testing/index'
import { testBold, testParagraph } from '../fixtures'

/**
 * Single-range scenarios for the input pipeline (Task 8): typing and replacement intents, input rules
 * (with their undo steps) and IME composition through the view. The recorded results of the
 * implementation before that change live in `single-range-input-ops.json`; the parity test checks
 * the new implementation against them (every dispatched tr's meta and ops, and the states).
 */

const atom = definePlugin({ name: 'atom', node: { kind: 'block', atom: true } })
const chip = definePlugin({ name: 'chip', node: { kind: 'inline', atom: true } })
const bold: Mark = { type: 'bold', data: {} }

const rules: InputRule[] = [
  // Replaces the matched text.
  { match: /^-- $/, handler: (_ctx, _m, range, tr) => (tr.insertText('— ', range), true) },
  // Declines after editing: its tr is dropped and the next rule runs.
  { match: /x$/, handler: (_ctx, _m, range, tr) => (tr.insertText('NO', range), false) },
  { match: /x$/, handler: (_ctx, _m, range, tr) => (tr.insertText('X', range), true) },
  // Sets the selection itself.
  { match: />> $/, handler: (_ctx, _m, range, tr) => (tr.insertText('»', range).setSelection(single({ anchor: range.start, focus: range.start })), true) },
  // Marks the matched word and stores bold.
  {
    match: /\*(\w+)\*$/,
    handler: (_ctx, m, range, tr) => {
      tr.insertText(m[1]!, range)
      const start = range.start
      tr.addMark(bold, { start, end: { path: start.path, offset: start.offset + m[1]!.length } })
      tr.setStoredMarks([bold])
      return true
    },
  },
  // Fires without changing anything.
  { match: /noop$/, handler: () => true },
]
const rulesPlugin = definePlugin({ name: 'rules', inputRules: rules })
export const plugins = [testParagraph, testBold, atom, chip, rulesPlugin]

const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))
const pt = (path: number[], offset: number) => ({ path, offset })
const caret = (path: number[], offset: number): SelectionRange => ({ anchor: pt(path, offset), focus: pt(path, offset) })
const span = (path: number[], from: number, to: number): SelectionRange => ({ anchor: pt(path, from), focus: pt(path, to) })

type Ed = ReturnType<typeof createTestEditor>

export interface InputScenario {
  name: string
  doc: () => Doc
  selection: Selection
  storedMarks?: Mark[]
  /** Mounts the editor in a view first (composition). */
  view?: boolean
  run: (ed: Ed) => unknown | Promise<unknown>
}

const main = (ed: Ed) => {
  const s = ed.state.selection
  return s && s.ranges[s.main]!
}
/** Typing as the view sends it: the intent range is the main range. */
const type = (text: string, range?: SelectionRange | null) => (ed: Ed) => {
  const out: boolean[] = []
  for (const ch of text) out.push(ed.handleIntent({ inputType: 'insertText', data: ch, range: range === undefined ? main(ed) : range }))
  return out
}
const intent = (inputType: string, data: string | null, range?: SelectionRange | null) => (ed: Ed) =>
  ed.handleIntent({ inputType, data, range: range === undefined ? main(ed) : range })
const undoAll = (fn: (ed: Ed) => unknown) => (ed: Ed) => {
  const out = fn(ed)
  const steps: unknown[] = []
  while (ed.commands.undo()) steps.push({ doc: ed.getJSON(), selection: ed.state.selection })
  return { out, steps }
}

const fire = (root: HTMLElement, type: string) => root.dispatchEvent(new Event(type, { bubbles: true }))
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
/** An IME session: compositionstart, the leaf at `path` set to `text`, compositionend. */
const compose = (path: number[], text: string) => async (ed: Ed) => {
  const view = ed.view!
  fire(view.root, 'compositionstart')
  const at = view.composition?.path ?? path
  const leaf = view.renderer.leafAt(at)!
  const node = leaf.ownerDocument.createTreeWalker(leaf, 4).nextNode() as Text | null
  if (node) node.data = text
  else leaf.replaceChildren(leaf.ownerDocument.createTextNode(text))
  await flush()
  fire(view.root, 'compositionend')
  return at
}

const plain = () => doc(p('abcd'), p('efgh'))
const withAtom = () => doc(p('ab'), el('atom'), p('cd'))

export const inputScenarios: InputScenario[] = [
  // intents
  { name: 'type at a caret', doc: plain, selection: single(caret([0, 0], 2)), run: type('xy') },
  { name: 'type with a null range', doc: plain, selection: single(caret([0, 0], 2)), run: type('xy', null) },
  { name: 'type over a range', doc: plain, selection: single(span([0, 0], 1, 3)), run: type('x') },
  { name: 'type with stored marks', doc: plain, selection: single(caret([0, 0], 2)), storedMarks: [bold], run: type('xy') },
  { name: 'type over a node selection', doc: withAtom, selection: single({ ...caret([0, 0], 2), node: [1] }), run: type('x') },
  { name: 'type at a range other than the selection', doc: plain, selection: single(caret([0, 0], 2)), run: type('x', caret([1, 0], 1)) },
  { name: 'replacement text with its own range', doc: plain, selection: single(caret([0, 0], 4)), run: intent('insertReplacementText', 'XY', span([0, 0], 1, 3)) },
  { name: 'replacement text at the selection', doc: plain, selection: single(span([0, 0], 1, 3)), run: intent('insertReplacementText', 'XY') },
  { name: 'replacement text without data', doc: plain, selection: single(caret([0, 0], 2)), run: intent('insertReplacementText', null) },
  { name: 'backspace intent', doc: plain, selection: single(caret([0, 0], 2)), run: intent('deleteContentBackward', null) },
  { name: 'paragraph intent', doc: plain, selection: single(caret([0, 0], 2)), run: intent('insertParagraph', null) },
  { name: 'typing undo', doc: plain, selection: single(caret([0, 0], 2)), run: undoAll(type('xyz')) },
  // input rules
  { name: 'rule replaces, then undo twice', doc: () => doc(p('')), selection: single(caret([0, 0], 0)), run: undoAll(type('-- ')) },
  { name: 'rule declines, the next fires', doc: plain, selection: single(caret([0, 0], 2)), run: undoAll(type('x')) },
  { name: 'rule sets the selection', doc: () => doc(p('ab')), selection: single(caret([0, 0], 2)), run: undoAll(type('>> ')) },
  { name: 'rule marks and stores', doc: () => doc(p('ab ')), selection: single(caret([0, 0], 3)), run: undoAll(type('*hi*')) },
  { name: 'rule fires without changes', doc: () => doc(p('')), selection: single(caret([0, 0], 0)), run: undoAll(type('noop')) },
  { name: 'rule does not run over a range', doc: plain, selection: single(span([0, 0], 0, 1)), run: type('x') },
  { name: 'rule after a chip', doc: () => doc(p('ab', { id: 'c', type: 'chip', data: {}, children: [] }, '-')), selection: single(caret([0, 2], 1)), run: type('- ') },
  { name: 'runInputRules directly', doc: () => doc(p('-- ')), selection: single(caret([0, 0], 3)), run: (ed) => ed.runInputRules() },
  // composition
  { name: 'compose at a caret', doc: plain, selection: single(caret([0, 0], 2)), view: true, run: compose([0, 0], 'abXcd') },
  { name: 'compose over a range', doc: plain, selection: single(span([0, 0], 1, 3)), view: true, run: compose([0, 0], 'aXd') },
  { name: 'compose with stored marks', doc: plain, selection: single(caret([0, 0], 2)), storedMarks: [bold], view: true, run: compose([0, 0], 'abXcd') },
  { name: 'compose over a node selection', doc: withAtom, selection: single({ ...caret([0, 0], 2), node: [1] }), view: true, run: compose([1, 0], 'X') },
  { name: 'compose then undo', doc: plain, selection: single(caret([1, 0], 4)), view: true, run: async (ed) => [await compose([1, 0], 'efghZ')(ed), ed.commands.undo(), ed.getJSON()] },
]

export interface InputRecorded {
  returned: unknown
  trs: { meta: unknown; ops: unknown[] }[]
  selection: Selection | null
  storedMarks: Mark[] | null
  doc: Doc
}

/** Runs `s` on a fresh test editor (deterministic ids), recording every dispatched tr. */
export async function recordInput(s: InputScenario): Promise<InputRecorded> {
  const ed = createTestEditor({ plugins, doc: s.doc(), selection: s.selection })
  let root: HTMLElement | null = null
  try {
    if (s.storedMarks) {
      const tr = ed.createTransaction()
      tr.setStoredMarks(s.storedMarks)
      ed.dispatch(tr)
    }
    if (s.view) {
      root = document.createElement('div')
      document.body.appendChild(root)
      ed.mount(root)
      ed.view!.focus()
    }
    const trs: InputRecorded['trs'] = []
    ed.on('transaction', ({ tr }) => trs.push({ meta: { ...tr.meta }, ops: [...tr.ops] }))
    const out = await s.run(ed)
    return JSON.parse(
      JSON.stringify({ returned: out ?? null, trs, selection: ed.state.selection, storedMarks: ed.state.storedMarks, doc: ed.getJSON() }),
    )
  } finally {
    ed.destroy()
    root?.remove()
    document.getSelection()?.removeAllRanges()
  }
}
