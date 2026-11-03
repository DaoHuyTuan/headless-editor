import { describe, expect, it } from 'vitest'
import { createSelection, isNodeRange, single } from '../../src/model/selection'
import type { Doc, ElementNode, Node, Path, Selection, SelectionRange } from '../../src/model/types'
import type { EditorState } from '../../src/state'
import { Transaction } from '../../src/transaction/transaction'
import { createTestEditor, doc, el, stripIds, txt } from '../../src/testing/index'
import { testBold, testParagraph } from '../fixtures'
import { deleteBackward, deleteForward } from '../../src/transaction/text'
import { record, registry, scenarios } from './single-range-scenarios'
import recorded from './single-range-ops.json'

const at = (path: Path, offset: number) => ({ path, offset })
const caret = (path: Path, offset: number): SelectionRange => ({ anchor: at(path, offset), focus: at(path, offset) })
const span = (path: Path, from: number, to: number): SelectionRange => ({ anchor: at(path, from), focus: at(path, to) })
const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))

function trOf(d: Doc, ...ranges: SelectionRange[]): Transaction {
  const state: EditorState = { doc: d, selection: createSelection(ranges), storedMarks: null, pluginStates: new Map() }
  return new Transaction(state, registry)
}

const texts = (tr: Transaction) =>
  tr.doc.children.map((b) =>
    b.type === 'paragraph'
      ? ((b as ElementNode).children ?? []).map((c) => ('text' in c ? c.text : `<${c.type}>`)).join('')
      : `<${b.type}>`,
  )
const sel = (...ranges: SelectionRange[]): Selection => createSelection(ranges)

