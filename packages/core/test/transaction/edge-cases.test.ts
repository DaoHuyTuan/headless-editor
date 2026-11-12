import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { definePlugin } from '../../src/plugin/define'
import { addMark, removeMark } from '../../src/transaction/marks'
import { insertFragment } from '../../src/transaction/fragment'
import { setIdGenerator } from '../../src/model/id'
import type { ElementNode, Mark, Node } from '../../src/model/types'
import { createTestEditor, doc, el, sel, stripIds, txt } from '../../src/testing/index'
import { testBold, testParagraph } from '../fixtures'

const bold: Mark = { type: 'bold', data: {} }
const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))

function setup(content = doc(p('ab')), selection = sel([0, 0], 1)) {
  return createTestEditor({ plugins: [testParagraph, testBold], doc: content, selection })
}

describe('insertText with empty text (3.3)', () => {
  it("insertText('') at a caret keeps the stored marks", () => {
    const ed = setup()
    const tr = ed.createTransaction()
    tr.setStoredMarks([bold])
    tr.insertText('')
    expect(tr.storedMarks).toEqual([bold])
    expect(tr.ops.filter((op) => op.type !== 'set_selection')).toHaveLength(0)
  })

  it("insertText('') over a range deletes it", () => {
    const ed = setup(doc(p('abc')), sel([0, 0], 0, [0, 0], 2))
    expect(ed.commands.insertText('')).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('c'))))
  })

  it('an empty insertText intent at a caret changes nothing and keeps the stored marks', () => {
    const ed = setup()
    const tr = ed.createTransaction()
    tr.setStoredMarks([bold])
    ed.dispatch(tr)
    const before = ed.state
    expect(ed.handleIntent({ inputType: 'insertText', data: '', range: null })).toBe(true)
    expect(ed.state).toBe(before)
    expect(ed.state.storedMarks).toEqual([bold])
  })

  it('an intent with a different target collapses there and drops the stored marks', () => {
    const ed = setup()
    const tr = ed.createTransaction()
    tr.setStoredMarks([bold])
    ed.dispatch(tr)
    ed.handleIntent({
      inputType: 'insertReplacementText',
      data: '',
      range: { anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 0 } },
    })
    expect(ed.state.selection).toEqual(sel([0, 0], 0))
    expect(ed.state.storedMarks).toBeNull()
  })

  it('a Backspace with nothing to delete keeps the stored marks', () => {
    const ed = setup(doc(p('ab')), sel([0, 0], 0))
    const tr = ed.createTransaction()
    tr.setStoredMarks([bold])
    ed.dispatch(tr)
    expect(ed.handleIntent({ inputType: 'deleteContentBackward', data: null, range: null })).toBe(true)
    expect(ed.state.storedMarks).toEqual([bold])
  })
})

