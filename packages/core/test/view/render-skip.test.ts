// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { definePlugin } from '../../src/plugin/define'
import { nodeSelection, type Decoration } from '../../src/index'
import { domToModel, Renderer } from '../../src/internal'
import type { ElementNode } from '../../src/model/types'
import { createTestEditor, doc, el, sel, txt } from '../../src/testing/index'
import { testBold, testParagraph } from '../fixtures'

const flush = () => new Promise<void>((r) => setTimeout(r, 0))
const para = (i: number) => el('paragraph', txt(`Paragraph ${i} `), txt('bold', 'bold'), txt(' tail'))

function mount(blocks = 200, extra: Parameters<typeof createTestEditor>[0]['plugins'] = []) {
  const ed = createTestEditor({
    plugins: [testParagraph, testBold, ...extra],
    doc: doc(...Array.from({ length: blocks }, (_, i) => para(i))),
    selection: sel([5, 0], 2),
  })
  const root = document.createElement('div')
  document.body.appendChild(root)
  ed.mount(root)
  return { ed, root }
}

afterEach(() => {
  vi.restoreAllMocks()
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

describe('rendering skips unchanged subtrees (8.4)', () => {
  it('typing in one block does not check the leaves of the others', () => {
    const { ed } = mount(200)
    const intact = vi.spyOn(Renderer.prototype as unknown as { leafIntact: () => boolean }, 'leafIntact')
    ed.handleIntent({ inputType: 'insertText', data: 'x', range: null })
    // The typed block's three leaves, not 600.
    expect(intact.mock.calls.length).toBeLessThanOrEqual(3)
    expect(ed.view!.renderer.leafAt([5, 0])!.textContent).toBe('Paxragraph 5 ')
  })

  it('a decoration added to (then removed from) an unchanged block is shown (then removed)', () => {
    let decos: Decoration[] = []
    const hl = definePlugin({ name: 'hl', decorations: () => decos })
    const { ed, root } = mount(20, [hl])
    const tr = () => {
      const t = ed.createTransaction()
      t.setMeta('refresh', true)
      ed.dispatch(t)
      ed.view!.update(ed.state)
    }
    decos = [{ type: 'inline', from: { path: [12, 0], offset: 0 }, to: { path: [12, 0], offset: 4 }, attrs: { class: 'hl' } }]
    tr()
    expect(root.querySelectorAll('.hl')).toHaveLength(1)
    decos = []
    tr()
    expect(root.querySelectorAll('.hl')).toHaveLength(0)
  })

  it('a node selection that moves on an unchanged doc marks and unmarks its node', () => {
    const chip = definePlugin({ name: 'chip', node: { kind: 'inline', atom: true } })
    const ed = createTestEditor({
      plugins: [testParagraph, chip],
      doc: doc(...Array.from({ length: 10 }, (_, i) => el('paragraph', txt(`a${i}`), el('chip', {}), txt('b')))),
    })
    const root = document.createElement('div')
    document.body.appendChild(root)
    ed.mount(root)
    const select = (block: number) => {
      const tr = ed.createTransaction()
      tr.setSelection(nodeSelection(tr.doc, ed.registry, [block, 1]))
      ed.dispatch(tr)
    }
    const selectedIds = () => [...root.querySelectorAll('[data-penline-selected]')].map((e) => e.getAttribute('data-penline-id'))
    const idOf = (block: number) => ((ed.state.doc.children[block] as ElementNode).children![1] as ElementNode).id
    select(3)
    expect(selectedIds()).toEqual([idOf(3)])
    select(7)
    expect(selectedIds()).toEqual([idOf(7)])
  })

  it('a DOM change made outside the editor in an unchanged block is still reverted', async () => {
    const { ed, root } = mount(20)
    const leaf = ed.view!.renderer.leafAt([15, 0])!
    leaf.firstChild!.textContent = 'tampered'
    await flush()
    expect(ed.view!.renderer.leafAt([15, 0])!.textContent).toBe('Paragraph 15 ')
    expect(root.textContent).not.toContain('tampered')
  })
})

describe('DOM positions outside leaves map without visiting every leaf (8.4)', () => {
  it('a position between two blocks checks only the leaves around it', () => {
    const { ed, root } = mount(200)
    const r = ed.view!.renderer
    const spy = vi.spyOn(Renderer.prototype, 'pathOfLeaf')
    // A root position before block 151 (in no leaf): the start of the block it points at.
    const point = domToModel(r, root, 151)
    expect(point).toEqual({ path: [151, 0], offset: 0 })
    expect(spy.mock.calls.length).toBeLessThanOrEqual(10)
  })

  it('maps like before at the edges, in nested scopes and before the first leaf', () => {
    const { ed, root } = mount(5)
    const r = ed.view!.renderer
    expect(domToModel(r, root, 0)).toEqual({ path: [0, 0], offset: 0 })
    expect(domToModel(r, root, 5)).toEqual({ path: [4, 2], offset: ' tail'.length })
    const block = r.elementAt([2])!
    expect(domToModel(r, block, 0)).toEqual({ path: [2, 0], offset: 0 })
    expect(domToModel(r, block, block.childNodes.length)).toEqual({ path: [2, 2], offset: ' tail'.length })
  })
})
