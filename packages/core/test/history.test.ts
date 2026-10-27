import { describe, expect, it } from 'vitest'
import { historyPlugin } from '../src/history'
import type { Doc, ElementNode, Node, Selection } from '../src/model/types'
import { createTestEditor, doc, el, sel, stripIds, txt } from '../src/testing/index'
import { testBold, testParagraph } from './fixtures'

interface HistoryState {
  undo: unknown[]
  redo: unknown[]
}

const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))

function setup(content: Doc = doc(p('')), selection: Selection = sel([0, 0], 0)) {
  const clock = { t: 1000 }
  const ed = createTestEditor({
    plugins: [testParagraph, testBold, historyPlugin.configure({ now: () => clock.t })],
    history: false,
    doc: content,
    selection,
  })
  const type = (data: string) => ed.handleIntent({ inputType: 'insertText', data, range: null })
  const backspace = () => ed.handleIntent({ inputType: 'deleteContentBackward', data: null, range: null })
  const text = () => stripIds(ed.getJSON())
  const stacks = () => ed.getPluginState<HistoryState>('history')
  return { ed, clock, type, backspace, text, stacks }
}

describe('history plugin', () => {
  it('groups typing within groupDelay into one undo step', () => {
    const { ed, clock, type, text } = setup()
    type('a')
    clock.t += 100
    type('b')
    clock.t += 100
    type('c')
    expect(text()).toEqual(stripIds(doc(p('abc'))))
    expect(ed.commands.undo()).toBe(true)
    expect(text()).toEqual(stripIds(doc(p(''))))
  })

  it('starts a new step after more than groupDelay', () => {
    const { ed, clock, type, text } = setup()
    type('a')
    clock.t += 600
    type('b')
    ed.commands.undo()
    expect(text()).toEqual(stripIds(doc(p('a'))))
  })

  it('does not group inserts with deletes', () => {
    const { ed, type, backspace, text } = setup()
    type('a')
    type('b')
    backspace()
    expect(text()).toEqual(stripIds(doc(p('a'))))
    ed.commands.undo()
    expect(text()).toEqual(stripIds(doc(p('ab'))))
  })

  it('does not group non-input changes', () => {
    const { ed, text } = setup()
    ed.commands.insertText('a')
    ed.commands.insertText('b')
    ed.commands.undo()
    expect(text()).toEqual(stripIds(doc(p('a'))))
  })

  it('undo restores the caret', () => {
    const { ed, type } = setup(doc(p('xy')), sel([0, 0], 1))
    type('a')
    expect(ed.state.selection).toEqual(sel([0, 0], 2))
    ed.commands.undo()
    expect(ed.state.selection).toEqual(sel([0, 0], 1))
  })

  it('undoes a block split (normalization ops included)', () => {
    const { ed, text } = setup(doc(p('ab')), sel([0, 0], 1))
    ed.commands.splitBlock()
    expect(text()).toEqual(stripIds(doc(p('a'), p('b'))))
    const [entry] = (ed.getPluginState('history') as { undo: { ops: unknown[] }[] }).undo
    const seen: number[] = []
    ed.on('transaction', ({ tr }) => seen.push(tr.ops.filter((op) => op.type !== 'set_selection').length))
    ed.commands.undo()
    // Normalizing the undo tr is a no-op: it carries exactly the inverted ops.
    expect(seen).toEqual([entry!.ops.length])
    expect(text()).toEqual(stripIds(doc(p('ab'))))
    expect(ed.state.selection).toEqual(sel([0, 0], 1))
  })

  it('redo re-applies and restores the selection after', () => {
    const { ed, type, text } = setup()
    type('a')
    type('b')
    ed.commands.undo()
    expect(ed.commands.redo()).toBe(true)
    expect(text()).toEqual(stripIds(doc(p('ab'))))
    expect(ed.state.selection).toEqual(sel([0, 0], 2))
    ed.commands.undo()
    expect(text()).toEqual(stripIds(doc(p(''))))
  })

  it('undo/redo return false when the stack is empty', () => {
    const { ed } = setup()
    expect(ed.commands.undo()).toBe(false)
    expect(ed.commands.redo()).toBe(false)
  })

  it('a new edit after undo clears redo', () => {
    const { ed, clock, type, text, stacks } = setup()
    type('a')
    ed.commands.undo()
    expect(stacks().redo).toHaveLength(1)
    clock.t += 1000
    type('b')
    expect(stacks().redo).toHaveLength(0)
    expect(ed.commands.redo()).toBe(false)
    expect(text()).toEqual(stripIds(doc(p('b'))))
  })

  it('typing right after undo does not merge into the remaining entry', () => {
    const { ed, clock, type, text } = setup()
    type('a')
    clock.t += 600
    type('b')
    ed.commands.undo()
    clock.t = 1100 // within groupDelay of the 'a' entry
    type('c')
    ed.commands.undo()
    expect(text()).toEqual(stripIds(doc(p('a'))))
  })

  it('ignores selection-only and storedMarks-only transactions', () => {
    const { ed, type, stacks } = setup(doc(p('xy')), sel([0, 0], 0))
    type('a')
    ed.commands.undo()
    const tr = ed.createTransaction()
    tr.setSelection(sel([0, 0], 2))
    ed.dispatch(tr)
    ed.commands.toggleMark('bold')
    expect(stacks().undo).toHaveLength(0)
    expect(stacks().redo).toHaveLength(1)
  })

  it('a tr with addToHistory false and doc ops empties both stacks', () => {
    const { ed, clock, type, stacks } = setup()
    type('a')
    clock.t += 600
    type('b')
    ed.commands.undo()
    expect(stacks().undo).toHaveLength(1)
    expect(stacks().redo).toHaveLength(1)
    const tr = ed.createTransaction()
    tr.meta.addToHistory = false
    tr.insertText('z')
    ed.dispatch(tr)
    expect(stacks().undo).toHaveLength(0)
    expect(stacks().redo).toHaveLength(0)
  })

  it('setContent empties the stacks', () => {
    const { ed, type, stacks } = setup()
    type('a')
    ed.setContent(doc(p('new')))
    expect(stacks().undo).toHaveLength(0)
  })

  it('runKeymap("Ctrl-z") undoes and Ctrl-y / Ctrl-Shift-z redo', () => {
    const { ed, type, text } = setup()
    type('a')
    expect(ed.runKeymap('Ctrl-z')).toBe(true)
    expect(text()).toEqual(stripIds(doc(p(''))))
    expect(ed.runKeymap('Ctrl-y')).toBe(true)
    expect(text()).toEqual(stripIds(doc(p('a'))))
    ed.runKeymap('Ctrl-z')
    expect(ed.runKeymap('Ctrl-Shift-z')).toBe(true)
    expect(text()).toEqual(stripIds(doc(p('a'))))
    expect(ed.runKeymap('Ctrl-y')).toBe(false)
  })

  it('handles historyUndo / historyRedo intents', () => {
    const { ed, type, text } = setup()
    type('a')
    expect(ed.handleIntent({ inputType: 'historyUndo', data: null, range: null })).toBe(true)
    expect(text()).toEqual(stripIds(doc(p(''))))
    expect(ed.handleIntent({ inputType: 'historyRedo', data: null, range: null })).toBe(true)
    expect(text()).toEqual(stripIds(doc(p('a'))))
  })

  it('is on by default with groupDelay 500 and reads options live', () => {
    const ed = createTestEditor({ plugins: [testParagraph], doc: doc(p('')), selection: sel([0, 0], 0) })
    let t = 0
    ed.setPluginOptions('history', { now: () => t })
    ed.handleIntent({ inputType: 'insertText', data: 'a', range: null })
    t = 500
    ed.handleIntent({ inputType: 'insertText', data: 'b', range: null })
    t = 1001
    ed.handleIntent({ inputType: 'insertText', data: 'c', range: null })
    expect(ed.getPluginState<HistoryState>('history').undo).toHaveLength(2)
    ed.setPluginOptions('history', { groupDelay: 10_000 })
    ed.handleIntent({ inputType: 'insertText', data: 'd', range: null })
    expect(ed.getPluginState<HistoryState>('history').undo).toHaveLength(2)
  })
})