describe('toggleMark edge cases (3.4)', () => {
  const atom = definePlugin({ name: 'chip', node: { kind: 'inline', atom: true } })
  /** A mark whose validator coerces: `{ size: '12' }` becomes `{ size: 12 }`. */
  const size = definePlugin({
    name: 'size',
    mark: { render: () => ({ tag: 'span' }) },
    data: z.object({ size: z.coerce.number() }),
  })

  it('a range covering no characters toggles the stored marks, both ways', () => {
    // [0,0]:0 to [0,2]:0 spans only the chip (and empty texts around it).
    const content = doc(p('', el('chip', {}), ''))
    const ed = createTestEditor({ plugins: [testParagraph, testBold, atom], doc: content, selection: sel([0, 0], 0, [0, 2], 0) })
    expect(ed.commands.toggleMark('bold')).toBe(true)
    expect(ed.state.storedMarks).toEqual([bold])
    expect(ed.isActive('bold')).toBe(true)
    expect(ed.commands.toggleMark('bold')).toBe(true)
    expect(ed.state.storedMarks).toEqual([])
    expect(ed.isActive('bold')).toBe(false)
  })

  it('typing over such a range after the toggle types bold', () => {
    const content = doc(p('', el('chip', {}), ''))
    const ed = createTestEditor({ plugins: [testParagraph, testBold, atom], doc: content, selection: sel([0, 0], 0, [0, 2], 0) })
    ed.commands.toggleMark('bold')
    ed.handleIntent({ inputType: 'insertText', data: 'x', range: null })
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p({ text: 'x', marks: [bold] }))))
  })

  it('decides the direction with the validated data', () => {
    const content = doc(p({ text: 'ab', marks: [{ type: 'size', data: { size: 12 } }] }))
    const ed = createTestEditor({ plugins: [testParagraph, size], doc: content, selection: sel([0, 0], 0, [0, 0], 2) })
    // `{ size: '12' }` validates to `{ size: 12 }`, which the text already has: the toggle removes it.
    expect(ed.commands.toggleMark('size', { size: '12' })).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('ab'))))
  })

  it('a caret toggle that leaves the stored marks as they are changes nothing', () => {
    const ed = setup(doc(p({ text: 'ab', marks: [bold] })), sel([0, 0], 1))
    const before = ed.state
    // Bold is already active at the caret: setMark keeps the same set, so nothing is dispatched.
    expect(ed.commands.setMark('bold')).toBe(true)
    expect(ed.state).toBe(before)
    const tr = ed.createTransaction()
    tr.setStoredMarks([bold])
    const stored = tr.storedMarks
    tr.addMark(bold)
    expect(tr.storedMarks).toBe(stored)
  })

  it('addMark / removeMark with an explicit collapsed range change nothing, not even the stored marks', () => {
    const ed = setup(doc(p('ab')), sel([0, 0], 1))
    const tr = ed.createTransaction()
    const at = { anchor: { path: [0, 0], offset: 1 }, focus: { path: [0, 0], offset: 1 } }
    // True, as recorded in the single-range mark parity scenarios.
    expect(addMark(tr, bold, at)).toBe(true)
    expect(removeMark(tr, 'bold', at)).toBe(true)
    expect(tr.ops).toHaveLength(0)
    expect(tr.storedMarks).toBeNull()
  })
})

