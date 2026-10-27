import { describe, expect, it } from 'vitest'
import { definePlugin } from '../src/plugin/define'
import type { Doc, ElementNode, Node, Selection } from '../src/model/types'
import { createTestEditor, doc, el, sel, stripIds, txt } from '../src/testing/index'
import { testBold, testParagraph } from './fixtures'

const heading = definePlugin({ name: 'heading', node: { kind: 'block' } })

const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))

function setup(content: Doc, selection?: Selection) {
  return createTestEditor({ plugins: [testParagraph, testBold, heading], doc: content, selection })
}

function caret(path: number[], offset: number): Selection {
  return sel(path, offset)
}

describe('insertText', () => {
  it('inserts at a caret and leaves the caret after the text', () => {
    const ed = setup(doc(p('ab')), caret([0, 0], 2))
    expect(ed.commands.insertText('c')).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('abc'))))
    expect(ed.state.selection).toEqual(caret([0, 0], 3))
  })

  it('replaces a cross-block range', () => {
    const ed = setup(doc(p('ab'), p('cd')), sel([0, 0], 1, [1, 0], 1))
    ed.commands.insertText('X')
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('aXd'))))
    expect(ed.state.selection).toEqual(caret([0, 0], 2))
  })

  it('keeps the start block id when replacing across blocks', () => {
    const ed = setup(doc(p('ab'), p('cd')), sel([0, 0], 1, [1, 0], 1))
    const id = ed.getJSON().children[0]!.id
    ed.commands.insertText('X')
    expect(ed.getJSON().children[0]!.id).toBe(id)
  })

  it('handles a backward selection', () => {
    const ed = setup(doc(p('abcd')), sel([0, 0], 3, [0, 0], 1))
    ed.commands.insertText('X')
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('aXd'))))
    expect(ed.state.selection).toEqual(caret([0, 0], 2))
  })

  it('inherits the marks of the text at the point', () => {
    const ed = setup(doc(p(txt('ab', 'bold'))), caret([0, 0], 1))
    ed.commands.insertText('X')
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p(txt('aXb', 'bold')))))
  })

  it('uses stored marks when set, as a separate text node', () => {
    const ed = setup(doc(p('abc')), caret([0, 0], 1))
    const tr = ed.createTransaction()
    tr.setStoredMarks([{ type: 'bold', data: {} }])
    tr.insertText('X')
    ed.dispatch(tr)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p(txt('a'), txt('X', 'bold'), txt('bc')))))
    expect(ed.state.selection).toEqual(caret([0, 1], 1))
    expect(ed.state.storedMarks).toBeNull()
  })

  it('uses stored marks at the start and end of a text', () => {
    const start = setup(doc(p('ab')), caret([0, 0], 0))
    const tr1 = start.createTransaction().setStoredMarks([{ type: 'bold', data: {} }]).insertText('X')
    start.dispatch(tr1)
    expect(stripIds(start.getJSON())).toEqual(stripIds(doc(p(txt('X', 'bold'), txt('ab')))))
    expect(start.state.selection).toEqual(caret([0, 0], 1))

    const end = setup(doc(p('ab')), caret([0, 0], 2))
    const tr2 = end.createTransaction().setStoredMarks([]).insertText('X')
    end.dispatch(tr2)
    expect(stripIds(end.getJSON())).toEqual(stripIds(doc(p('abX'))))
    expect(end.state.selection).toEqual(caret([0, 0], 3))
  })

  it('inserts into an explicit range', () => {
    const ed = setup(doc(p('abcd')), caret([0, 0], 0))
    ed.dispatch(ed.createTransaction().insertText('X', { start: { path: [0, 0], offset: 1 }, end: { path: [0, 0], offset: 3 } }))
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('aXd'))))
    expect(ed.state.selection).toEqual(caret([0, 0], 2))
  })

  it('returns false without a selection', () => {
    const ed = setup(doc(p('ab')))
    ed.dispatch(ed.createTransaction().setSelection(null))
    expect(ed.commands.insertText('x')).toBe(false)
  })
})

describe('deleteRange', () => {
  it('removes whole blocks in between and merges the end block', () => {
    const ed = setup(doc(p('ab'), p('cd'), p('ef'), p('gh')))
    ed.dispatch(ed.createTransaction().deleteRange({ start: { path: [0, 0], offset: 1 }, end: { path: [2, 0], offset: 1 } }))
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('af'), p('gh'))))
    expect(ed.state.selection).toEqual(caret([0, 0], 1))
  })

  it('deletes across differently marked texts within a block', () => {
    const ed = setup(doc(p(txt('ab'), txt('cd', 'bold'), txt('ef'))))
    ed.dispatch(ed.createTransaction().deleteRange({ start: { path: [0, 0], offset: 1 }, end: { path: [0, 2], offset: 1 } }))
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('af'))))
  })
})

