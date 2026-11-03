import { describe, expect, it } from 'vitest'
import { historyPlugin } from '../src/history'
import { clearHistory, definePlugin, findPathById, getNode, rewriteHistoryData, Transaction } from '../src/index'
import type { AnyPlugin } from '../src/plugin/types'
import type { Data, Doc, ElementNode, Node, Selection } from '../src/model/types'
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

describe('history rewrites data-only changes made outside history', () => {
  const img = definePlugin({ name: 'img', node: { kind: 'block', atom: true } })

  function imageSetup(content: Doc = doc(p('ab')), selection: Selection = sel([0, 0], 2)) {
    const ed = createTestEditor({
      plugins: [testParagraph, img, historyPlugin.configure({ now: () => 0 })],
      history: false,
      doc: content,
      selection,
    })
    const stacks = () => ed.getPluginState<HistoryState>('history')
    const insertImage = (data: Data): string => {
      const node = el('img', data)
      const tr = ed.createTransaction()
      tr.meta.origin = 'command'
      tr.insertBlockNode(node)
      ed.dispatch(tr)
      return node.id
    }
    const dataOf = (id: string): Data | null => {
      const path = findPathById(ed.state.doc, id)
      return path ? (getNode(ed.state.doc, path) as ElementNode).data : null
    }
    const setOutside = (id: string, partial: Data) => {
      const tr = ed.createTransaction()
      tr.meta.origin = 'plugin'
      tr.meta.addToHistory = false
      tr.setNodeData(findPathById(ed.state.doc, id)!, partial)
      ed.dispatch(tr)
    }
    const setInHistory = (id: string, partial: Data) => {
      expect(ed.commands.setNodeData(findPathById(ed.state.doc, id)!, partial)).toBe(true)
    }
    return { ed, stacks, insertImage, dataOf, setOutside, setInHistory }
  }

  it('a data-only addToHistory:false tr rewrites the stored payloads instead of clearing the stacks', () => {
    const { ed, stacks, insertImage, dataOf, setOutside } = imageSetup()
    const id = insertImage({ src: 'blob:1' })
    expect(stacks().undo).toHaveLength(1)
    setOutside(id, { src: 'https://x/1.png' })
    expect(stacks().undo).toHaveLength(1)
    expect(dataOf(id)).toEqual({ src: 'https://x/1.png' })

    expect(ed.commands.undo()).toBe(true)
    expect(dataOf(id)).toBeNull()
    expect(ed.commands.redo()).toBe(true)
    expect(dataOf(id)).toEqual({ src: 'https://x/1.png' })
    // Cycles stay op-consistent.
    ed.commands.undo()
    expect(dataOf(id)).toBeNull()
    ed.commands.redo()
    expect(dataOf(id)).toEqual({ src: 'https://x/1.png' })
    expect(JSON.stringify(stacks())).not.toContain('blob:1')
  })

  it('rewriteHistoryData rewrites the redo stack while the image is undone', () => {
    const { ed, stacks, insertImage, dataOf } = imageSetup()
    const id = insertImage({ src: 'blob:1', alt: 'cat' })
    ed.commands.undo()
    expect(dataOf(id)).toBeNull()
    const before = ed.state.doc
    rewriteHistoryData(ed, id, { src: 'https://x/1.png' })
    expect(ed.state.doc).toBe(before)
    expect(stacks().undo).toHaveLength(0)
    expect(stacks().redo).toHaveLength(1)
    expect(ed.commands.redo()).toBe(true)
    expect(dataOf(id)).toEqual({ src: 'https://x/1.png', alt: 'cat' })
    ed.commands.undo()
    expect(dataOf(id)).toBeNull()
    ed.commands.redo()
    expect(dataOf(id)).toEqual({ src: 'https://x/1.png', alt: 'cat' })
  })

  it('rewriteHistoryData also rewrites the undo stack (image deleted by an undoable edit)', () => {
    const { ed, stacks, insertImage, dataOf } = imageSetup()
    const id = insertImage({ src: 'blob:1' })
    const tr = ed.createTransaction()
    tr.meta.origin = 'command'
    tr.removeNode(findPathById(ed.state.doc, id)!)
    ed.dispatch(tr)
    rewriteHistoryData(ed, id, { src: 'https://x/1.png' })
    expect(stacks().undo).toHaveLength(2)
    ed.commands.undo()
    expect(dataOf(id)).toEqual({ src: 'https://x/1.png' })
    ed.commands.undo()
    expect(dataOf(id)).toBeNull()
    ed.commands.redo()
    expect(dataOf(id)).toEqual({ src: 'https://x/1.png' })
  })

  it('a meta-only historyRewrite tr neither adds an entry nor clears the stacks', () => {
    const { ed, stacks, insertImage } = imageSetup()
    insertImage({ src: 'blob:1' })
    rewriteHistoryData(ed, 'no-such-id', { src: 'x' })
    expect(stacks().undo).toHaveLength(1)
    expect(stacks().redo).toHaveLength(0)
  })

  it('keeps undoable data edits on the same element, with the rewritten keys', () => {
    const { ed, insertImage, dataOf, setOutside, setInHistory } = imageSetup()
    const id = insertImage({ src: 'blob:1', alt: '' })
    setInHistory(id, { alt: 'cat' })
    setOutside(id, { src: 'https://x/1.png' })
    ed.commands.undo()
    expect(dataOf(id)).toEqual({ src: 'https://x/1.png', alt: '' })
    ed.commands.undo()
    expect(dataOf(id)).toBeNull()
    ed.commands.redo()
    expect(dataOf(id)).toEqual({ src: 'https://x/1.png', alt: '' })
    ed.commands.redo()
    expect(dataOf(id)).toEqual({ src: 'https://x/1.png', alt: 'cat' })
  })

  it('leaves set_node_data ops on other elements alone', () => {
    const { ed, insertImage, dataOf, setOutside, setInHistory } = imageSetup()
    const a = insertImage({ src: 'blob:a' })
    const b = insertImage({ src: 'blob:b' })
    setInHistory(b, { src: 'blob:b2' })
    setOutside(a, { src: 'https://x/a.png' })
    ed.commands.undo()
    expect(dataOf(b)).toEqual({ src: 'blob:b' })
    expect(dataOf(a)).toEqual({ src: 'https://x/a.png' })
    ed.commands.redo()
    expect(dataOf(b)).toEqual({ src: 'blob:b2' })
  })

  it('a structural addToHistory:false tr still clears both stacks', () => {
    const { ed, stacks, insertImage } = imageSetup()
    const id = insertImage({ src: 'blob:1' })
    insertImage({ src: 'blob:2' })
    ed.commands.undo()
    expect(stacks().undo).toHaveLength(1)
    expect(stacks().redo).toHaveLength(1)
    const tr = ed.createTransaction()
    tr.meta.addToHistory = false
    tr.setNodeData(findPathById(ed.state.doc, id)!, { src: 'https://x/1.png' })
    tr.removeNode(findPathById(tr.doc, id)!)
    ed.dispatch(tr)
    expect(stacks().undo).toHaveLength(0)
    expect(stacks().redo).toHaveLength(0)
  })
})