describe('fragments (3.5)', () => {
  const quote = definePlugin({ name: 'quote', node: { kind: 'block', content: 'block+' } })
  const inl = definePlugin({ name: 'link', node: { kind: 'inline' } })
  const pq = (t: string) => p(t)
  const json = (ed: ReturnType<typeof createTestEditor>) => stripIds(ed.getJSON())

  it('a lone container block goes in whole, splitting the text block', () => {
    const ed = createTestEditor({ plugins: [testParagraph, quote], doc: doc(p('xy')), selection: sel([0, 0], 1) })
    ed.commands.insertContent([el('quote', pq('a'), pq('b'))])
    expect(json(ed)).toEqual(stripIds(doc(p('x'), el('quote', pq('a'), pq('b')), p('y'))))
    expect(ed.state.selection).toEqual(sel([1, 1, 0], 1))
  })

  it('a container pasted inside a container nests there', () => {
    const ed = createTestEditor({ plugins: [testParagraph, quote], doc: doc(el('quote', p('xy'))), selection: sel([0, 0, 0], 1) })
    ed.commands.insertContent([el('quote', pq('a'), pq('b'))])
    expect(json(ed)).toEqual(stripIds(doc(el('quote', p('x'), el('quote', pq('a'), pq('b')), p('y')))))
  })

  it('a container at an edge of several blocks goes in whole too', () => {
    const ed = createTestEditor({ plugins: [testParagraph, quote], doc: doc(p('xy')), selection: sel([0, 0], 1) })
    ed.commands.insertContent([el('quote', pq('a'), pq('b')), p('2')])
    expect(json(ed)).toEqual(stripIds(doc(p('x'), el('quote', pq('a'), pq('b')), p('2y'))))
    const ed2 = createTestEditor({ plugins: [testParagraph, quote], doc: doc(p('xy')), selection: sel([0, 0], 1) })
    ed2.commands.insertContent([p('1'), el('quote', pq('a'), pq('b'))])
    expect(json(ed2)).toEqual(stripIds(doc(p('x1'), el('quote', pq('a'), pq('b')), p('y'))))
  })

  it('an empty-string id gets a fresh one', () => {
    const ed = createTestEditor({ plugins: [testParagraph], doc: doc(p('xy')), selection: sel([0, 0], 2) })
    const tr = ed.createTransaction()
    // Straight to the transaction (no sanitize step): `''` is no id. The middle block goes in whole.
    const blank = (t: string): ElementNode => ({ id: '', type: 'paragraph', data: {}, children: [txt(t)] })
    insertFragment(tr, [p('a'), blank('b'), p('c')])
    ed.dispatch(tr)
    const ids = ed.state.doc.children.map((b) => (b as ElementNode).id)
    expect(ids).not.toContain('')
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('splitting an inline ancestor for a block paste never reuses an id in the doc', () => {
    // A generator that would hand out an id already used in the doc.
    const ed = createTestEditor({
      plugins: [testParagraph, inl],
      doc: doc(p('', el('link', txt('xy')), '')),
      selection: sel([0, 1, 0], 1),
    })
    const taken = (ed.state.doc.children[0] as ElementNode).id
    const fragment = [p('1'), p('2')]
    // Every other id is one the doc already has (a loop that checks skips it; one that doesn't, keeps it).
    let calls = 0
    setIdGenerator(() => (++calls % 2 === 1 ? taken : `g${calls}`))
    try {
      const tr = ed.createTransaction()
      insertFragment(tr, fragment)
      ed.dispatch(tr)
    } finally {
      setIdGenerator(null)
    }
    const all: string[] = []
    const walk = (n: Node) => {
      if ('id' in n) {
        all.push(n.id)
        n.children?.forEach(walk)
      }
    }
    ed.getJSON().children.forEach(walk)
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('data references (3.10)', () => {
  const box = definePlugin({ name: 'box', node: { kind: 'block', content: 'inline' } })
  const tag = definePlugin({ name: 'tag', mark: { render: () => ({ tag: 'span' }) } })

  it('split halves get their own data objects', () => {
    const ed = createTestEditor({ plugins: [testParagraph, box], doc: doc(el('box', { meta: { n: 1 } }, txt('ab'))), selection: sel([0, 0], 1) })
    ed.commands.splitBlock()
    const [left, right] = ed.state.doc.children as ElementNode[]
    expect(right!.data).toEqual(left!.data)
    expect(right!.data).not.toBe(left!.data)
    expect(right!.data.meta).not.toBe(left!.data.meta)
  })

  it("inserted node data does not alias the caller's object", () => {
    const ed = setup(doc(p('ab')), sel([0, 0], 2))
    const data = { meta: { n: 1 } }
    const tr = ed.createTransaction()
    tr.insertNode([1], el('paragraph', data, txt('x')))
    ed.dispatch(tr)
    data.meta.n = 2
    expect((ed.state.doc.children[1] as ElementNode).data).toEqual({ meta: { n: 1 } })
  })

  it("setNodeData does not alias the caller's nested objects", () => {
    const ed = setup(doc(p('ab')), sel([0, 0], 2))
    const partial = { meta: { n: 1 } }
    ed.commands.setNodeData([0], partial)
    partial.meta.n = 2
    expect((ed.state.doc.children[0] as ElementNode).data).toEqual({ meta: { n: 1 } })
  })

  it("mark data does not alias the caller's object", () => {
    const ed = createTestEditor({ plugins: [testParagraph, tag], doc: doc(p('ab')), selection: sel([0, 0], 0, [0, 0], 2) })
    const data = { meta: { n: 1 } }
    ed.commands.setMark('tag', data)
    data.meta.n = 2
    const text = (ed.state.doc.children[0] as ElementNode).children![0] as { marks: Mark[] }
    expect(text.marks[0]!.data).toEqual({ meta: { n: 1 } })
  })
})

describe('inline atoms (3.14)', () => {
  const chip = definePlugin({
    name: 'chip',
    node: { kind: 'inline', atom: true },
    data: z.object({ id: z.string() }),
  })
  const link = definePlugin({ name: 'link', node: { kind: 'inline' } })

  it('insertInlineNode returns false only with a rejected tr when it leaves ops (never applied)', () => {
    const ed = createTestEditor({ plugins: [testParagraph, chip], doc: doc(p('ab')), selection: sel([0, 0], 1) })
    const tr = ed.createTransaction()
    tr.insertInlineNode(el('chip', { id: 42 } as never))
    expect(tr.rejected).not.toBeNull()
    expect(() => ed.dispatch(tr)).toThrow()
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('ab'))))
  })

  it('typing at the end of a trailing link types outside it (rule 10 adds a text after the link)', () => {
    const ed = createTestEditor({ plugins: [testParagraph, link], doc: doc(p('a', el('link', {}, txt('url')))) })
    // The caret at the end of the paragraph is in the empty text after the link.
    const tr = ed.createTransaction()
    tr.setSelection(sel([0, 2], 0))
    ed.dispatch(tr)
    ed.handleIntent({ inputType: 'insertText', data: 'x', range: null })
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('a', el('link', {}, txt('url')), 'x'))))
  })
})