describe('deleteBackward / deleteForward', () => {
  it('merges into the previous block at a block start', () => {
    const ed = setup(doc(p('ab'), p('cd')), caret([1, 0], 0))
    expect(ed.commands.deleteBackward()).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('abcd'))))
    expect(ed.state.selection).toEqual(caret([0, 0], 2))
  })

  it('returns false with nothing before the first block', () => {
    const ed = setup(doc(p('ab'), p('cd')), caret([0, 0], 0))
    const before = ed.getJSON()
    expect(ed.commands.deleteBackward()).toBe(false)
    expect(ed.getJSON()).toBe(before)
  })

  it('returns false with nothing after the last block', () => {
    const ed = setup(doc(p('ab')), caret([0, 0], 2))
    expect(ed.commands.deleteForward()).toBe(false)
  })

  it('deletes a character', () => {
    const ed = setup(doc(p('abc')), caret([0, 0], 2))
    ed.commands.deleteBackward()
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('ac'))))
    expect(ed.state.selection).toEqual(caret([0, 0], 1))
    ed.commands.deleteForward()
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('a'))))
  })

  it.each([
    ['a👍🏽', 'skin-tone emoji'],
    ['a👨‍👩‍👧', 'ZWJ family'],
    ['aệ', 'decomposed ệ'],
  ])('deletes a whole grapheme backward: %s (%s)', (text) => {
    const ed = setup(doc(p(text)), caret([0, 0], text.length))
    ed.commands.deleteBackward()
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('a'))))
  })

  it('deletes a decomposed ệ after x', () => {
    const text = 'xệ'
    const ed = setup(doc(p(text)), caret([0, 0], text.length))
    ed.commands.deleteBackward()
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('x'))))
  })

  it('deletes a whole grapheme forward', () => {
    const ed = setup(doc(p('👨‍👩‍👧b')), caret([0, 0], 0))
    ed.commands.deleteForward()
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('b'))))
  })

  it('deletes a grapheme split across differently marked texts', () => {
    const ed = setup(doc(p(txt('ae'), txt('̣̂', 'bold'))), caret([0, 1], 2))
    ed.commands.deleteBackward()
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('a'))))
  })

  it('deletes a word', () => {
    const ed = setup(doc(p('hello world')), caret([0, 0], 11))
    ed.commands.deleteBackward('word')
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('hello '))))
  })

  it('deletes a word forward', () => {
    const ed = setup(doc(p('hello world')), caret([0, 0], 5))
    ed.commands.deleteForward('word')
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('hello'))))
  })

  it('deletes to the block start / end for line', () => {
    const ed = setup(doc(p('ab'), p('hello world')), caret([1, 0], 6))
    ed.commands.deleteBackward('line')
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('ab'), p('world'))))
    ed.commands.deleteForward('line')
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('ab'), p(''))))
  })

  it('merges the next block in on deleteForward at a block end', () => {
    const ed = setup(doc(p('ab'), p('cd')), caret([0, 0], 2))
    ed.commands.deleteForward()
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('abcd'))))
    expect(ed.state.selection).toEqual(caret([0, 0], 2))
  })

  it('deletes a non-collapsed selection', () => {
    const ed = setup(doc(p('abcd')), sel([0, 0], 1, [0, 0], 3))
    ed.commands.deleteForward('word')
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('ad'))))
    expect(ed.state.selection).toEqual(caret([0, 0], 1))
  })
})

describe('splitBlock', () => {
  it('splits at the caret with a fresh id', () => {
    const ed = setup(doc(p('abcd')), caret([0, 0], 2))
    expect(ed.commands.splitBlock()).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('ab'), p('cd'))))
    const [a, b] = ed.getJSON().children
    expect(b!.id).not.toBe(a!.id)
    expect(ed.state.selection).toEqual(caret([1, 0], 0))
  })

  it('keeps type and data, except at the very end of a non-default block', () => {
    const mid = setup(doc(el('heading', { level: 1 }, txt('abcd'))), caret([0, 0], 2))
    mid.commands.splitBlock()
    expect(stripIds(mid.getJSON())).toEqual(
      stripIds(doc(el('heading', { level: 1 }, txt('ab')), el('heading', { level: 1 }, txt('cd')))),
    )

    const end = setup(doc(el('heading', { level: 1 }, txt('ab'))), caret([0, 0], 2))
    end.commands.splitBlock()
    expect(stripIds(end.getJSON())).toEqual(stripIds(doc(el('heading', { level: 1 }, txt('ab')), p(''))))
    expect(end.state.selection).toEqual(caret([1, 0], 0))
  })

  it('splits at block start and end of a paragraph', () => {
    const start = setup(doc(p('ab')), caret([0, 0], 0))
    start.commands.splitBlock()
    expect(stripIds(start.getJSON())).toEqual(stripIds(doc(p(''), p('ab'))))
    expect(start.state.selection).toEqual(caret([1, 0], 0))

    const end = setup(doc(p('ab')), caret([0, 0], 2))
    end.commands.splitBlock()
    expect(stripIds(end.getJSON())).toEqual(stripIds(doc(p('ab'), p(''))))
  })

  it('splits between marked texts', () => {
    const ed = setup(doc(p(txt('ab'), txt('cd', 'bold'))), caret([0, 1], 1))
    ed.commands.splitBlock()
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p(txt('ab'), txt('c', 'bold')), p(txt('d', 'bold')))))
    expect(ed.state.selection).toEqual(caret([1, 0], 0))
  })

  it('deletes the selection first', () => {
    const ed = setup(doc(p('abcd')), sel([0, 0], 1, [0, 0], 3))
    ed.commands.splitBlock()
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('a'), p('d'))))
  })
})

