import { describe, expect, it } from 'vitest'
import { mainRange, single } from '../../src/model/selection'
import { definePlugin, findPathById, isNodeSelection, nodeSelection, type Doc, type ElementNode, type Node, type Selection } from '../../src/index'
import { getFragment } from '../../src/internal'
import { atomEl, createTestEditor, doc, el, sel, stripIds, txt } from '../../src/testing/index'
import { testBold, testParagraph } from '../fixtures'

const atomPlugin = definePlugin({ name: 'atom', node: { kind: 'block', atom: true } })
const strictAtom = definePlugin({
  name: 'strict',
  node: { kind: 'block', atom: true },
  data: {
    '~standard': {
      version: 1 as const,
      vendor: 'test',
      validate: (v: unknown) =>
        typeof (v as { src?: unknown }).src === 'string'
          ? { value: v as { src: string } }
          : { issues: [{ message: 'src required' }] },
    },
  },
})

const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))
const atom = (): ElementNode => atomEl('atom')
const caret = (path: number[], offset: number): Selection => sel(path, offset)
const nodeSel = (node: number[], path: number[], offset: number): Selection => single({ ...mainRange(caret(path, offset)), node })

function setup(content: Doc, selection?: Selection) {
  return createTestEditor({ plugins: [testParagraph, testBold, atomPlugin, strictAtom], doc: content, selection })
}

describe('nodeSelection / isNodeSelection / findPathById', () => {
  it('puts the caret at the end of the previous editable text, else the start of the next one', () => {
    const ed = setup(doc(p('a'), atom(), p('b')))
    expect(nodeSelection(ed.state.doc, ed.registry, [1])).toEqual(nodeSel([1], [0, 0], 1))
    const first = setup(doc(atom(), p('b')))
    expect(nodeSelection(first.state.doc, first.registry, [0])).toEqual(nodeSel([0], [1, 0], 0))
  })

  it('throws for a non-opaque element', () => {
    const ed = setup(doc(p('a'), atom()))
    expect(() => nodeSelection(ed.state.doc, ed.registry, [0])).toThrow()
    expect(() => nodeSelection(ed.state.doc, ed.registry, [5])).toThrow()
  })

  it('a non-atom block with a node view is not node-selectable (3.16)', () => {
    const callout = definePlugin({ name: 'callout', node: { kind: 'block', content: 'inline' } })
    const ed = createTestEditor({
      plugins: [testParagraph, callout],
      doc: doc(p('a'), el('callout', txt('note')), p('b')),
      nodeViews: { callout: () => ({ dom: document.createElement('div'), update: () => {}, destroy: () => {} }) as never },
    })
    expect(() => nodeSelection(ed.state.doc, ed.registry, [1])).toThrow(/No opaque element at \[1\]/)
    const tr = ed.createTransaction()
    expect(() => tr.setSelection(nodeSel([1], [0, 0], 1))).toThrow(/not an opaque element/)
  })

  it('tr.setSelection with a node that is not an opaque element throws in dev mode', () => {
    const ed = setup(doc(p('a'), atom()))
    const tr = ed.createTransaction()
    expect(() => tr.setSelection(nodeSel([0], [0, 0], 1))).toThrow(/not an opaque element/)
    expect(() => tr.setSelection(nodeSel([7], [0, 0], 1))).toThrow(/not an opaque element/)
    expect(() => tr.setSelection(nodeSel([1], [0, 0], 1))).not.toThrow()
  })

  it('isNodeSelection', () => {
    expect(isNodeSelection(caret([0, 0], 0))).toBe(false)
    expect(isNodeSelection(nodeSel([1], [0, 0], 0))).toBe(true)
    expect(isNodeSelection(null)).toBe(false)
  })

  it('findPathById', () => {
    const ed = setup(doc(p('a'), atom(), p('b')))
    const id = ed.state.doc.children[1]!.id
    expect(findPathById(ed.state.doc, id)).toEqual([1])
    expect(findPathById(ed.state.doc, 'nope')).toBeNull()
  })
})

describe('Backspace / Delete next to an opaque block', () => {
  it('Backspace at the start of the following block selects the atom; a second one removes it', () => {
    const ed = setup(doc(p('a'), atom(), p('b')), caret([2, 0], 0))
    const before = ed.state.doc
    expect(ed.commands.deleteBackward()).toBe(true)
    expect(ed.state.doc).toBe(before)
    expect(ed.state.selection).toEqual(nodeSel([1], [0, 0], 1))
    expect(ed.commands.deleteBackward()).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('a'), p('b'))))
    expect(ed.state.selection).toEqual(caret([0, 0], 1))
  })

  it('Delete at the end of the previous block selects the atom', () => {
    const ed = setup(doc(p('a'), atom(), p('b')), caret([0, 0], 1))
    expect(ed.commands.deleteForward()).toBe(true)
    expect(ed.state.selection).toEqual(nodeSel([1], [0, 0], 1))
  })

  it('also selects an unknown block', () => {
    const ed = setup(doc(el('widget', txt('T')), p('b')), caret([1, 0], 0))
    expect(ed.commands.deleteBackward()).toBe(true)
    expect(ed.state.selection).toEqual(nodeSel([0], [1, 0], 0))
  })
})

