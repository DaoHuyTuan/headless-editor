// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { FRAGMENT_MIME } from '../../src/content/clipboard'
import { definePlugin } from '../../src/plugin/define'
import { isElement, nodeEntries } from '../../src/model/node'
import { createSelection, mainRange, single } from '../../src/model/selection'
import type { DeepReadonly, Doc, ElementNode, Node, Path, Selection, SelectionRange } from '../../src/model/types'
import type { AnyPlugin } from '../../src/plugin/types'
import { insertFragment, insertInlineNode } from '../../src/transaction/fragment'
import { createTestEditor, doc, el, stripIds, txt } from '../../src/testing/index'
import { testBold, testParagraph } from '../fixtures'
import { editorScenarios, record, recordEditor, scenarios } from './single-range-fragment-scenarios'
import recorded from './single-range-fragment-ops.json'

const at = (path: Path, offset: number) => ({ path, offset })
const caret = (path: Path, offset: number): SelectionRange => ({ anchor: at(path, offset), focus: at(path, offset) })
const span = (path: Path, from: number, to: number): SelectionRange => ({ anchor: at(path, from), focus: at(path, to) })
const sel = (...ranges: SelectionRange[]): Selection => createSelection(ranges)
const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))
const pid = (id: string, ...children: (Node | string)[]): ElementNode => ({ ...p(...children), id })

const atom = definePlugin({ name: 'atom', node: { kind: 'block', atom: true } })
const chip = definePlugin({ name: 'chip', node: { kind: 'inline', atom: true } })
const chipEl = (id = 'c'): ElementNode => ({ id, type: 'chip', data: {}, children: [] })

function setup(content: Doc, selection: Selection, extra: AnyPlugin[] = []) {
  return createTestEditor({ plugins: [testParagraph, testBold, atom, chip, ...extra], doc: content, selection })
}
type Ed = ReturnType<typeof setup>

const texts = (d: DeepReadonly<Doc>) =>
  d.children.map((b) =>
    b.type === 'paragraph'
      ? ((b as ElementNode).children ?? []).map((c) => ('text' in c ? c.text : `<${c.type}>`)).join('')
      : `<${b.type}>`,
  )
const elementIds = (d: DeepReadonly<Doc>): string[] =>
  [...nodeEntries(d)].filter(([n]) => isElement(n)).map(([n]) => (n as ElementNode).id)

/** A DataTransfer stand-in. */
const transfer = (data: Record<string, string>): DataTransfer =>
  ({ getData: (type: string) => data[type] ?? '', types: Object.keys(data), files: [] }) as unknown as DataTransfer

/** A paste as the view sends it: the intent range is the main range. */
function paste(ed: Ed, data: Record<string, string>): boolean {
  const s = ed.state.selection
  return ed.handleIntent({ inputType: 'insertFromPaste', data: null, dataTransfer: transfer(data), range: s && mainRange(s) })
}

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