describe('text editing on every range', () => {
  it('insertText types at every caret', () => {
    const tr = trOf(doc(p('foo bar foo')), caret([0, 0], 3), caret([0, 0], 11))
    tr.insertText('x')
    expect(texts(tr)).toEqual(['foox bar foox'])
    expect(tr.selection).toEqual(sel(caret([0, 0], 4), caret([0, 0], 13)))
  })

  it('insertText types at every caret (three carets)', () => {
    const tr = trOf(doc(p('a b c')), caret([0, 0], 1), caret([0, 0], 3), caret([0, 0], 5))
    tr.insertText('XY')
    expect(texts(tr)).toEqual(['aXY bXY cXY'])
    expect(tr.selection).toEqual(sel(caret([0, 0], 3), caret([0, 0], 7), caret([0, 0], 11)))
  })

  it('insertText keeps main on its range', () => {
    const tr = trOf(doc(p('a b c')), caret([0, 0], 1), caret([0, 0], 3), caret([0, 0], 5))
    const state: EditorState = { doc: tr.doc, selection: createSelection(tr.selection!.ranges, 1), storedMarks: null, pluginStates: new Map() }
    const t = new Transaction(state, registry)
    t.insertText('X')
    expect(t.selection!.main).toBe(1)
  })

  it('insertText replaces every non-empty range', () => {
    const tr = trOf(doc(p('foo bar foo')), span([0, 0], 0, 3), span([0, 0], 8, 11))
    tr.insertText('X')
    expect(texts(tr)).toEqual(['X bar X'])
    expect(tr.selection).toEqual(sel(caret([0, 0], 1), caret([0, 0], 7)))
  })

  it('insertText replaces ranges in different blocks, one across blocks', () => {
    const tr = trOf(doc(p('abc'), p('def'), p('ghi')), span([0, 0], 1, 2), { anchor: at([1, 0], 2), focus: at([2, 0], 1) })
    tr.insertText('X')
    expect(texts(tr)).toEqual(['aXc', 'deXhi'])
    expect(tr.selection).toEqual(sel(caret([0, 0], 2), caret([1, 0], 3)))
  })

  it('every insert is one transaction: the edits, then one set_selection', () => {
    // Stored marks: each insert is a new text node, so the carets must be set at the end.
    const tr = trOf(doc(p('foo bar foo')), caret([0, 0], 3), caret([0, 0], 11))
    tr.setStoredMarks([{ type: 'bold', data: {} }])
    tr.insertText('x')
    expect(tr.ops.map((op) => op.type)).toEqual(['split_node', 'insert_node', 'insert_node', 'set_selection'])
    expect(tr.selection).toEqual(sel(caret([0, 1], 1), caret([0, 3], 1)))
  })

  it('typing at carets adds no set_selection: the mapped carets already sit after the inserts', () => {
    const tr = trOf(doc(p('foo bar foo')), caret([0, 0], 3), caret([0, 0], 11))
    tr.insertText('x')
    expect(tr.ops.map((op) => op.type)).toEqual(['insert_text', 'insert_text'])
  })

  it('deleteBackward at every caret', () => {
    const tr = trOf(doc(p('abcdef')), caret([0, 0], 2), caret([0, 0], 5))
    tr.deleteBackward()
    expect(texts(tr)).toEqual(['acdf'])
    expect(tr.selection).toEqual(sel(caret([0, 0], 1), caret([0, 0], 3)))
  })

  it('deleteBackward at every caret (three carets, one merging blocks)', () => {
    const tr = trOf(doc(p('abc'), p('def')), caret([0, 0], 1), caret([0, 0], 3), caret([1, 0], 0))
    tr.deleteBackward()
    expect(texts(tr)).toEqual(['bdef'])
    expect(tr.selection).toEqual(sel(caret([0, 0], 0), caret([0, 0], 1)))
  })

  it('deleteForward at every caret', () => {
    const tr = trOf(doc(p('abcdef')), caret([0, 0], 1), caret([0, 0], 4))
    tr.deleteForward()
    expect(texts(tr)).toEqual(['acdf'])
    expect(tr.selection).toEqual(sel(caret([0, 0], 1), caret([0, 0], 3)))
  })

  it('deleteBackward word unit at every caret', () => {
    const tr = trOf(doc(p('foo bar baz')), caret([0, 0], 3), caret([0, 0], 11))
    tr.deleteBackward('word')
    expect(texts(tr)).toEqual([' bar '])
    expect(tr.selection).toEqual(sel(caret([0, 0], 0), caret([0, 0], 5)))
  })

  it('deleteForward word unit at every caret', () => {
    const tr = trOf(doc(p('foo bar baz')), caret([0, 0], 0), caret([0, 0], 7))
    tr.deleteForward('word')
    expect(texts(tr)).toEqual([' bar'])
    expect(tr.selection).toEqual(sel(caret([0, 0], 0), caret([0, 0], 4)))
  })

  it('deleteBackward at adjacent carets merges them', () => {
    const tr = trOf(doc(p('abcd')), caret([0, 0], 2), caret([0, 0], 3))
    tr.deleteBackward()
    expect(texts(tr)).toEqual(['ad'])
    expect(tr.selection).toEqual(single(caret([0, 0], 1)))
  })

  it('deleteBackward deletes every non-empty range', () => {
    const tr = trOf(doc(p('abcdef')), span([0, 0], 0, 2), span([0, 0], 3, 5))
    tr.deleteBackward()
    expect(texts(tr)).toEqual(['cf'])
    expect(tr.selection).toEqual(sel(caret([0, 0], 0), caret([0, 0], 1)))
  })

  it('Backspace next to an opaque block with several carets leaves that caret in place and deletes at the others', () => {
    const tr = trOf(doc(p('ab'), el('atom'), p('cd')), caret([0, 0], 2), caret([2, 0], 0))
    expect(deleteBackward(tr)).toBe(true)
    expect(texts(tr)).toEqual(['a', '<atom>', 'cd'])
    expect(tr.selection!.ranges).toHaveLength(2)
    expect(tr.selection!.ranges.some(isNodeRange)).toBe(false)
    expect(tr.selection).toEqual(sel(caret([0, 0], 1), caret([2, 0], 0)))
  })

  it('Delete next to an opaque block with several carets leaves that caret in place and deletes at the others', () => {
    const tr = trOf(doc(p('ab'), el('atom'), p('cd')), caret([0, 0], 2), caret([2, 0], 1))
    expect(deleteForward(tr)).toBe(true)
    expect(texts(tr)).toEqual(['ab', '<atom>', 'c'])
    expect(tr.selection).toEqual(sel(caret([0, 0], 2), caret([2, 0], 1)))
  })

  it('Backspace with every caret next to an opaque block does nothing and keeps every caret', () => {
    const tr = trOf(doc(p('ab'), el('atom'), p('cd'), el('atom'), p('ef')), caret([2, 0], 0), caret([4, 0], 0))
    tr.deleteBackward()
    expect(tr.ops).toEqual([])
    expect(tr.selection).toEqual(sel(caret([2, 0], 0), caret([4, 0], 0)))
  })

  it('with one caret, Backspace next to an opaque block still node-selects', () => {
    const tr = trOf(doc(p('ab'), el('atom'), p('cd')), caret([2, 0], 0))
    expect(deleteBackward(tr)).toBe(true)
    expect(tr.selection!.ranges).toHaveLength(1)
    expect(tr.selection!.ranges[0]).toEqual({ ...caret([0, 0], 2), node: [1] })
    expect(texts(tr)).toEqual(['ab', '<atom>', 'cd'])
  })

  it('splitBlock at two carets in one block gives three blocks, carets at the starts of blocks 2 and 3', () => {
    const tr = trOf(doc(p('abcd')), caret([0, 0], 1), caret([0, 0], 3))
    tr.splitBlock()
    expect(texts(tr)).toEqual(['a', 'bc', 'd'])
    expect(tr.selection).toEqual(sel(caret([1, 0], 0), caret([2, 0], 0)))
    const ids = tr.doc.children.map((b) => (b as ElementNode).id)
    expect(new Set(ids).size).toBe(3)
  })

  it('splitBlock at three carets in two blocks', () => {
    const tr = trOf(doc(p('abc'), p('de')), caret([0, 0], 1), caret([0, 0], 2), caret([1, 0], 1))
    tr.splitBlock()
    expect(texts(tr)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(tr.selection).toEqual(sel(caret([1, 0], 0), caret([2, 0], 0), caret([4, 0], 0)))
  })

  it('insertBlockNode at every caret, each copy with its own id', () => {
    const tr = trOf(doc(p('abcd')), caret([0, 0], 1), caret([0, 0], 3))
    tr.insertBlockNode(el('atom'))
    expect(texts(tr)).toEqual(['a', '<atom>', 'bc', '<atom>', 'd'])
    expect(tr.selection).toEqual(sel(caret([2, 0], 0), caret([4, 0], 0)))
    const ids = tr.doc.children.map((b) => (b as ElementNode).id)
    expect(new Set(ids).size).toBe(5)
  })

  it('deleteRange with no range deletes every range', () => {
    const tr = trOf(doc(p('abcdef')), span([0, 0], 0, 2), span([0, 0], 3, 5))
    tr.deleteRange()
    expect(texts(tr)).toEqual(['cf'])
    expect(tr.selection).toEqual(sel(caret([0, 0], 0), caret([0, 0], 1)))
  })

  describe('explicit range', () => {
    it('explicit at acts only there and maps the other caret', () => {
      const tr = trOf(doc(p('abcd')), caret([0, 0], 1), caret([0, 0], 3))
      tr.insertText('X', caret([0, 0], 1))
      expect(texts(tr)).toEqual(['aXbcd'])
      expect(tr.selection).toEqual(sel(caret([0, 0], 2), caret([0, 0], 4)))
    })

    it('explicit deleteRange acts only there and maps the other caret', () => {
      const tr = trOf(doc(p('abcdef')), caret([0, 0], 1), caret([0, 0], 5))
      tr.deleteRange({ start: at([0, 0], 1), end: at([0, 0], 3) })
      expect(texts(tr)).toEqual(['adef'])
      expect(tr.selection).toEqual(sel(caret([0, 0], 1), caret([0, 0], 3)))
    })

    it('explicit at that touches no range replaces main and maps the others', () => {
      const tr = trOf(doc(p('abcdef')), caret([0, 0], 1), caret([0, 0], 5))
      tr.insertText('X', caret([0, 0], 3))
      // As with one range, the (main) range moves to the result; the other caret maps past the insert.
      expect(texts(tr)).toEqual(['abcXdef'])
      expect(tr.selection).toEqual(sel(caret([0, 0], 4), caret([0, 0], 6)))
    })

    it('explicit at touching main and another range replaces main', () => {
      const state: EditorState = {
        doc: doc(p('hello world')),
        selection: createSelection([caret([0, 0], 0), caret([0, 0], 5)], 1),
        storedMarks: null,
        pluginStates: new Map(),
      }
      const tr = new Transaction(state, registry)
      tr.insertText('HELLO', span([0, 0], 0, 5))
      expect(texts(tr)).toEqual(['HELLO world'])
      // Main (at 5) touches `at`, so it becomes the caret after the insert; the caret at 0 is mapped
      // and stays at 0: two carets remain, at 0 and 5, with main at 5.
      expect(tr.selection).toEqual(createSelection([caret([0, 0], 0), caret([0, 0], 5)], 1))
    })

    it('explicit deleteBackward next to an opaque block with several ranges does nothing', () => {
      const tr = trOf(doc(p('ab'), el('atom'), p('cd')), span([2, 0], 0, 1), caret([0, 0], 1))
      const before = tr.selection
      expect(deleteBackward(tr, 'character', caret([2, 0], 0))).toBe(false)
      expect(tr.ops).toEqual([])
      expect(tr.selection).toEqual(before)
    })

    it('deleteRange takes a selection range', () => {
      const tr = trOf(doc(p('abcdef')), caret([0, 0], 1), caret([0, 0], 5))
      tr.deleteRange(span([0, 0], 3, 1))
      expect(texts(tr)).toEqual(['adef'])
    })

    it('explicit splitBlock and deleteBackward act only there', () => {
      const tr = trOf(doc(p('abcdef')), caret([0, 0], 1), caret([0, 0], 5))
      tr.deleteBackward('character', caret([0, 0], 5))
      expect(texts(tr)).toEqual(['abcdf'])
      tr.splitBlock(caret([0, 0], 1))
      expect(texts(tr)).toEqual(['a', 'bcdf'])
      expect(tr.selection).toEqual(sel(caret([1, 0], 0), caret([1, 0], 3)))
    })
  })

  describe('ranges swallowed by an earlier step', () => {
    it('forward word delete: a later caret inside the deleted word is merged, not run', () => {
      const tr = trOf(doc(p('abcd ef')), caret([0, 0], 0), caret([0, 0], 2))
      tr.deleteForward('word')
      expect(texts(tr)).toEqual([' ef'])
      expect(tr.selection).toEqual(single(caret([0, 0], 0)))
    })

    it('forward word delete: a caret inside the next word is merged, not run', () => {
      const tr = trOf(doc(p('foo bar baz')), caret([0, 0], 3), caret([0, 0], 5))
      tr.deleteForward('word')
      expect(texts(tr)).toEqual(['foo baz'])
      expect(tr.selection).toEqual(single(caret([0, 0], 3)))
    })

    it('a caret exactly at the edge of the removal still runs its own step', () => {
      const tr = trOf(doc(p('abcd')), caret([0, 0], 1), caret([0, 0], 2))
      tr.deleteForward()
      expect(texts(tr)).toEqual(['ad'])
      expect(tr.selection).toEqual(single(caret([0, 0], 1)))
    })

    it('backward word delete at two carets in one word', () => {
      const tr = trOf(doc(p('foo bar')), caret([0, 0], 5), caret([0, 0], 7))
      tr.deleteBackward('word')
      expect(texts(tr)).toEqual(['foo '])
      expect(tr.selection).toEqual(single(caret([0, 0], 4)))
    })

    describe('a word across text leaves (mark boundaries)', () => {
      const bold = (t: string) => txt(t, 'bold')
      const fwdWord = (d: Doc, ...ranges: SelectionRange[]) => {
        const tr = trOf(d, ...ranges)
        tr.deleteForward('word')
        return tr
      }
      it('G2: second caret inside the first leaf', () => {
        const tr = fwdWord(doc(p(bold('ab'), 'cd ef')), caret([0, 0], 0), caret([0, 0], 2))
        expect(texts(tr)).toEqual([' ef'])
        expect(tr.selection!.ranges).toHaveLength(1)
      })
      it('G3: second caret at the start of the next leaf', () => {
        const tr = fwdWord(doc(p(bold('ab'), 'cd ef')), caret([0, 0], 0), caret([0, 1], 0))
        expect(texts(tr)).toEqual([' ef'])
        // In the tr the carets sit at one position written in two leaves (the emptied bold one and the
        // next); the commit-time cleanup of empty texts merges them.
        const ed = createTestEditor({
          plugins: [testParagraph, testBold],
          doc: doc(p(bold('ab'), 'cd ef')),
          selection: sel(caret([0, 0], 0), caret([0, 1], 0)),
        })
        ed.commands.deleteForward('word')
        expect(ed.state.selection!.ranges).toHaveLength(1)
      })
      it('G4: second caret at the start of a middle leaf', () => {
        const tr = fwdWord(doc(p('a', bold('b'), 'c d')), caret([0, 0], 0), caret([0, 1], 0))
        expect(texts(tr)).toEqual([' d'])
      })
      it('G5: second caret at the end of a middle leaf', () => {
        const tr = fwdWord(doc(p('a', bold('b'), 'c d')), caret([0, 0], 0), caret([0, 1], 1))
        expect(texts(tr)).toEqual([' d'])
      })
      it('a caret at the edge of the removal, written in the next leaf, still runs', () => {
        const tr = trOf(doc(p(bold('ab'), 'cd')), caret([0, 0], 1), caret([0, 1], 0))
        tr.deleteForward()
        expect(texts(tr)).toEqual(['ad'])
      })
      it('a caret at the edge of the removal, written in the earlier leaf, still runs', () => {
        const tr = trOf(doc(p(bold('ab'), 'cd')), caret([0, 0], 1), caret([0, 0], 2))
        tr.deleteForward()
        expect(texts(tr)).toEqual(['ad'])
      })
    })

    it('a range only partly swallowed still runs on what is left', () => {
      // Caret 0 deletes "abcd"; the range 2-6 keeps its unremoved part " e" and deletes it.
      const tr = trOf(doc(p('abcd efg')), caret([0, 0], 0), span([0, 0], 2, 6))
      tr.deleteForward('word')
      expect(texts(tr)).toEqual(['fg'])
    })
  })

  describe('inside forEachRange', () => {
    it('explicit calls emit no set_selection of their own; a callback returning nothing keeps the range they left', () => {
      const tr = trOf(doc(p('abcd')), caret([0, 0], 1), caret([0, 0], 3))
      tr.forEachRange((range, t) => {
        t.insertText('X', range)
      })
      expect(texts(tr)).toEqual(['aXbcXd'])
      // The mapped carets already sit after the inserts: no set_selection at all.
      expect(tr.ops.map((op) => op.type)).toEqual(['insert_text', 'insert_text'])
      expect(tr.selection).toEqual(sel(caret([0, 0], 2), caret([0, 0], 5)))
    })

    it('the live selection is not collapsed partway through the run', () => {
      const tr = trOf(doc(p('abcd')), caret([0, 0], 1), caret([0, 0], 3))
      const lengths: number[] = []
      tr.forEachRange((range, t) => {
        t.insertText('X', range)
        lengths.push(t.selection!.ranges.length)
      })
      expect(lengths).toEqual([2, 2])
    })

    it('an explicit edit away from the callback range leaves that range mapped', () => {
      const tr = trOf(doc(p('abc def')), caret([0, 0], 2), caret([0, 0], 6))
      tr.forEachRange((range, t) => {
        t.insertText('>', caret(range.anchor.path, 0))
      })
      expect(texts(tr)).toEqual(['>>abc def'])
      expect(tr.selection).toEqual(sel(caret([0, 0], 4), caret([0, 0], 8)))
    })

    it('no-range call inside forEachRange throws in dev', () => {
      const ed = createTestEditor({ plugins: [testParagraph], doc: doc(p('abcd')) })
      const tr = ed.createTransaction()
      expect(tr.dev).toBe(true)
      expect(() => tr.forEachRange(() => void tr.insertText('X'))).toThrow(/forEachRange/)
      expect(() => tr.forEachRange(() => void tr.deleteBackward())).toThrow(/forEachRange/)
    })

    it('outside dev, a no-range call inside forEachRange acts at the callback range', () => {
      const tr = trOf(doc(p('abcd')), caret([0, 0], 1), caret([0, 0], 3))
      expect(tr.dev).toBe(false)
      tr.forEachRange((_range, t) => {
        t.insertText('X')
      })
      expect(texts(tr)).toEqual(['aXbcXd'])
      expect(tr.selection).toEqual(sel(caret([0, 0], 2), caret([0, 0], 5)))
    })
  })

  it('selectAll collapses to one range', () => {
    const tr = trOf(doc(p('ab'), p('cd')), caret([0, 0], 1), caret([1, 0], 1))
    tr.forEachRange((r) => r) // no-op
    expect(tr.selection!.ranges).toHaveLength(2)
    const ed = createTestEditor({ plugins: [testParagraph], doc: doc(p('ab'), p('cd')), selection: sel(caret([0, 0], 1), caret([1, 0], 1)) })
    expect(ed.commands.selectAll()).toBe(true)
    expect(ed.state.selection).toEqual(single({ anchor: at([0, 0], 0), focus: at([1, 0], 2) }))
  })

  it('one undo step for an edit at every caret', () => {
    const ed = createTestEditor({ plugins: [testParagraph], doc: doc(p('abcd')), selection: sel(caret([0, 0], 1), caret([0, 0], 3)) })
    const before = stripIds(ed.state.doc as Doc)
    ed.commands.insertText('X')
    expect(stripIds(ed.state.doc as Doc)).toEqual(stripIds(doc(p('aXbcXd'))))
    ed.commands.undo()
    expect(stripIds(ed.state.doc as Doc)).toEqual(before)
  })
})

describe('single-range parity with the implementation before multi-range editing', () => {
  const old = recorded as unknown as Record<string, ReturnType<typeof record>>
  for (const s of scenarios) {
    it(s.name, () => {
      const was = old[s.name]!
      const now = record(s)
      const docOps = (ops: unknown[]) => ops.filter((op) => (op as { type: string }).type !== 'set_selection')
      // The edits are identical; the intermediate set_selection ops the helpers used to add are gone:
      // at most one set_selection, last, and only when the old ones moved the selection.
      expect(docOps(now.ops)).toEqual(docOps(was.ops))
      const selOps = now.ops.filter((op) => (op as { type: string }).type === 'set_selection')
      expect(selOps.length).toBeLessThanOrEqual(1)
      if (selOps.length === 1) expect(now.ops.at(-1)).toBe(selOps[0])
      if (was.ops.length === docOps(was.ops).length) expect(selOps).toHaveLength(0)
      expect(now.selection).toEqual(was.selection)
      expect(now.storedMarks).toEqual(was.storedMarks)
      expect(now.doc).toEqual(was.doc)
      expect(now.returned).toEqual(was.returned)
    })
  }
})