describe('editing with a node selection', () => {
  const selected = () => setup(doc(p('a'), atom(), p('b')), nodeSel([1], [0, 0], 1))

  it('keeps the node selection from the initial selection option', () => {
    expect(selected().state.selection).toEqual(nodeSel([1], [0, 0], 1))
  })

  it('insertText replaces the node with a paragraph holding the text', () => {
    const ed = selected()
    expect(ed.commands.insertText('x')).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('a'), p('x'), p('b'))))
    expect(ed.state.selection).toEqual(caret([1, 0], 1))
  })

  it('typing through an input intent replaces the node too', () => {
    const ed = selected()
    expect(ed.handleIntent({ inputType: 'insertText', data: 'x', range: mainRange(caret([0, 0], 1)) })).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('a'), p('x'), p('b'))))
    expect(ed.state.selection).toEqual(caret([1, 0], 1))
  })

  it('Enter / Backspace intents insert a paragraph after / remove the node', () => {
    const enter = selected()
    expect(enter.handleIntent({ inputType: 'insertParagraph', data: null, range: null })).toBe(true)
    expect(stripIds(enter.getJSON())).toEqual(stripIds(doc(p('a'), atom(), p(''), p('b'))))
    expect(enter.state.selection).toEqual(caret([2, 0], 0))
    const back = selected()
    expect(back.handleIntent({ inputType: 'deleteContentBackward', data: null, range: null })).toBe(true)
    expect(stripIds(back.getJSON())).toEqual(stripIds(doc(p('a'), p('b'))))
    expect(back.state.selection).toEqual(caret([0, 0], 1))
  })

  it('splitBlock inserts an empty paragraph after the node', () => {
    const ed = selected()
    expect(ed.commands.splitBlock()).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('a'), atom(), p(''), p('b'))))
    expect(ed.state.selection).toEqual(caret([2, 0], 0))
  })

  it('deleteForward removes the node; the caret goes to the anchor', () => {
    const ed = selected()
    expect(ed.commands.deleteForward()).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('a'), p('b'))))
    expect(ed.state.selection).toEqual(caret([0, 0], 1))
  })

  it('deleting a node anchored after it maps the anchor', () => {
    const ed = setup(doc(atom(), p('b')), nodeSel([0], [1, 0], 0))
    ed.commands.deleteBackward()
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('b'))))
    expect(ed.state.selection).toEqual(caret([0, 0], 0))
  })

  it('insertContent replaces the node in place, like insertText', () => {
    const ed = selected()
    expect(ed.commands.insertContent([txt('XY')])).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('a'), p('XY'), p('b'))))
    expect(ed.state.selection).toEqual(caret([1, 0], 2))
  })

  describe('insertContent of blocks with an opaque edge keeps no placeholder', () => {
    const atomWith = (k: number): ElementNode => ({ ...atom(), data: { k } })
    const blocks = (ed: ReturnType<typeof selected>) =>
      ed.getJSON().children.map((b) => (b.type === 'atom' ? `atom${(b.data as { k?: number }).k ?? ''}` : texts(b)))
    const texts = (b: ElementNode) => (b.children ?? []).map((c) => ('text' in c ? c.text : '')).join('')

    function check(fragment: Node[], expected: string[], caretAt: Selection) {
      const ed = selected()
      const before = ed.getJSON()
      const selectedBefore = ed.state.selection
      expect(ed.commands.insertContent(fragment)).toBe(true)
      expect(blocks(ed)).toEqual(expected)
      expect(ed.state.selection).toEqual(caretAt)
      expect(ed.commands.undo()).toBe(true)
      expect(ed.getJSON()).toEqual(before)
      expect(ed.state.selection).toEqual(selectedBefore)
    }

    it('[atom, p] goes in place; the caret ends after the paragraph text', () => {
      check([atomWith(1), p('y')], ['a', 'atom1', 'y', 'b'], caret([2, 0], 1))
    })

    it('[atom, atom] goes in place; the caret is at the start of the following block', () => {
      check([atomWith(1), atomWith(2)], ['a', 'atom1', 'atom2', 'b'], caret([3, 0], 0))
    })

    it('[p, atom] goes in place; the caret is at the start of the following block', () => {
      check([p('x'), atomWith(1)], ['a', 'x', 'atom1', 'b'], caret([3, 0], 0))
    })

    it('a lone copied atom replaces the node; the caret is at the start of the following block', () => {
      check([atomWith(1)], ['a', 'atom1', 'b'], caret([2, 0], 0))
    })

    it('a trailing atom at the end of the doc gets an empty paragraph after it for the caret', () => {
      const ed = setup(doc(p('a'), atom()), nodeSel([1], [0, 0], 1))
      expect(ed.commands.insertContent([atomWith(1), atomWith(2)])).toBe(true)
      expect(blocks(ed)).toEqual(['a', 'atom1', 'atom2', ''])
      expect(ed.state.selection).toEqual(caret([3, 0], 0))
    })
  })

  it('insertContent with an empty fragment removes the node', () => {
    const ed = selected()
    expect(ed.commands.insertContent([])).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('a'), p('b'))))
    expect(ed.state.selection).toEqual(caret([0, 0], 1))
  })

  it('selectAll clears the node selection', () => {
    const ed = selected()
    expect(ed.runKeymap('Mod-a')).toBe(true)
    expect(ed.state.selection).toEqual(sel([0, 0], 0, [2, 0], 1))
  })

  it('setSelection compares node', () => {
    const ed = setup(doc(p('a'), atom(), p('b')), caret([0, 0], 1))
    const tr = ed.createTransaction()
    tr.setSelection(nodeSel([1], [0, 0], 1))
    expect(tr.ops).toHaveLength(1)
    tr.setSelection(nodeSel([1], [0, 0], 1))
    expect(tr.ops).toHaveLength(1)
    tr.setSelection(caret([0, 0], 1))
    expect(tr.ops).toHaveLength(2)
    expect(tr.selection).toEqual(caret([0, 0], 1))
  })

  it('undoing the removal restores the node and the node selection', () => {
    const ed = selected()
    ed.commands.deleteBackward()
    ed.commands.undo()
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('a'), atom(), p('b'))))
    expect(ed.state.selection).toEqual(nodeSel([1], [0, 0], 1))
  })

  it('getFragment with a node copies the node', () => {
    const ed = selected()
    const s = mainRange(ed.state.selection!)
    const frag = getFragment(ed.state.doc, { start: s.anchor, end: s.focus }, s.node)
    expect(frag).toEqual([ed.state.doc.children[1]])
    expect(frag[0]).not.toBe(ed.state.doc.children[1])
  })
})

