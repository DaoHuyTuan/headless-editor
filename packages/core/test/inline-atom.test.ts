// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { definePlugin } from '../src/plugin/define'
import type { DeepReadonly, Doc, ElementNode, Node, Selection } from '../src/model/types'
import { getFragment, isElement, nodeEntries } from '../src/index'
import { createTestEditor, doc, el, sel, stripIds, txt } from '../src/testing/index'
import { testBold, testParagraph } from './fixtures'

const chip = definePlugin({ name: 'chip', node: { kind: 'inline', atom: true } })
const code = definePlugin({ name: 'code', node: { kind: 'block', content: 'text' } })

const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))
const c = (label = 'x'): ElementNode => ({ id: 'c', type: 'chip', data: { label }, children: [] })

function setup(content: Doc, selection?: Selection) {
  return createTestEditor({ plugins: [testParagraph, testBold, chip, code], doc: content, selection })
}

const shape = (ed: ReturnType<typeof setup>) => stripIds(ed.getJSON())
const elementIds = (d: DeepReadonly<Doc>): string[] =>
  [...nodeEntries(d)].filter(([n]) => isElement(n)).map(([n]) => (n as ElementNode).id)

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

describe('inline atoms: normalization (rule 10)', () => {
  it('gives an inline atom a text sibling on each side', () => {
    expect(shape(setup(doc(p(c()))))).toEqual(stripIds(doc(p('', c(), ''))))
  })

  it('keeps one empty text between two atoms and adds none where texts exist', () => {
    expect(shape(setup(doc(p('a', c(), c('y'), 'b'))))).toEqual(stripIds(doc(p('a', c(), '', c('y'), 'b'))))
  })

  it('rule 4 keeps the empty texts beside an inline element but still drops other empty texts', () => {
    expect(shape(setup(doc(p('', c(), '', txt('', 'bold'), 'b'))))).toEqual(stripIds(doc(p('', c(), 'b'))))
  })
})

describe('inline atoms: deletion', () => {
  it('Backspace right after the chip removes it whole', () => {
    const ed = setup(doc(p('ab', c(), 'cd')), sel([0, 2], 0))
    expect(ed.commands.deleteBackward()).toBe(true)
    expect(shape(ed)).toEqual(stripIds(doc(p('abcd'))))
    expect(ed.state.selection).toEqual(sel([0, 0], 2))
  })

  it('Delete right before the chip removes it whole', () => {
    const ed = setup(doc(p('ab', c(), 'cd')), sel([0, 0], 2))
    expect(ed.commands.deleteForward()).toBe(true)
    expect(shape(ed)).toEqual(stripIds(doc(p('abcd'))))
    expect(ed.state.selection).toEqual(sel([0, 0], 2))
  })

  it('Backspace/Delete in an empty text between atoms removes the neighbour only', () => {
    const ed = setup(doc(p('', c(), '', c('y'), '')), sel([0, 2], 0))
    ed.commands.deleteBackward()
    expect(shape(ed)).toEqual(stripIds(doc(p('', c('y'), ''))))
    expect(ed.state.selection).toEqual(sel([0, 0], 0))
    ed.commands.deleteForward()
    expect(shape(ed)).toEqual(stripIds(doc(p(''))))
  })

  it('grapheme deletion never crosses into the atom', () => {
    const ed = setup(doc(p('ab', c(), 'cd')), sel([0, 2], 1))
    ed.commands.deleteBackward()
    expect(shape(ed)).toEqual(stripIds(doc(p('ab', c(), 'd'))))
    expect(ed.state.selection).toEqual(sel([0, 2], 0))
    const fwd = setup(doc(p('ab', c(), 'cd')), sel([0, 0], 1))
    fwd.commands.deleteForward()
    expect(shape(fwd)).toEqual(stripIds(doc(p('a', c(), 'cd'))))
  })

  it('word deletion stops at the atom', () => {
    const ed = setup(doc(p('ab ', c(), ' cd ef')), sel([0, 2], 3))
    ed.commands.deleteBackward('word')
    expect(shape(ed)).toEqual(stripIds(doc(p('ab ', c(), '  ef'))))
    ed.commands.deleteBackward('word')
    expect(shape(ed)).toEqual(stripIds(doc(p('ab ', c(), ' ef'))))
    expect(ed.state.selection).toEqual(sel([0, 2], 0))
    const fwd = setup(doc(p('ab cd', c(), 'e')), sel([0, 0], 2))
    fwd.commands.deleteForward('word')
    expect(shape(fwd)).toEqual(stripIds(doc(p('ab', c(), 'e'))))
  })

  it('Backspace in a text after marked text (not next to the atom) deletes a character', () => {
    const ed = setup(doc(p('a', c(), txt('b', 'bold'), 'c')), sel([0, 3], 0))
    ed.commands.deleteBackward()
    expect(shape(ed)).toEqual(stripIds(doc(p('a', c(), 'c'))))
  })

  it('a cross-node selection containing the chip is replaced by typing, and undo restores it', () => {
    const ed = setup(doc(p('ab', c(), 'cd')), sel([0, 0], 1, [0, 2], 1))
    expect(ed.commands.insertText('X')).toBe(true)
    expect(shape(ed)).toEqual(stripIds(doc(p('aXd'))))
    expect(ed.state.selection).toEqual(sel([0, 0], 2))
    ed.commands.undo()
    expect(shape(ed)).toEqual(stripIds(doc(p('ab', c(), 'cd'))))
  })

  it('deleting across blocks removes atoms inside the range', () => {
    const ed = setup(doc(p('a', c(), 'b'), p('c', c('y'), 'd')), sel([0, 0], 1, [1, 2], 0))
    ed.commands.deleteBackward()
    expect(shape(ed)).toEqual(stripIds(doc(p('ad'))))
  })
})

