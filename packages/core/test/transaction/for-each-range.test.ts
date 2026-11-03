import { describe, expect, it } from 'vitest'
import { createSelection } from '../../src/model/selection'
import { toRange } from '../../src/model/path'
import { setIdGenerator } from '../../src/model/id'
import { Registry } from '../../src/plugin/registry'
import type { EditorState } from '../../src/state'
import type { Mark, Path, Selection, SelectionRange } from '../../src/model/types'
import { Transaction } from '../../src/transaction/transaction'
import { doc, el, stripIds, txt } from '../../src/testing/builders'
import { testBold, testParagraph } from '../fixtures'

const registry = new Registry([testParagraph, testBold])
const bold: Mark = { type: 'bold', data: {} }

const at = (path: Path, offset: number) => ({ path, offset })
const caret = (path: Path, offset: number): SelectionRange => ({ anchor: at(path, offset), focus: at(path, offset) })
const span = (path: Path, from: number, to: number): SelectionRange => ({ anchor: at(path, from), focus: at(path, to) })

function trOf(d: ReturnType<typeof doc>, selection: Selection | null, storedMarks: Mark[] | null = null): Transaction {
  const state: EditorState = { doc: d, selection, storedMarks, pluginStates: new Map() }
  return new Transaction(state, registry)
}

/** A callback that inserts `text` at the range's focus with a primitive op; the caret ends after it. */
const insertAtFocus =
  (text: string) =>
  (range: SelectionRange, tr: Transaction): SelectionRange => {
    const { path, offset } = range.focus
    tr.apply({ type: 'insert_text', path, offset, text })
    return caret(path, offset + text.length)
  }

const textOf = (tr: Transaction, i = 0) => (tr.doc.children[i]!.children![0] as { text: string }).text

/** Inserts `text` at the range's focus but leaves the caret before it: the selection must be set at the end. */
const insertBeforeCaret =
  (text: string) =>
  (range: SelectionRange, tr: Transaction): SelectionRange => {
    const { path, offset } = range.focus
    tr.apply({ type: 'insert_text', path, offset, text })
    return caret(path, offset)
  }

