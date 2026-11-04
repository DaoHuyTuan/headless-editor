// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { createSelection, mainRange, single } from '../../src/model/selection'
import type { Doc, ElementNode, Mark, Node, Path, Selection, SelectionRange, TextNode } from '../../src/model/types'
import { definePlugin } from '../../src/plugin/define'
import type { AnyPlugin } from '../../src/plugin/types'
import type { Decoration } from '../../src/view/decorations'
import { readDomSelection, writeDomSelection } from '../../src/view/dom-selection'
import { createTestEditor, doc, el, txt } from '../../src/testing/index'
import { testBold, testParagraph } from '../fixtures'
import { inputScenarios, recordInput } from '../transaction/single-range-input-scenarios'
import recorded from '../transaction/single-range-input-ops.json'

const at = (path: Path, offset: number) => ({ path, offset })
const caret = (path: Path, offset: number): SelectionRange => ({ anchor: at(path, offset), focus: at(path, offset) })
const span = (path: Path, from: number, to: number): SelectionRange => ({ anchor: at(path, from), focus: at(path, to) })
const sel = (...ranges: SelectionRange[]): Selection => createSelection(ranges)
const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))
const bold: Mark = { type: 'bold', data: {} }

function setup(content: Doc, selection: Selection, extra: AnyPlugin[] = []) {
  return createTestEditor({ plugins: [testParagraph, testBold, ...extra], doc: content, selection })
}
type Ed = ReturnType<typeof setup>

function mount(ed: Ed) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  ed.mount(root)
  ed.view!.focus()
  return root
}

const texts = (ed: Ed) =>
  ed.state.doc.children.map((b) => ((b as ElementNode).children ?? []).map((t) => (t as TextNode).text ?? `<${(t as ElementNode).type}>`).join(''))
const main = (ed: Ed) => mainRange(ed.state.selection!)
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const fire = (target: EventTarget, type: string) => target.dispatchEvent(new Event(type, { bubbles: true }))
const transfer = (data: Record<string, string>): DataTransfer =>
  ({ getData: (type: string) => data[type] ?? '', types: Object.keys(data), files: [] }) as unknown as DataTransfer

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

describe('intents with several ranges', () => {
  it('typing intent at two carets inserts at both', () => {
    const ed = setup(doc(p('ab'), p('cd')), sel(caret([0, 0], 1), caret([1, 0], 1)))
    expect(ed.handleIntent({ inputType: 'insertText', data: 'x', range: main(ed) })).toBe(true)
    expect(ed.handleIntent({ inputType: 'insertText', data: 'y', range: null })).toBe(true)
    expect(texts(ed)).toEqual(['axyb', 'cxyd'])
    expect(ed.state.selection).toEqual(sel(caret([0, 0], 3), caret([1, 0], 3)))
  })

  it('typing replaces every non-empty range', () => {
    const ed = setup(doc(p('abcd')), sel(span([0, 0], 0, 1), span([0, 0], 2, 3)))
    ed.handleIntent({ inputType: 'insertText', data: 'x', range: main(ed) })
    expect(texts(ed)).toEqual(['xbxd'])
  })

  it('a forward target range over a backward main range is still plain typing', () => {
    const ed = setup(doc(p('abcd')), sel({ anchor: at([0, 0], 1), focus: at([0, 0], 0) }, span([0, 0], 2, 3)))
    ed.handleIntent({ inputType: 'insertText', data: 'x', range: span([0, 0], 0, 1) })
    expect(texts(ed)).toEqual(['xbxd'])
    expect(ed.state.selection!.ranges).toHaveLength(2)
  })

  it('insertReplacementText with its own range applies there only and collapses', () => {
    const ed = setup(doc(p('teh'), p('cd')), sel(caret([0, 0], 3), caret([1, 0], 1)))
    expect(ed.handleIntent({ inputType: 'insertReplacementText', data: 'the', range: span([0, 0], 0, 3) })).toBe(true)
    expect(texts(ed)).toEqual(['the', 'cd'])
    expect(ed.state.selection).toEqual(single(caret([0, 0], 3)))
  })

  it('insertReplacementText at the main range is still targeted: it collapses', () => {
    const ed = setup(doc(p('teh'), p('foo')), sel(span([0, 0], 0, 3), span([1, 0], 0, 3)))
    ed.handleIntent({ inputType: 'insertReplacementText', data: 'the', range: span([0, 0], 0, 3) })
    expect(texts(ed)).toEqual(['the', 'foo'])
    expect(ed.state.selection).toEqual(single(caret([0, 0], 3)))
  })

  it('a typing intent whose range is not the main range applies there only and collapses', () => {
    const ed = setup(doc(p('ab'), p('cd'), p('ef')), sel(caret([0, 0], 1), caret([1, 0], 1)))
    ed.handleIntent({ inputType: 'insertText', data: 'x', range: caret([2, 0], 1) })
    expect(texts(ed)).toEqual(['ab', 'cd', 'exf'])
    expect(ed.state.selection).toEqual(single(caret([2, 0], 2)))
  })

  it('a paste intent whose range is not the main range applies there only and collapses', () => {
    const ed = setup(doc(p('ab'), p('cd'), p('ef')), sel(caret([0, 0], 1), caret([1, 0], 1)))
    ed.handleIntent({ inputType: 'insertFromPaste', data: null, dataTransfer: transfer({ 'text/plain': 'X' }), range: caret([2, 0], 1) })
    expect(texts(ed)).toEqual(['ab', 'cd', 'eXf'])
    expect(ed.state.selection).toEqual(single(caret([2, 0], 2)))
  })

  it('Backspace and Enter intents act at every caret', () => {
    const ed = setup(doc(p('ab'), p('cd')), sel(caret([0, 0], 1), caret([1, 0], 1)))
    ed.handleIntent({ inputType: 'deleteContentBackward', data: null, range: main(ed) })
    expect(texts(ed)).toEqual(['b', 'd'])
    ed.handleIntent({ inputType: 'insertParagraph', data: null, range: main(ed) })
    expect(texts(ed)).toEqual(['', 'b', '', 'd'])
  })
})