describe('inline atoms: fragments', () => {
  it('copy and paste of a range containing the chip keeps it with a fresh id', () => {
    const ed = setup(doc(p('ab', c(), 'cd')), sel([0, 2], 2))
    const frag = getFragment(ed.state.doc, { start: { path: [0, 0], offset: 1 }, end: { path: [0, 2], offset: 1 } })
    const originalId = (ed.state.doc.children[0]!.children![1] as ElementNode).id
    expect(stripIds(frag)).toEqual(stripIds([txt('b'), c(), txt('c')]))
    ed.commands.insertContent(frag)
    expect(shape(ed)).toEqual(stripIds(doc(p('ab', c(), 'cdb', c(), 'c'))))
    const ids = elementIds(ed.state.doc)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain(originalId)
    expect(ed.state.selection).toEqual(sel([0, 4], 1))
  })

  it('pasting a lone atom leaves the caret right after it', () => {
    const ed = setup(doc(p('ab')), sel([0, 0], 2))
    ed.commands.insertContent([c()])
    expect(shape(ed)).toEqual(stripIds(doc(p('ab', c(), ''))))
    expect(ed.state.selection).toEqual(sel([0, 2], 0))
  })
})

describe('tr.insertInlineNode', () => {
  const insert = (ed: ReturnType<typeof setup>, node: ElementNode) => {
    const tr = ed.createTransaction()
    tr.insertInlineNode(node)
    ed.dispatch(tr)
  }

  it('inserts at the caret and leaves the caret right after the node', () => {
    const ed = setup(doc(p('ab')), sel([0, 0], 1))
    insert(ed, c())
    expect(shape(ed)).toEqual(stripIds(doc(p('a', c(), 'b'))))
    expect(ed.state.selection).toEqual(sel([0, 2], 0))
  })

  it('at the end of a block the caret goes into a new empty text after it', () => {
    const ed = setup(doc(p('ab')), sel([0, 0], 2))
    insert(ed, c())
    expect(shape(ed)).toEqual(stripIds(doc(p('ab', c(), ''))))
    expect(ed.state.selection).toEqual(sel([0, 2], 0))
  })

  it('replaces the selection', () => {
    const ed = setup(doc(p('abcd')), sel([0, 0], 1, [0, 0], 3))
    insert(ed, c())
    expect(shape(ed)).toEqual(stripIds(doc(p('a', c(), 'd'))))
    expect(ed.state.selection).toEqual(sel([0, 2], 0))
  })

  it('gives a node whose id is already in the doc a fresh id', () => {
    const ed = setup(doc(p('a', c(), 'b')), sel([0, 2], 1))
    const id = (ed.state.doc.children[0]!.children![1] as ElementNode).id
    insert(ed, { ...c(), id })
    const ids = elementIds(ed.state.doc)
    expect(ids.length).toBe(3)
    expect(new Set(ids).size).toBe(3)
  })

  it('does nothing inside a text-only block', () => {
    const ed = setup(doc(el('code', txt('ab'))), sel([0, 0], 1))
    const tr = ed.createTransaction()
    tr.insertInlineNode(c())
    expect(tr.ops).toEqual([])
  })
})

describe('inline atoms: composition', () => {
  const caret = (path: number[], offset: number): Selection => ({ anchor: { path, offset }, focus: { path, offset } })
  const fire = (root: HTMLElement, type: string) => root.dispatchEvent(new Event(type, { bubbles: true }))

  function mount(content: Doc, selection: Selection) {
    const editor = setup(content, selection)
    const root = document.createElement('div')
    document.body.appendChild(root)
    editor.mount(root)
    editor.view!.focus()
    return { editor, root, view: editor.view! }
  }

  /** What an IME does: types `text` into the leaf's DOM text (its zero-width placeholder kept, as browsers do). */
  function imeType(leaf: HTMLElement, text: string) {
    const t = leaf.ownerDocument.createTreeWalker(leaf, 4).nextNode() as Text
    t.data = t.data + text
  }

  it('composition after the chip commits into the next text', () => {
    const { editor, root, view } = mount(doc(p('a', c(), '')), caret([0, 2], 0))
    fire(root, 'compositionstart')
    const leaf = view.renderer.leafAt([0, 2])!
    expect(view.composition).toEqual({ leaf, path: [0, 2] })
    imeType(leaf, 'ã')
    fire(root, 'compositionend')
    expect(shape(editor)).toEqual(stripIds(doc(p('a', c(), 'ã'))))
    expect(editor.state.selection).toEqual(caret([0, 2], 1))
  })

  it('composition before the chip at the block start commits into the text before it', () => {
    const { editor, root, view } = mount(doc(p('', c(), 'b')), caret([0, 0], 0))
    fire(root, 'compositionstart')
    const leaf = view.renderer.leafAt([0, 0])!
    expect(view.composition?.leaf).toBe(leaf)
    imeType(leaf, 'ư')
    fire(root, 'compositionend')
    expect(shape(editor)).toEqual(stripIds(doc(p('ư', c(), 'b'))))
  })
})