describe('insertBlockNode', () => {
  function insert(content: Doc, selection: Selection, node: ElementNode = atom()) {
    const ed = setup(content, selection)
    const tr = ed.createTransaction()
    tr.insertBlockNode(node)
    if (!tr.rejected) ed.dispatch(tr)
    return { ed, tr }
  }

  it('splits the block in the middle', () => {
    const { ed } = insert(doc(p('abcd')), caret([0, 0], 2))
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('ab'), atom(), p('cd'))))
    expect(ed.state.selection).toEqual(caret([2, 0], 0))
  })

  it('replaces an empty block, adding an empty paragraph after it', () => {
    const { ed } = insert(doc(p('')), caret([0, 0], 0))
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(atom(), p(''))))
    expect(ed.state.selection).toEqual(caret([1, 0], 0))
  })

  it('appends after the last block at its end', () => {
    const { ed } = insert(doc(p('ab')), caret([0, 0], 2))
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('ab'), atom(), p(''))))
    expect(ed.state.selection).toEqual(caret([2, 0], 0))
  })

  it('inserts after a block at its end when another block follows', () => {
    const { ed } = insert(doc(p('ab'), p('cd')), caret([0, 0], 2))
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('ab'), atom(), p('cd'))))
    expect(ed.state.selection).toEqual(caret([2, 0], 0))
  })

  it('inserts before a block at offset 0', () => {
    const { ed } = insert(doc(p('ab')), caret([0, 0], 0))
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(atom(), p('ab'))))
    expect(ed.state.selection).toEqual(caret([1, 0], 0))
  })

  it('replaces a selected node', () => {
    const { ed } = insert(doc(p('a'), el('strict', { src: 'x' }), p('b')), nodeSel([1], [0, 0], 1))
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('a'), atom(), p('b'))))
    expect(ed.state.selection).toEqual(caret([2, 0], 0))
  })

  it('rejects invalid data and leaves the tr rejected', () => {
    const ed = setup(doc(p('ab')), caret([0, 0], 1))
    const tr = ed.createTransaction()
    tr.insertBlockNode(el('strict', { bad: 1 }))
    expect(tr.rejected).toBe('src required')
  })
})