describe('multi-range selections at commit (3.15)', () => {
  const r = (ap: number[], ao: number, fp: number[], fo: number) => ({ anchor: { path: ap, offset: ao }, focus: { path: fp, offset: fo } })
  const commit = (content: ReturnType<typeof doc>, ranges: ReturnType<typeof r>[]) => {
    const ed = setup(content, sel([0, 0], 0))
    const tr = ed.createTransaction()
    // A raw op: the ranges go in exactly as written.
    tr.apply({ type: 'set_selection', selection: { ranges, main: 0 }, prevSelection: tr.selection })
    ed.dispatch(tr)
    return ed.state.selection!
  }
  const twoTexts = () => doc(p('ab', { text: 'cd', marks: [bold] }))

  it('ranges that touch across a text-node boundary merge', () => {
    const out = commit(twoTexts(), [r([0, 0], 0, [0, 0], 2), r([0, 1], 0, [0, 1], 1)])
    expect(out.ranges).toHaveLength(1)
    expect(out.ranges[0]).toEqual(r([0, 0], 0, [0, 1], 1))
  })

  it('two carets at one position written in two leaves merge', () => {
    const out = commit(twoTexts(), [r([0, 0], 2, [0, 0], 2), r([0, 1], 0, [0, 1], 0)])
    expect(out.ranges).toEqual([r([0, 0], 2, [0, 0], 2)])
  })

  it('ranges with a character between them stay apart', () => {
    const out = commit(twoTexts(), [r([0, 0], 0, [0, 0], 1), r([0, 1], 0, [0, 1], 1)])
    expect(out.ranges).toHaveLength(2)
  })

  it('a half-invalid range collapses at its re-homed point instead of spanning blocks', () => {
    const out = commit(doc(p('ab'), p('cd'), p('ef')), [r([0, 0], 1, [9, 0], 0), r([1, 0], 1, [1, 0], 1)])
    for (const range of out.ranges) expect(range.anchor).toEqual(range.focus)
    expect(out.ranges.map((x) => x.anchor)).toContainEqual({ path: [2, 0], offset: 2 })
  })
})

describe('forEachRange and a delete-then-reinsert (3.15, documented)', () => {
  it('a later caret inside the re-inserted text is swallowed: not run, mapped past the insert', () => {
    const ed = setup(doc(p('abcd')), sel([0, 0], 0))
    const c = (o: number) => ({ anchor: { path: [0, 0], offset: o }, focus: { path: [0, 0], offset: o } })
    const tr = ed.createTransaction()
    tr.setSelection({ ranges: [c(1), c(3)], main: 0 })
    const runs: number[] = []
    tr.forEachRange((_range, t, i) => {
      runs.push(i)
      if (i !== 0) return
      t.deleteRange({ anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 4 } })
      t.insertText('abcd', c(0))
      return c(1)
    })
    expect(runs).toEqual([0])
    expect(tr.selection!.ranges).toEqual([c(1), c(4)])
  })
})