describe('clearHistory', () => {
  it('empties both stacks without changing the doc or selection', () => {
    const { ed, type, text, stacks } = setup()
    type('a')
    ed.commands.splitBlock()
    type('b')
    ed.commands.undo()
    expect(stacks().undo.length).toBeGreaterThan(0)
    expect(stacks().redo.length).toBeGreaterThan(0)
    const before = text()
    const sel0 = ed.state.selection
    const metas: Record<string, unknown>[] = []
    ed.on('transaction', ({ tr }) => metas.push({ ...tr.meta }))
    clearHistory(ed)
    expect(stacks()).toEqual({ undo: [], redo: [] })
    expect(text()).toEqual(before)
    expect(ed.state.selection).toEqual(sel0)
    expect(metas).toEqual([{ origin: 'plugin', addToHistory: false, historyClear: true }])
    expect(ed.commands.undo()).toBe(false)
    expect(ed.commands.redo()).toBe(false)
  })

  it('a tr with historyClear set to something other than true leaves the stacks alone', () => {
    const { ed, type, stacks } = setup()
    type('a')
    const tr = ed.createTransaction()
    tr.setMeta('historyClear', 'yes')
    ed.dispatch(tr)
    expect(stacks().undo).toHaveLength(1)
  })
})

describe('appendTransaction trs join the triggering history entry', () => {
  /** Uppercases the character before the caret after typed text. */
  const upper = definePlugin({
    name: 'upper',
    appendTransaction: (trs, _old, state) => {
      if (!trs.some((t) => t.meta.origin === 'input' && t.meta.inputType === 'insertText')) return null
      const s = state.selection
      if (!s || s.anchor.offset === 0) return null
      const ch = (getNode(state.doc, s.anchor.path) as { text: string }).text[s.anchor.offset - 1]!
      if (ch === ch.toUpperCase()) return null
      const t = new Transaction(state, trs[0]!.registry)
      t.apply({ type: 'remove_text', path: s.anchor.path, offset: s.anchor.offset - 1, text: ch })
      t.apply({ type: 'insert_text', path: s.anchor.path, offset: s.anchor.offset - 1, text: ch.toUpperCase() })
      t.setSelection(s)
      return t
    },
  })

  /** After every undo/redo, makes sure the first text starts with '>' (structural, fires on both). */
  const prefix = definePlugin({
    name: 'prefix',
    appendTransaction: (trs, _old, state) => {
      if (!trs.some((t) => t.meta.origin === 'history')) return null
      if ((getNode(state.doc, [0, 0]) as { text: string }).text.startsWith('>')) return null
      const t = new Transaction(state, trs[0]!.registry)
      t.apply({ type: 'insert_text', path: [0, 0], offset: 0, text: '>' })
      return t
    },
  })

  function appendSetup(extra: AnyPlugin[], content: Doc = doc(p('')), selection: Selection = sel([0, 0], 0)) {
    const clock = { t: 1000 }
    const ed = createTestEditor({
      plugins: [testParagraph, historyPlugin.configure({ now: () => clock.t }), ...extra],
      history: false,
      doc: content,
      selection,
    })
    const type = (data: string) => ed.handleIntent({ inputType: 'insertText', data, range: null })
    const text = () => (ed.state.doc.children[0]!.children![0] as { text: string }).text
    const stacks = () => ed.getPluginState<HistoryState>('history')
    return { ed, clock, type, text, stacks }
  }

  it('marks appended trs with appendedTo', () => {
    const { ed, type } = appendSetup([upper, prefix])
    const metas: Record<string, unknown>[] = []
    ed.on('transaction', ({ tr }) => metas.push({ ...tr.meta }))
    type('a')
    ed.commands.undo()
    expect(metas.map((m) => m.appendedTo)).toEqual([undefined, 'record', undefined, 'history'])
  })

  it('an appended tr joins the recorded entry: one undo, no intermediate state', () => {
    const { ed, type, text, stacks } = appendSetup([upper])
    type('a')
    expect(text()).toBe('A')
    expect(stacks().undo).toHaveLength(1)
    expect(ed.commands.undo()).toBe(true)
    expect(text()).toBe('')
    expect(ed.commands.undo()).toBe(false)
    expect(ed.commands.redo()).toBe(true)
    expect(text()).toBe('A')
    expect(ed.state.selection).toEqual(sel([0, 0], 1))
  })

  it('keeps grouping: typing within groupDelay after a joined append stays one step', () => {
    const { ed, clock, type, text, stacks } = appendSetup([upper])
    type('a')
    clock.t += 100
    type('b')
    expect(text()).toBe('AB')
    expect(stacks().undo).toHaveLength(1)
    clock.t += 600
    type('c')
    expect(stacks().undo).toHaveLength(2)
    ed.commands.undo()
    expect(text()).toBe('AB')
    ed.commands.undo()
    expect(text()).toBe('')
  })

  it('an append fired by undo does not clear the redo stack', () => {
    const { ed, type, text, stacks } = appendSetup([prefix])
    type('a')
    expect(text()).toBe('a')
    ed.commands.undo()
    expect(text()).toBe('>')
    expect(stacks().redo).toHaveLength(1)
    expect(ed.commands.redo()).toBe(true)
    expect(text()).toBe('>a')
  })

  it('undo/redo cycles stay op-consistent with an append on both undo and redo', () => {
    const { ed, type, text } = appendSetup([prefix])
    type('a')
    for (let i = 0; i < 3; i++) {
      expect(ed.commands.undo()).toBe(true)
      expect(text()).toBe('>')
      expect(ed.commands.redo()).toBe(true)
      expect(text()).toBe('>a')
    }
    expect(ed.commands.redo()).toBe(false)
  })

  it('keeps the neighbouring entries consistent across several undos and redos', () => {
    const { ed, clock, type, text, stacks } = appendSetup([prefix])
    type('a')
    clock.t += 1000
    type('b')
    expect(text()).toBe('ab')
    ed.commands.undo()
    expect(text()).toBe('>a')
    ed.commands.undo()
    expect(text()).toBe('>')
    expect(stacks().redo).toHaveLength(2)
    ed.commands.redo()
    expect(text()).toBe('>a')
    ed.commands.redo()
    expect(text()).toBe('>ab')
    ed.commands.undo()
    expect(text()).toBe('>a')
    ed.commands.undo()
    expect(text()).toBe('>')
    expect(ed.commands.undo()).toBe(false)
  })

  it('an appended tr with its own addToHistory:false stays outside history', () => {
    const outside = definePlugin({
      name: 'outside',
      appendTransaction: (trs, _old, state) => {
        if (!trs.some((t) => t.meta.origin === 'input')) return null
        const t = new Transaction(state, trs[0]!.registry)
        t.meta.addToHistory = false
        t.apply({ type: 'insert_text', path: [0, 0], offset: 0, text: '>' })
        return t
      },
    })
    const { type, text, stacks } = appendSetup([outside])
    type('a')
    expect(text()).toBe('>a')
    // Structural change made outside history: today's behaviour clears the stacks.
    expect(stacks().undo).toHaveLength(0)
  })

  it('appended trs inherit addToHistory:false from their root', () => {
    const always = definePlugin({
      name: 'always',
      appendTransaction: (trs, _old, state) => {
        if (!trs.some((t) => t.meta.origin === 'command')) return null
        const t = new Transaction(state, trs[0]!.registry)
        t.apply({ type: 'insert_text', path: [0, 0], offset: 0, text: '>' })
        return t
      },
    })
    const { ed, text, stacks } = appendSetup([always])
    const metas: Record<string, unknown>[] = []
    ed.on('transaction', ({ tr }) => metas.push({ ...tr.meta }))
    const tr = ed.createTransaction()
    tr.meta.origin = 'command'
    tr.meta.addToHistory = false
    tr.apply({ type: 'insert_text', path: [0, 0], offset: 0, text: 'x' })
    ed.dispatch(tr)
    expect(text()).toBe('>x')
    expect(metas[1]).toMatchObject({ addToHistory: false })
    expect(metas[1]!.appendedTo).toBeUndefined()
    expect(stacks().undo).toHaveLength(0)
  })
})