describe('IME with several ranges', () => {
  it('compositionstart with two carets collapses to main and the composition lands at main', async () => {
    const ed = setup(doc(p('ab'), p('cd')), createSelection([caret([0, 0], 1), caret([1, 0], 1)], 1))
    const root = mount(ed)
    fire(root, 'compositionstart')
    expect(ed.state.selection).toEqual(single(caret([1, 0], 1)))
    expect(ed.view!.composition?.path).toEqual([1, 0])
    const leaf = ed.view!.renderer.leafAt([1, 0])!
    ;(leaf.ownerDocument.createTreeWalker(leaf, 4).nextNode() as Text).data = 'cXd'
    await flush()
    fire(root, 'compositionend')
    expect(texts(ed)).toEqual(['ab', 'cXd'])
    expect(ed.state.selection).toEqual(single(caret([1, 0], 2)))
  })

  it('the composed text takes the stored marks, not the intersection of the carets', async () => {
    // The main caret is in bold text, the other is not: the composition uses main's marks.
    const ed = setup(doc(p('ab'), p(txt('cd', 'bold'))), createSelection([caret([0, 0], 1), caret([1, 0], 1)], 1))
    const root = mount(ed)
    fire(root, 'compositionstart')
    const leaf = ed.view!.renderer.leafAt([1, 0])!
    ;(leaf.ownerDocument.createTreeWalker(leaf, 4).nextNode() as Text).data = 'cXd'
    await flush()
    fire(root, 'compositionend')
    expect(ed.state.doc.children[1]!.children).toEqual([{ text: 'cXd', marks: [bold] }])
  })

  it('compositionstart keeps the stored marks while collapsing', async () => {
    const ed = setup(doc(p('ab'), p('cd')), sel(caret([0, 0], 1), caret([1, 0], 1)))
    const tr = ed.createTransaction()
    tr.setStoredMarks([bold])
    ed.dispatch(tr)
    const root = mount(ed)
    fire(root, 'compositionstart')
    expect(ed.state.storedMarks).toEqual([bold])
    const leaf = ed.view!.renderer.leafAt([0, 0])!
    ;(leaf.ownerDocument.createTreeWalker(leaf, 4).nextNode() as Text).data = 'aXb'
    await flush()
    fire(root, 'compositionend')
    expect(ed.state.doc.children[0]!.children).toEqual([txt('a'), { text: 'X', marks: [bold] }, txt('b')])
  })
})