describe('coverage gaps (3.16)', () => {
  const italic = definePlugin({ name: 'italic', mark: { render: () => ({ tag: 'em' }) } })
  const quote = definePlugin({ name: 'quote', node: { kind: 'block', content: 'block+' } })
  const it_: Mark = { type: 'italic', data: {} }

  it('Backspace at the start of a second text ([0, 1]:0) deletes the last character of the text before it', () => {
    const ed = setup(doc(p('ab', txt('cd', 'bold'))), sel([0, 1], 0))
    expect(ed.commands.deleteBackward()).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('a', txt('cd', 'bold')))))
    expect(ed.state.selection).toEqual(sel([0, 0], 1))
  })

  it('Backspace at [0, 1]:0 after a one-character text removes that text and keeps the marks after it', () => {
    const ed = setup(doc(p('a', txt('cd', 'bold'))), sel([0, 1], 0))
    expect(ed.commands.deleteBackward()).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p(txt('cd', 'bold')))))
    expect(ed.state.selection).toEqual(sel([0, 0], 0))
  })

  it('a delete across blocks with several marks keeps each side’s marks and merges the blocks', () => {
    const ed = createTestEditor({
      plugins: [testParagraph, testBold, italic],
      doc: doc(p(txt('ab', bold, it_), 'c'), p(txt('de', it_), txt('fg', bold))),
      selection: sel([0, 0], 1, [1, 1], 1),
    })
    expect(ed.commands.deleteBackward()).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p(txt('a', bold, it_), txt('g', bold)))))
    expect(ed.state.selection).toEqual(sel([0, 0], 1))
    expect(ed.commands.undo()).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p(txt('ab', bold, it_), 'c'), p(txt('de', it_), txt('fg', bold)))))
  })

  it('a block paste at the end of a block puts the first block’s text there and the caret after the last', () => {
    const ed = setup(doc(p('ab'), p('z')), sel([0, 0], 2))
    expect(ed.commands.insertContent([p('X'), p('Y')])).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('abX'), p('Y'), p('z'))))
    expect(ed.state.selection).toEqual(sel([1, 0], 1))
  })

  describe('deleteRange across blocks that are not siblings, with an opaque edge', () => {
    const load = (content: ReturnType<typeof doc>) =>
      createTestEditor({ plugins: [testParagraph, testBold, quote], doc: content })

    it('an opaque end block nested in a container is removed whole; the container left empty goes', () => {
      const ed = load(doc(p('ab'), el('quote', p('cd'), el('weird', txt('zz'))), p('ef')))
      const tr = ed.createTransaction()
      // From inside "ab" to inside the unknown block (a raw range: no caret can be inside it).
      tr.deleteRange({ anchor: { path: [0, 0], offset: 1 }, focus: { path: [1, 1, 0], offset: 1 } })
      // The tr's own result, before normalization.
      expect(stripIds(tr.doc)).toEqual(stripIds(doc(p('a'), p('ef'))))
      ed.dispatch(tr)
      expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('a'), p('ef'))))
      expect(ed.state.selection).toEqual(sel([0, 0], 1))
    })

    it('an opaque start block nested in a container is removed whole with the emptied container; the caret goes to the nearest editable point', () => {
      const ed = load(doc(p('ab'), el('quote', el('weird', txt('zz')), p('cd')), p('ef')))
      const tr = ed.createTransaction()
      tr.deleteRange({ anchor: { path: [1, 0, 0], offset: 1 }, focus: { path: [2, 0], offset: 1 } })
      expect(stripIds(tr.doc)).toEqual(stripIds(doc(p('ab'), p('f'))))
      ed.dispatch(tr)
      expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('ab'), p('f'))))
      expect(ed.state.selection).toEqual(sel([1, 0], 0))
    })
  })
})