describe('forEachRange', () => {
  it('later ranges see earlier inserts', () => {
    const tr = trOf(doc(el('paragraph', txt('abcd'))), createSelection([caret([0, 0], 1), caret([0, 0], 3)]))
    const seen: SelectionRange[] = []
    tr.forEachRange((range, t) => {
      seen.push(range)
      return insertAtFocus('X')(range, t)
    })
    expect(textOf(tr)).toBe('aXbcXd')
    expect(seen).toEqual([caret([0, 0], 1), caret([0, 0], 4)])
    expect(tr.selection).toEqual(createSelection([caret([0, 0], 2), caret([0, 0], 5)]))
  })

  it('later ranges see earlier deletes', () => {
    // Delete each selected span: "a[bc]d[ef]g" -> "adg", carets at 1 and 2.
    const tr = trOf(doc(el('paragraph', txt('abcdefg'))), createSelection([span([0, 0], 1, 3), span([0, 0], 4, 6)]))
    const seen: SelectionRange[] = []
    tr.forEachRange((range, t) => {
      seen.push(range)
      const from = range.anchor.offset
      const to = range.focus.offset
      t.apply({ type: 'remove_text', path: range.anchor.path, offset: from, text: textOf(t).slice(from, to) })
      return caret(range.anchor.path, from)
    })
    expect(textOf(tr)).toBe('adg')
    expect(seen[1]).toEqual(span([0, 0], 2, 4))
    expect(tr.selection).toEqual(createSelection([caret([0, 0], 1), caret([0, 0], 2)]))
  })

  it('a later caret at the point of an earlier insert stays after the inserted text', () => {
    // Range 1 is "b" (1-2); its callback inserts after the next character, at offset 3: exactly where
    // the second caret sits. The second caret keeps its own text ("d") after it: forward affinity.
    const tr = trOf(doc(el('paragraph', txt('abcde'))), createSelection([span([0, 0], 1, 2), caret([0, 0], 3)]))
    const seen: SelectionRange[] = []
    let first = true
    tr.forEachRange((range, t) => {
      seen.push(range)
      if (first) {
        first = false
        t.apply({ type: 'insert_text', path: [0, 0], offset: 3, text: 'XY' })
        return range
      }
      return range
    })
    expect(textOf(tr)).toBe('abcXYde')
    expect(seen[1]).toEqual(caret([0, 0], 5))
  })

  it('earlier results are mapped through later edits (backward at the same point)', () => {
    // The second callback inserts at offset 1, the first result's caret: that caret stays before it.
    const tr = trOf(doc(el('paragraph', txt('abcd'))), createSelection([caret([0, 0], 1), caret([0, 0], 3)]))
    // A second insert before it then shifts it.
    let k = 0
    tr.forEachRange((range, t) => {
      if (k++ === 1) {
        t.apply({ type: 'insert_text', path: [0, 0], offset: 1, text: 'Z' })
        t.apply({ type: 'insert_text', path: [0, 0], offset: 0, text: 'W' })
        return caret([0, 0], 5)
      }
      return range
    })
    expect(textOf(tr)).toBe('WaZbcd')
    expect(tr.selection).toEqual(createSelection([caret([0, 0], 2), caret([0, 0], 5)]))
  })

  it('null drops a range', () => {
    const tr = trOf(doc(el('paragraph', txt('abcdef'))), createSelection([caret([0, 0], 1), caret([0, 0], 3), caret([0, 0], 5)]))
    let k = 0
    tr.forEachRange((range) => (k++ === 1 ? null : range))
    expect(tr.selection).toEqual(createSelection([caret([0, 0], 1), caret([0, 0], 5)]))
  })

  it('every range dropped gives a null selection', () => {
    const tr = trOf(doc(el('paragraph', txt('abcd'))), createSelection([caret([0, 0], 1), caret([0, 0], 3)]))
    tr.forEachRange(() => null)
    expect(tr.selection).toBeNull()
  })

  it('main is preserved', () => {
    const tr = trOf(doc(el('paragraph', txt('abcdef'))), createSelection([caret([0, 0], 1), caret([0, 0], 3), caret([0, 0], 5)], 1))
    tr.forEachRange(insertAtFocus('X'))
    expect(tr.selection).toEqual(createSelection([caret([0, 0], 2), caret([0, 0], 5), caret([0, 0], 8)], 1))
    expect(tr.selection!.main).toBe(1)
  })

  it('main follows its range when an earlier range is dropped', () => {
    const tr = trOf(doc(el('paragraph', txt('abcdef'))), createSelection([caret([0, 0], 1), caret([0, 0], 3), caret([0, 0], 5)], 2))
    let k = 0
    tr.forEachRange((range) => (k++ === 0 ? null : range))
    expect(tr.selection).toEqual(createSelection([caret([0, 0], 3), caret([0, 0], 5)], 1))
  })

  it('one transaction: the edits, then one set_selection', () => {
    const tr = trOf(doc(el('paragraph', txt('abcd'))), createSelection([caret([0, 0], 1), caret([0, 0], 3)]))
    tr.forEachRange(insertBeforeCaret('X'))
    expect(tr.ops.map((op) => op.type)).toEqual(['insert_text', 'insert_text', 'set_selection'])
  })

  it('a single range adds no set_selection when the result is where the selection already is', () => {
    const tr = trOf(doc(el('paragraph', txt('abcd'))), createSelection([caret([0, 0], 1)]))
    tr.forEachRange(insertAtFocus('X'))
    expect(tr.ops).toEqual([{ type: 'insert_text', path: [0, 0], offset: 1, text: 'X' }])
    expect(tr.selection).toEqual(createSelection([caret([0, 0], 2)]))
  })

  it('a single range gives exactly the ops of the callback (existing helper with an explicit range)', () => {
    const run = (wrap: boolean) => {
      let n = 0
      setIdGenerator(() => `id${n++}`) // ids the edit creates match across both runs
      const tr = trOf(doc(el('paragraph', txt('abcd'), txt('ef', 'bold'))), createSelection([span([0, 0], 1, 3)]))
      if (wrap)
        tr.forEachRange((range, t) => {
          t.insertText('Q', range)
          return undefined // keeps the range the tr method left
        })
      else tr.insertText('Q')
      setIdGenerator(null)
      return { ops: stripIds(tr.ops as never), sel: tr.selection, marks: tr.storedMarks, doc: stripIds(tr.doc) }
    }
    expect(run(true)).toEqual(run(false))
  })

  /** The tr after `edit` alone vs. after `edit` inside a one-range forEachRange (stored marks set). */
  function parity(selection: SelectionRange, edit: (t: Transaction, range: SelectionRange) => void) {
    // One doc for both runs, so element ids in the ops match.
    const d = doc(el('paragraph', txt('abcd'), txt('ef', 'bold')), el('paragraph', txt('gh')))
    const run = (wrap: boolean) => {
      let n = 0
      setIdGenerator(() => `id${n++}`) // ids the edit creates match across both runs
      const tr = trOf(d, createSelection([selection]), [bold])
      if (wrap)
        tr.forEachRange((range, t) => {
          edit(t, range)
          return undefined // keeps the range the tr method left
        })
      else edit(tr, selection)
      setIdGenerator(null)
      return { ops: stripIds(tr.ops as never), sel: tr.selection, marks: tr.storedMarks, doc: stripIds(tr.doc) }
    }
    expect(run(true)).toEqual(run(false))
  }

  it('a single range gives exactly the ops of deleteRange with an explicit range', () => {
    parity({ anchor: at([0, 0], 1), focus: at([1, 0], 1) }, (t, range) => t.deleteRange(toRange(range)))
  })

  it('a single range gives exactly the ops of splitBlock', () => {
    // splitBlock has no explicit-range form yet (Task 5); with one range the selection is that range.
    parity(span([0, 0], 1, 3), (t) => t.splitBlock())
  })

  it('inForEachRange is true only during a callback', () => {
    const tr = trOf(doc(el('paragraph', txt('abcd'))), createSelection([caret([0, 0], 1), caret([0, 0], 3)]))
    const during: boolean[] = []
    expect(tr.inForEachRange).toBe(false)
    tr.forEachRange((range, t) => {
      during.push(t.inForEachRange)
      return range
    })
    expect(during).toEqual([true, true])
    expect(tr.inForEachRange).toBe(false)
  })

  it('inForEachRange is reset when a callback throws', () => {
    const tr = trOf(doc(el('paragraph', txt('abcd'))), createSelection([caret([0, 0], 1)]))
    expect(() =>
      tr.forEachRange(() => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(tr.inForEachRange).toBe(false)
  })

  it('a nested forEachRange throws', () => {
    const tr = trOf(doc(el('paragraph', txt('abcd'))), createSelection([caret([0, 0], 1)]))
    expect(() => tr.forEachRange((range, t) => (t.forEachRange((r) => r), range))).toThrow(/nested/i)
  })

  it('no selection: the callback never runs', () => {
    const tr = trOf(doc(el('paragraph', txt('abcd'))), null)
    let calls = 0
    tr.forEachRange((range) => (calls++, range))
    expect(calls).toBe(0)
    expect(tr.ops).toEqual([])
  })

  it('a range whose text is removed by an earlier step is re-homed, not lost', () => {
    // Range 1 removes the second paragraph; the caret that was in it moves to the nearest editable point.
    const tr = trOf(
      doc(el('paragraph', txt('ab')), el('paragraph', txt('cd')), el('paragraph', txt('ef'))),
      createSelection([caret([0, 0], 1), caret([1, 0], 1)]),
    )
    const seen: SelectionRange[] = []
    let k = 0
    tr.forEachRange((range, t) => {
      seen.push(range)
      if (k++ === 0) t.removeNode([1])
      return range
    })
    expect(seen).toEqual([caret([0, 0], 1), caret([0, 0], 2)])
  })

  describe('stored marks', () => {
    it('stored marks survive the per-range caret moves: every caret types with them', () => {
      const tr = trOf(doc(el('paragraph', txt('abcd'))), createSelection([caret([0, 0], 1), caret([0, 0], 3)]), [bold])
      tr.forEachRange((range, t) => {
        t.insertText('X', range)
        return undefined // keeps the range the tr method left
      })
      expect(stripIds(tr.doc)).toEqual(
        stripIds(doc(el('paragraph', txt('a'), txt('X', 'bold'), txt('bc'), txt('X', 'bold'), txt('d')))),
      )
    })

    it('are kept after a run that changed the doc, even though it moved the selection', () => {
      const tr = trOf(doc(el('paragraph', txt('abcd'))), createSelection([caret([0, 0], 1), caret([0, 0], 3)]), [bold])
      tr.forEachRange(insertBeforeCaret('X'))
      expect(tr.ops.at(-1)!.type).toBe('set_selection')
      expect(tr.storedMarks).toEqual([bold])
    })

    it('are cleared by a run that only moved the selection', () => {
      const tr = trOf(doc(el('paragraph', txt('abcd'))), createSelection([caret([0, 0], 1), caret([0, 0], 3)]), [bold])
      tr.forEachRange((range) => caret(range.focus.path, range.focus.offset + 1))
      expect(tr.selection).toEqual(createSelection([caret([0, 0], 2), caret([0, 0], 4)]))
      expect(tr.storedMarks).toBeNull()
    })

    it('do not depend on which caret consumed them: typing at only the first or only the last caret', () => {
      const typeAt = (which: number) => {
        const tr = trOf(doc(el('paragraph', txt('abcd'))), createSelection([caret([0, 0], 1), caret([0, 0], 3)]), [bold])
        let k = 0
        tr.forEachRange((range, t) => {
          if (k++ !== which) return range
          t.insertText('X', range)
          return undefined // keeps the range the tr method left
        })
        return tr.storedMarks
      }
      expect(typeAt(0)).toBeNull()
      expect(typeAt(1)).toBeNull()
    })

    it('a step that sets other marks wins over steps that left them alone', () => {
      const italic: Mark = { type: 'italic', data: {} }
      const setAt = (which: number) => {
        const tr = trOf(doc(el('paragraph', txt('abcd'))), createSelection([caret([0, 0], 1), caret([0, 0], 3)]), [bold])
        let k = 0
        tr.forEachRange((range, t) => {
          if (k++ === which) t.setStoredMarks([italic])
          return range
        })
        return tr.storedMarks
      }
      expect(setAt(0)).toEqual([italic])
      expect(setAt(1)).toEqual([italic])
    })

    it('are kept when no step changed them', () => {
      const tr = trOf(doc(el('paragraph', txt('abcd'))), createSelection([caret([0, 0], 1), caret([0, 0], 3)]), [bold])
      tr.forEachRange(insertBeforeCaret('X'))
      expect(tr.storedMarks).toEqual([bold])
    })
  })
})