describe('view with several ranges', () => {
  it('writeDomSelection writes the main range', () => {
    const ed = setup(doc(p('ab'), p('cd')), createSelection([caret([0, 0], 1), span([1, 0], 0, 2)], 1))
    mount(ed)
    const domSel = document.getSelection()!
    domSel.removeAllRanges()
    writeDomSelection(ed.view!.renderer, ed.state.selection, domSel)
    expect(readDomSelection(ed.view!.renderer, domSel)).toEqual(single(span([1, 0], 0, 2)))
  })

  it('the ranges survive the view writing main and its own selectionchange', async () => {
    const ed = setup(doc(p('ab'), p('cd')), sel(caret([0, 0], 1), caret([1, 0], 1)))
    mount(ed)
    fire(document, 'selectionchange')
    await flush()
    expect(ed.state.selection!.ranges).toHaveLength(2)
  })

  it('selectionchange collapses to one range', async () => {
    const ed = setup(doc(p('ab'), p('cd')), sel(caret([0, 0], 1), caret([1, 0], 1)))
    mount(ed)
    const leaf = ed.view!.renderer.leafAt([1, 0])!
    const text = leaf.ownerDocument.createTreeWalker(leaf, 4).nextNode() as Text
    document.getSelection()!.collapse(text, 2)
    fire(document, 'selectionchange')
    await flush()
    expect(ed.state.selection).toEqual(single(caret([1, 0], 2)))
  })

  it('a plugin can draw secondary ranges from state.selection.ranges via decorations', () => {
    const carets = definePlugin({
      name: 'carets',
      decorations: (state): Decoration[] => {
        const s = state.selection
        if (!s) return []
        return s.ranges.flatMap((r, i): Decoration[] =>
          i === s.main
            ? []
            : [
                {
                  type: 'widget',
                  at: r.focus,
                  key: `caret-${i}`,
                  render: (d) => Object.assign(d.createElement('span'), { className: 'secondary-caret' }),
                },
              ],
        )
      },
    })
    const ed = setup(doc(p('abcd'), p('ef')), sel(caret([0, 0], 1), caret([0, 0], 3), caret([1, 0], 1)), [carets])
    const root = mount(ed)
    /** Each widget as [block index, the block's text before it]. */
    const widgets = () =>
      [...root.querySelectorAll('.secondary-caret')].map((w) => {
        const block = [0, 1].find((i) => ed.view!.renderer.elementAt([i])!.contains(w))!
        const r = document.createRange()
        r.setStart(ed.view!.renderer.elementAt([block])!, 0)
        r.setEndBefore(w)
        return [block, r.toString()]
      })
    // Main is the first range: the two others get a widget, each at its caret.
    expect(widgets()).toEqual([[0, 'abc'], [1, 'e']])
    expect(root.textContent).toBe('abcdef')
    ed.handleIntent({ inputType: 'insertText', data: 'x', range: main(ed) })
    expect(texts(ed)).toEqual(['axbcxd', 'exf'])
    // The widgets moved with their carets, past the inserted text.
    expect(widgets()).toEqual([[0, 'axbcx'], [1, 'ex']])
    expect(root.textContent).toBe('axbcxdexf')
  })
})

/** Ops with the `set_selection` ops dropped. */
const docOps = (ops: unknown[]) => ops.filter((op) => (op as { type: string }).type !== 'set_selection')

describe('single-range parity with the implementation before multi-range input', () => {
  const old = recorded as unknown as Record<string, Awaited<ReturnType<typeof recordInput>>>
  for (const s of inputScenarios) {
    it(s.name, async () => {
      const was = old[s.name]!
      const now = await recordInput(s)
      // Exact: every tr's meta and ops (set_selection included), and the states.
      expect(now).toEqual(was)
      expect(now.trs.map((t) => docOps(t.ops))).toEqual(was.trs.map((t) => docOps(t.ops)))
    })
  }
})