describe('paste on every range', () => {
  it('paste text at two carets', () => {
    const ed = setup(doc(p('ab cd'), p('ef')), sel(caret([0, 0], 1), caret([1, 0], 2)))
    let trs = 0
    ed.on('transaction', () => trs++)
    expect(paste(ed, { 'text/plain': 'XY' })).toBe(true)
    expect(texts(ed.state.doc)).toEqual(['aXYb cd', 'efXY'])
    expect(ed.state.selection).toEqual(sel(caret([0, 0], 3), caret([1, 0], 4)))
    expect(trs).toBe(1)
  })

  it('paste text at two carets in one text: each caret lands after its own insert', () => {
    const ed = setup(doc(p('ab cd')), sel(caret([0, 0], 1), caret([0, 0], 4)))
    paste(ed, { 'text/plain': 'XY' })
    expect(texts(ed.state.doc)).toEqual(['aXYb cXYd'])
    expect(ed.state.selection).toEqual(sel(caret([0, 0], 3), caret([0, 0], 8)))
  })

  it('paste replaces every non-empty range', () => {
    const ed = setup(doc(p('ab cd ef')), sel(span([0, 0], 0, 2), span([0, 0], 6, 8)))
    paste(ed, { 'text/plain': 'X' })
    expect(texts(ed.state.doc)).toEqual(['X cd X'])
    expect(ed.state.selection).toEqual(sel(caret([0, 0], 1), caret([0, 0], 6)))
  })

  it('paste blocks at two carets keeps order at each', () => {
    // Both carets in one block: the first insert splits the block holding the second caret.
    const ed = setup(doc(p('ab cd')), sel(caret([0, 0], 1), caret([0, 0], 4)))
    paste(ed, { 'text/plain': 'X\nY' })
    expect(texts(ed.state.doc)).toEqual(['aX', 'Yb cX', 'Yd'])
    expect(ed.state.selection).toEqual(sel(caret([1, 0], 1), caret([2, 0], 1)))
  })

  it('paste three blocks at carets in different blocks', () => {
    const ed = setup(doc(p('ab'), p('cd')), sel(caret([0, 0], 1), caret([1, 0], 1)))
    paste(ed, { 'text/html': '<p>X</p><p>M</p><p>Y</p>', 'text/plain': 'X\nM\nY' })
    expect(texts(ed.state.doc)).toEqual(['aX', 'M', 'Yb', 'cX', 'M', 'Yd'])
    expect(ed.state.selection).toEqual(sel(caret([2, 0], 1), caret([5, 0], 1)))
  })

  it('every inserted copy has unique ids', () => {
    const ed = setup(doc(pid('p1', 'ab'), pid('p2', 'cd')), sel(caret([0, 0], 1), caret([1, 0], 1)))
    // Copied from the same doc: the json carries ids the doc already has, twice over.
    const json = JSON.stringify([pid('p1', 'X'), pid('p2', 'M'), pid('p1', 'Y')])
    paste(ed, { [FRAGMENT_MIME]: json })
    expect(texts(ed.state.doc)).toEqual(['aX', 'M', 'Yb', 'cX', 'M', 'Yd'])
    const ids = elementIds(ed.state.doc)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every inline element copy has unique ids', () => {
    const ed = setup(doc(p('ab', chipEl('c0'), 'cd')), sel(caret([0, 0], 1), caret([0, 2], 1)))
    paste(ed, { [FRAGMENT_MIME]: JSON.stringify([chipEl('c0')]) })
    expect(texts(ed.state.doc)).toEqual(['a<chip>b<chip>c<chip>d'])
    const ids = elementIds(ed.state.doc)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('a lone atom block goes in whole at every caret', () => {
    const ed = setup(doc(p('ab'), p('cd')), sel(caret([0, 0], 1), caret([1, 0], 1)))
    paste(ed, { [FRAGMENT_MIME]: JSON.stringify([el('atom')]) })
    expect(texts(ed.state.doc)).toEqual(['a', '<atom>', 'b', 'c', '<atom>', 'd'])
    expect(ed.state.selection).toEqual(sel(caret([2, 0], 0), caret([5, 0], 0)))
    const ids = elementIds(ed.state.doc)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('is one undo step that restores every range and main', () => {
    const start = createSelection([caret([0, 0], 1), caret([1, 0], 1)], 1)
    const ed = setup(doc(p('ab'), p('cd')), start)
    const before = stripIds(ed.state.doc as Doc)
    paste(ed, { 'text/plain': 'X\nY' })
    expect(ed.state.selection!.main).toBe(1)
    ed.commands.undo()
    expect(stripIds(ed.state.doc as Doc)).toEqual(before)
    expect(ed.state.selection).toEqual(start)
  })

  it('transformPasted runs once per range, with at set to that range', () => {
    const seen: unknown[] = []
    const spy = definePlugin({
      name: 'spy',
      transformPasted: (fragment, _ctx, info) => {
        seen.push(info.at)
        return fragment
      },
    })
    const ed = setup(doc(p('ab'), p('cd')), sel(caret([0, 0], 1), caret([1, 0], 1)), [spy])
    paste(ed, { 'text/plain': 'X' })
    expect(seen).toEqual([caret([0, 0], 1), caret([1, 0], 1)])
    expect(texts(ed.state.doc)).toEqual(['aXb', 'cXd'])
  })

  it('a paste intent at a range other than the main one acts only there', () => {
    const ed = setup(doc(p('ab'), p('cd'), p('ef')), sel(caret([0, 0], 1), caret([1, 0], 1)))
    ed.handleIntent({ inputType: 'insertFromPaste', data: null, dataTransfer: transfer({ 'text/plain': 'X' }), range: caret([2, 0], 1) })
    expect(texts(ed.state.doc)).toEqual(['ab', 'cd', 'eXf'])
  })

  it('insertContent inserts at every range', () => {
    const ed = setup(doc(p('ab'), p('cd')), sel(caret([0, 0], 1), caret([1, 0], 1)))
    expect(ed.commands.insertContent([pid('f1', 'X'), pid('f2', 'Y')])).toBe(true)
    expect(texts(ed.state.doc)).toEqual(['aX', 'Yb', 'cX', 'Yd'])
    expect(ed.state.selection).toEqual(sel(caret([1, 0], 1), caret([3, 0], 1)))
    const ids = elementIds(ed.state.doc)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('insertFragment / insertInlineNode on every range', () => {
  it('insertFragment with an explicit range acts only there and maps the others', () => {
    const ed = setup(doc(p('ab'), p('cd')), sel(caret([0, 0], 2), caret([1, 0], 1)))
    const tr = ed.createTransaction()
    expect(insertFragment(tr, [pid('f1', 'X'), pid('f2', 'Y')], { start: at([0, 0], 1), end: at([0, 0], 1) })).toBe(true)
    expect(texts(tr.doc)).toEqual(['aX', 'Yb', 'cd'])
    // The touched range (the first caret) becomes the result; the second is mapped.
    expect(tr.selection).toEqual(sel(caret([1, 0], 1), caret([2, 0], 1)))
  })

  it('insertFragment with no selection and no range does nothing', () => {
    const ed = setup(doc(p('ab')), sel(caret([0, 0], 1)))
    const tr = ed.createTransaction()
    tr.setSelection(null)
    expect(insertFragment(tr, [txt('X')])).toBe(false)
  })

  it('insertInlineNode at every caret', () => {
    const ed = setup(doc(p('ab'), p('cd')), sel(caret([0, 0], 1), caret([1, 0], 1)))
    const tr = ed.createTransaction()
    expect(insertInlineNode(tr, chipEl())).toBe(true)
    expect(texts(tr.doc)).toEqual(['a<chip>b', 'c<chip>d'])
    expect(tr.selection).toEqual(sel(caret([0, 2], 0), caret([1, 2], 0)))
    const ids = elementIds(tr.doc)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('insertInlineNode at two carets in one text, replacing ranges', () => {
    const ed = setup(doc(p('abcdef')), sel(span([0, 0], 1, 2), caret([0, 0], 4)))
    const tr = ed.createTransaction()
    expect(insertInlineNode(tr, chipEl())).toBe(true)
    expect(texts(tr.doc)).toEqual(['a<chip>cd<chip>ef'])
    expect(tr.selection).toEqual(sel(caret([0, 2], 0), caret([0, 4], 0)))
  })

  it('insertInlineNode skips a caret in a text-only block and inserts at the others', () => {
    const code = definePlugin({ name: 'code', node: { kind: 'block', content: 'text' } })
    const ed = setup(doc(el('code', txt('xy')), p('ab')), sel(caret([0, 0], 1), caret([1, 0], 1)), [code])
    const tr = ed.createTransaction()
    expect(insertInlineNode(tr, chipEl())).toBe(true)
    expect(tr.doc.children.map((b) => (b as ElementNode).children!.length)).toEqual([1, 3])
  })

  it('inside forEachRange, a no-range insertFragment throws in dev; with the range it acts there', () => {
    const ed = setup(doc(p('ab'), p('cd')), sel(caret([0, 0], 1), caret([1, 0], 1)))
    const tr = ed.createTransaction()
    expect(() => tr.forEachRange(() => void insertFragment(tr, [txt('X')]))).toThrow(/forEachRange/)
    const tr2 = ed.createTransaction()
    tr2.forEachRange((range, t) => void insertFragment(t, [txt('X')], range))
    expect(texts(tr2.doc)).toEqual(['aXb', 'cXd'])
    // Inserted as text nodes of their own (merged by normalization on dispatch).
    expect(tr2.selection).toEqual(sel(caret([0, 1], 1), caret([1, 1], 1)))
    expect(() => ed.createTransaction().forEachRange((_r, t) => void insertInlineNode(t, chipEl()))).toThrow(/forEachRange/)
  })
})

describe('drop on one range', () => {
  const drop = (ed: Ed, range: SelectionRange | null, text = 'XY') =>
    ed.handleIntent({ inputType: 'insertFromDrop', data: null, dataTransfer: transfer({ 'text/plain': text }), range })

  it('drop collapses to the drop point', () => {
    const ed = setup(doc(p('ab'), p('cd'), p('ef')), sel(caret([0, 0], 1), caret([1, 0], 1)))
    let trs = 0
    ed.on('transaction', () => trs++)
    expect(drop(ed, caret([2, 0], 1))).toBe(true)
    expect(texts(ed.state.doc)).toEqual(['ab', 'cd', 'eXYf'])
    expect(ed.state.selection).toEqual(single(caret([2, 0], 3)))
    expect(trs).toBe(1)
  })

  it('a drop at one of the carets inserts there only', () => {
    const ed = setup(doc(p('ab'), p('cd')), sel(caret([0, 0], 1), caret([1, 0], 1)))
    drop(ed, caret([1, 0], 1), 'X\nY')
    expect(texts(ed.state.doc)).toEqual(['ab', 'cX', 'Yd'])
    expect(ed.state.selection).toEqual(single(caret([2, 0], 1)))
  })

  it('a drop with no point goes to the main range only', () => {
    const ed = setup(doc(p('ab'), p('cd')), createSelection([caret([0, 0], 1), caret([1, 0], 1)], 1))
    drop(ed, null)
    expect(texts(ed.state.doc)).toEqual(['ab', 'cXYd'])
    expect(ed.state.selection).toEqual(single(caret([1, 0], 3)))
  })

  describe('through the view', () => {
    function mount(ed: Ed) {
      const root = document.createElement('div')
      document.body.appendChild(root)
      ed.mount(root)
      ed.view!.focus()
      return root
    }
    function dropEvent(data: Record<string, string>) {
      const e = new Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperties(e, { dataTransfer: { value: transfer(data) }, clientX: { value: 0 }, clientY: { value: 0 } })
      return e
    }
    afterEach(() => {
      delete (document as unknown as Record<string, unknown>).caretRangeFromPoint
    })

    it('a drop at a point collapses the selection there', () => {
      const ed = setup(doc(p('ab'), p('cdef')), sel(caret([0, 0], 1), caret([1, 0], 1)))
      const root = mount(ed)
      const walker = document.createTreeWalker(root, 4)
      let node: globalThis.Node | null = null
      for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n as Text).data === 'cdef') node = n
      Object.defineProperty(document, 'caretRangeFromPoint', {
        configurable: true,
        value: () => {
          const r = document.createRange()
          r.setStart(node!, 3)
          return r
        },
      })
      root.dispatchEvent(dropEvent({ 'text/plain': 'X' }))
      expect(texts(ed.state.doc)).toEqual(['ab', 'cdeXf'])
      expect(ed.state.selection).toEqual(single(caret([1, 0], 4)))
    })

    it('a drop the browser cannot place goes to the main range and collapses there', () => {
      const ed = setup(doc(p('ab'), p('cdef')), createSelection([caret([0, 0], 1), caret([1, 0], 1)], 0))
      const root = mount(ed)
      root.dispatchEvent(dropEvent({ 'text/plain': 'X' }))
      expect(texts(ed.state.doc)).toEqual(['aXb', 'cdef'])
      expect(ed.state.selection).toEqual(single(caret([0, 0], 2)))
    })
  })
})

/** Ops with the intermediate `set_selection` ops dropped (see the parity tests). */
const docOps = (ops: unknown[]) => ops.filter((op) => (op as { type: string }).type !== 'set_selection')
/**
 * The `set_selection` ops: no more than before (the intermediate ones the helpers used to add may be
 * gone), and none when there were none. The final selection is compared on its own.
 */
function expectSelectionOps(now: unknown[], was: unknown[]): void {
  const count = (ops: unknown[]) => ops.length - docOps(ops).length
  expect(count(now)).toBeLessThanOrEqual(count(was))
  if (count(was) === 0) expect(count(now)).toBe(0)
}

describe('single-range parity with the implementation before multi-range fragments', () => {
  const old = recorded as unknown as Record<string, unknown>
  for (const s of scenarios) {
    it(s.name, () => {
      const was = old[s.name] as ReturnType<typeof record>
      const now = record(s)
      // The edits are identical; the intermediate set_selection ops the helpers used to add are gone.
      expect(docOps(now.ops)).toEqual(docOps(was.ops))
      expectSelectionOps(now.ops, was.ops)
      expect({ ...now, ops: null }).toEqual({ ...was, ops: null })
    })
  }
  for (const s of editorScenarios) {
    it(`editor: ${s.name}`, () => {
      const was = old[`editor: ${s.name}`] as ReturnType<typeof recordEditor>
      const now = recordEditor(s)
      expect(now.trs.map((t) => t.meta)).toEqual(was.trs.map((t) => t.meta))
      now.trs.forEach((t, i) => {
        expect(docOps(t.ops)).toEqual(docOps(was.trs[i]!.ops))
        expectSelectionOps(t.ops, was.trs[i]!.ops)
      })
      expect({ ...now, trs: null }).toEqual({ ...was, trs: null })
    })
  }
})