describe('selectAll', () => {
  it('selects from the first text start to the last text end', () => {
    const ed = setup(doc(p('a'), p('b'), p('cd')), caret([1, 0], 0))
    expect(ed.commands.selectAll()).toBe(true)
    expect(ed.state.selection).toEqual(sel([0, 0], 0, [2, 0], 2))
  })

  it('then typing leaves one block with the text', () => {
    const ed = setup(doc(p('a'), p('b'), p('c')))
    ed.commands.selectAll()
    ed.commands.insertText('X')
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('X'))))
    expect(ed.state.selection).toEqual(caret([0, 0], 1))
  })

  it('then deleting leaves one empty block', () => {
    const ed = setup(doc(p('a'), p('b'), p('c')))
    ed.commands.selectAll()
    ed.commands.deleteBackward()
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p(''))))
    expect(ed.state.selection).toEqual(caret([0, 0], 0))
  })

  it('then deleting forward across mixed block types leaves one block', () => {
    const ed = setup(doc(el('heading', { level: 1 }, txt('a')), p(txt('b', 'bold')), p('c')))
    ed.commands.selectAll()
    ed.commands.deleteForward()
    expect(ed.getJSON().children).toHaveLength(1)
    expect(ed.state.selection).toEqual(caret([0, 0], 0))
  })

  it('is bound to Mod-a', () => {
    const ed = setup(doc(p('a'), p('b')), caret([0, 0], 0))
    expect(ed.runKeymap('Mod-a')).toBe(true)
    expect(ed.state.selection).toEqual(sel([0, 0], 0, [1, 0], 1))
  })
})

describe('setNodeData command', () => {
  it('merges data into the element', () => {
    const ed = setup(doc(el('heading', { level: 1 }, txt('a'))))
    expect(ed.commands.setNodeData([0], { level: 2 })).toBe(true)
    expect(ed.getJSON().children[0]!.data).toEqual({ level: 2 })
  })
})

describe('onBeforeInput defaults', () => {
  function lastTr(ed: ReturnType<typeof setup>) {
    const trs: { origin: unknown; inputType: unknown }[] = []
    ed.on('transaction', ({ tr }) => trs.push({ origin: tr.meta.origin, inputType: tr.meta.inputType }))
    return trs
  }

  it('insertParagraph splits the block', () => {
    const ed = setup(doc(p('abcd')), caret([0, 0], 2))
    const trs = lastTr(ed)
    expect(ed.handleIntent({ inputType: 'insertParagraph', data: null, range: null })).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('ab'), p('cd'))))
    expect(trs).toEqual([{ origin: 'input', inputType: 'insertParagraph' }])
  })

  it('insertLineBreak splits the block', () => {
    const ed = setup(doc(p('abcd')), caret([0, 0], 2))
    ed.handleIntent({ inputType: 'insertLineBreak', data: null, range: null })
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('ab'), p('cd'))))
  })

  it('insertText inserts into intent.range or the selection', () => {
    const ed = setup(doc(p('abcd')), caret([0, 0], 0))
    const trs = lastTr(ed)
    ed.handleIntent({ inputType: 'insertText', data: 'X', range: sel([0, 0], 1, [0, 0], 3) })
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('aXd'))))
    ed.handleIntent({ inputType: 'insertReplacementText', data: 'Y', range: null })
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('aXYd'))))
    expect(trs[0]).toEqual({ origin: 'input', inputType: 'insertText' })
  })

  it.each([
    ['deleteContentBackward', 'hello wor'],
    ['deleteWordBackward', 'hello '],
    ['deleteSoftLineBackward', ''],
    ['deleteHardLineBackward', ''],
  ])('%s', (inputType, expected) => {
    const ed = setup(doc(p('hello worl')), caret([0, 0], 10))
    ed.handleIntent({ inputType, data: null, range: null })
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p(expected))))
  })

  it.each([
    ['deleteContentForward', 'ello world'],
    ['deleteWordForward', ' world'],
  ])('%s', (inputType, expected) => {
    const ed = setup(doc(p('hello world')), caret([0, 0], 0))
    ed.handleIntent({ inputType, data: null, range: null })
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p(expected))))
  })

  it('returns false for unknown input types', () => {
    const ed = setup(doc(p('ab')), caret([0, 0], 0))
    expect(ed.handleIntent({ inputType: 'formatBold', data: null, range: null })).toBe(false)
  })
})
