// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { mainRange, single } from '../../src/model/selection'
import type { ElementNode, Node, Point, Selection } from '../../src/model/types'
import type { Decoration } from '../../src/index'
import { DECO_ATTR, WIDGET_ATTR } from '../../src/index'
import { domToModel, modelToDom } from '../../src/internal'
import { createTestEditor, doc, txt } from '../../src/testing/index'
import { testBold, testParagraph } from '../fixtures'
import { definePlugin } from '../../src/plugin/define'
import { groupDecorations, leafParts } from '../../src/view/decorations'

const p = (id: string, ...children: Node[]): ElementNode => ({ id, type: 'paragraph', data: {}, children })
const caret = (path: number[], offset: number): Selection => single({ anchor: { path, offset }, focus: { path, offset } })
const pt = (path: number[], offset: number): Point => ({ path, offset })
const inline = (from: Point, to: Point, attrs: Record<string, string>): Decoration => ({ type: 'inline', from, to, attrs })

let current: Decoration[] = []
const decoPlugin = definePlugin({
  name: 'deco',
  decorations: () => current,
})

function mount(children: ElementNode[], decos: Decoration[] = [], selection: Selection = caret([0, 0], 0)) {
  current = decos
  const editor = createTestEditor({ plugins: [testParagraph, testBold, decoPlugin], doc: doc(...children), selection })
  const root = document.createElement('div')
  document.body.appendChild(root)
  editor.mount(root)
  const view = editor.view!
  return { editor, root, view }
}

/** Re-renders with new decorations. */
function redecorate(view: { update: (s: never) => void; editor: { state: unknown } }, decos: Decoration[]): void {
  current = decos
  view.update(view.editor.state as never)
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  current = []
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

describe('inline decorations', () => {
  it('wraps the decorated range of a leaf in a deco span', () => {
    const { view } = mount([p('p1', txt('abcde'))], [inline(pt([0, 0], 1), pt([0, 0], 4), { class: 'x' })])
    expect(view.renderer.leafAt([0, 0])!.innerHTML).toBe('a<span data-penline-deco="" class="x">bcd</span>e')
  })

  it('nests inside the mark wrappers', () => {
    const { view } = mount(
      [p('p1', txt('abcde', 'bold'))],
      [inline(pt([0, 0], 0), pt([0, 0], 2), { class: 'x', 'data-k': 'v' })],
    )
    expect(view.renderer.leafAt([0, 0])!.innerHTML).toBe(
      '<strong>' + '<span data-penline-deco="" class="x" data-k="v">ab</span>cde</strong>',
    )
  })

  it('splits a decoration across leaves and merges overlapping ones', () => {
    const { view } = mount(
      [p('p1', txt('abc'), txt('def', 'bold'))],
      [
        inline(pt([0, 0], 2), pt([0, 1], 1), { class: 'x' }),
        inline(pt([0, 1], 0), pt([0, 1], 2), { class: 'y' }),
      ],
    )
    expect(view.renderer.leafAt([0, 0])!.innerHTML).toBe('ab<span data-penline-deco="" class="x">c</span>')
    expect(view.renderer.leafAt([0, 1])!.innerHTML).toBe(
      '<strong><span data-penline-deco="" class="x y">d</span><span data-penline-deco="" class="y">e</span>f</strong>',
    )
  })

  it('maps the caret both ways inside a decorated segment', () => {
    const { view } = mount([p('p1', txt('abcde'))], [inline(pt([0, 0], 1), pt([0, 0], 4), { class: 'x' })])
    const r = view.renderer
    for (let offset = 0; offset <= 5; offset++) {
      const dom = modelToDom(r, pt([0, 0], offset))
      expect(domToModel(r, dom.node, dom.offset)).toEqual(pt([0, 0], offset))
    }
    const deco = r.leafAt([0, 0])!.querySelector('[data-penline-deco]')!
    expect(modelToDom(r, pt([0, 0], 3))).toEqual({ node: deco.firstChild, offset: 2 })
    expect(domToModel(r, deco, 1)).toEqual(pt([0, 0], 4))
  })

  it('keeps unchanged leaves when decorations change, rebuilds the affected leaf', () => {
    const { view } = mount([p('p1', txt('abc')), p('p2', txt('def'))], [inline(pt([0, 0], 0), pt([0, 0], 1), { class: 'x' })])
    const first = view.renderer.leafAt([0, 0])!
    const second = view.renderer.leafAt([1, 0])!
    const secondText = second.firstChild
    redecorate(view, [inline(pt([0, 0], 1), pt([0, 0], 2), { class: 'x' })])
    expect(view.renderer.leafAt([1, 0])).toBe(second)
    expect(second.firstChild).toBe(secondText)
    expect(view.renderer.leafAt([0, 0])).toBe(first)
    expect(first.innerHTML).toBe('a<span data-penline-deco="" class="x">b</span>c')
    // Same decorations again: the decorated leaf's DOM is kept as is.
    const span = first.querySelector('[data-penline-deco]')
    redecorate(view, [inline(pt([0, 0], 1), pt([0, 0], 2), { class: 'x' })])
    expect(first.querySelector('[data-penline-deco]')).toBe(span)
    // An attrs change re-renders it; removing all decorations restores plain text.
    redecorate(view, [inline(pt([0, 0], 1), pt([0, 0], 2), { class: 'z' })])
    expect(first.innerHTML).toBe('a<span data-penline-deco="" class="z">b</span>c')
    redecorate(view, [])
    expect(first.innerHTML).toBe('abc')
  })

  it('ignores decorations that do not point at text', () => {
    const { view } = mount([p('p1', txt('abc'))], [inline(pt([5, 0], 0), pt([5, 0], 1), { class: 'x' })])
    expect(view.renderer.leafAt([0, 0])!.innerHTML).toBe('abc')
  })

  it('repairs a damaged decorated leaf', async () => {
    const { view } = mount([p('p1', txt('abcde'))], [inline(pt([0, 0], 1), pt([0, 0], 4), { class: 'x' })])
    const leaf = view.renderer.leafAt([0, 0])!
    leaf.querySelector('[data-penline-deco]')!.remove()
    await flush()
    expect(leaf.innerHTML).toBe('a<span data-penline-deco="" class="x">bcd</span>e')
  })
})

describe('widget decorations', () => {
  let made = 0
  const widget = (at: Point, key: string, label = 'W'): Decoration => ({
    type: 'widget',
    at,
    key,
    render: (d) => {
      made++
      const el = d.createElement('span')
      el.className = 'w'
      el.textContent = label
      return el
    },
  })

  it('renders at its position, non-editable and excluded from text mapping', () => {
    made = 0
    const { editor, view } = mount([p('p1', txt('abcd'))], [widget(pt([0, 0], 2), 'k1')])
    const leaf = view.renderer.leafAt([0, 0])!
    expect(leaf.innerHTML).toBe('ab<span class="w" data-penline-widget="" contenteditable="false">W</span>cd')
    const w = leaf.querySelector('.w')!
    expect(domToModel(view.renderer, w.firstChild!, 1)).toEqual(pt([0, 0], 2))
    expect(domToModel(view.renderer, leaf.lastChild!, 1)).toEqual(pt([0, 0], 3))
    expect(modelToDom(view.renderer, pt([0, 0], 4))).toEqual({ node: leaf.lastChild, offset: 2 })
    expect(editor.getHTML()).not.toContain('W')
    expect(JSON.stringify(editor.getJSON())).not.toContain('k1')
    expect(made).toBe(1)
  })

  it('is reused by key across renders and moves with its position', () => {
    made = 0
    const { editor, view } = mount([p('p1', txt('abcd'))], [widget(pt([0, 0], 2), 'k1')])
    const w = view.renderer.leafAt([0, 0])!.querySelector('.w')
    editor.dispatch(editor.createTransaction().insertText('X', mainRange(caret([0, 0], 0))))
    redecorate(view, [widget(pt([0, 0], 3), 'k1')])
    const leaf = view.renderer.leafAt([0, 0])!
    expect(leaf.querySelector('.w')).toBe(w)
    expect(leaf.textContent).toBe('XabWcd')
    expect(made).toBe(1)
    redecorate(view, [])
    expect(leaf.querySelector('.w')).toBeNull()
    redecorate(view, [widget(pt([0, 0], 0), 'k1')])
    expect(made).toBe(2)
  })

  it('a same-key widget keeps its element even when its render would build another one', () => {
    made = 0
    const { view } = mount([p('p1', txt('abcd'))], [widget(pt([0, 0], 2), 'k1', 'old')])
    const w = view.renderer.leafAt([0, 0])!.querySelector('.w')
    redecorate(view, [widget(pt([0, 0], 1), 'k1', 'new')])
    const leaf = view.renderer.leafAt([0, 0])!
    expect(leaf.querySelector('.w')).toBe(w)
    expect(leaf.textContent).toBe('aoldbcd')
    expect(made).toBe(1)
    // A new key gets a new element.
    redecorate(view, [widget(pt([0, 0], 1), 'k2', 'new')])
    expect(view.renderer.leafAt([0, 0])!.textContent).toBe('anewbcd')
    expect(made).toBe(2)
  })

  it('the attribute names are exported from the core index and match the rendered DOM', () => {
    expect(WIDGET_ATTR).toBe('data-penline-widget')
    expect(DECO_ATTR).toBe('data-penline-deco')
    const { view } = mount(
      [p('p1', txt('abcd'))],
      [widget(pt([0, 0], 2), 'k1'), inline(pt([0, 0], 0), pt([0, 0], 1), { class: 'x' })],
    )
    const leaf = view.renderer.leafAt([0, 0])!
    expect(leaf.querySelector(`[${WIDGET_ATTR}]`)!.className).toBe('w')
    expect(leaf.querySelector(`[${DECO_ATTR}]`)!.textContent).toBe('a')
  })

  it('a caret at a widget is shown next to it, outside it, and read back at the same point', () => {
    const { editor, view } = mount([p('p1', txt('abcd'))], [widget(pt([0, 0], 2), 'k1')], caret([0, 0], 2))
    view.focus()
    const leaf = view.renderer.leafAt([0, 0])!
    const w = leaf.querySelector('.w')!
    const domSel = document.getSelection()!
    expect(leaf.contains(domSel.anchorNode)).toBe(true)
    expect(w.contains(domSel.anchorNode)).toBe(false)
    expect(domToModel(view.renderer, domSel.anchorNode!, domSel.anchorOffset)).toEqual(pt([0, 0], 2))
    // Either side of the widget is the same model point; typing there goes between the texts.
    expect(domToModel(view.renderer, leaf, Array.from(leaf.childNodes).indexOf(w))).toEqual(pt([0, 0], 2))
    expect(domToModel(view.renderer, leaf, Array.from(leaf.childNodes).indexOf(w) + 1)).toEqual(pt([0, 0], 2))
    editor.commands.insertText('X')
    expect(editor.getJSON().children[0]).toMatchObject({ children: [{ text: 'abXcd' }] })
    expect(mainRange(editor.state.selection!).anchor).toEqual(pt([0, 0], 3))
  })

  it('renders in an empty text before its break', () => {
    const { view } = mount([p('p1', txt(''))], [widget(pt([0, 0], 0), 'k')])
    const leaf = view.renderer.leafAt([0, 0])!
    expect(leaf.innerHTML).toBe('<span class="w" data-penline-widget="" contenteditable="false">W</span><br data-penline-break="">')
    expect(domToModel(view.renderer, leaf, 2)).toEqual(pt([0, 0], 0))
  })

  it('ignores mutations inside a widget', async () => {
    const { editor, view } = mount([p('p1', txt('abcd'))], [widget(pt([0, 0], 2), 'k1')])
    let count = 0
    const original = view.renderer.render.bind(view.renderer)
    view.renderer.render = (...args) => {
      count++
      original(...args)
    }
    const w = view.renderer.leafAt([0, 0])!.querySelector('.w')!
    w.textContent = 'changed'
    w.appendChild(document.createElement('b'))
    const before = editor.state.doc
    await flush()
    expect(count).toBe(0)
    expect(w.textContent).toBe('changed')
    expect(editor.state.doc).toBe(before)
  })
})

describe('decorations and composition', () => {
  it('leaves the composing leaf alone and applies decorations after the commit', () => {
    const { editor, root, view } = mount([p('p1', txt('abc'))], [], caret([0, 0], 3))
    const leaf = view.renderer.leafAt([0, 0])!
    root.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    ;(leaf.firstChild as Text).data = 'abcê'
    redecorate(view, [inline(pt([0, 0], 0), pt([0, 0], 2), { class: 'x' })])
    expect(leaf.innerHTML).toBe('abcê')
    root.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'ê' }))
    expect((editor.state.doc.children[0] as ElementNode).children![0]).toMatchObject({ text: 'abcê' })
    expect(view.renderer.leafAt([0, 0])!.innerHTML).toBe('<span data-penline-deco="" class="x">ab</span>cê')
  })

  it('commits text composed inside a decorated leaf with a widget, without the widget text', () => {
    const { editor, root, view } = mount(
      [p('p1', txt('abc'))],
      [
        inline(pt([0, 0], 0), pt([0, 0], 2), { class: 'x' }),
        { type: 'widget', at: pt([0, 0], 1), key: 'w', render: (d) => d.createElement('i') },
      ],
      caret([0, 0], 2),
    )
    const leaf = view.renderer.leafAt([0, 0])!
    view.renderer.leafAt([0, 0])!.querySelector('i')!.textContent = 'WIDGET'
    root.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    const seg = leaf.querySelectorAll('[data-penline-deco]')[1]!.firstChild as Text
    seg.data = 'bê'
    root.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'ê' }))
    expect((editor.state.doc.children[0] as ElementNode).children![0]).toMatchObject({ text: 'abêc' })
  })
})


describe('decorations at scale', () => {
  const bigDoc = (): ElementNode[] => [
    p('big', txt('x'.repeat(5000))),
    ...Array.from({ length: 500 }, (_, i) => p(`p${i}`, txt(`paragraph ${i}`))),
  ]
  /** ~3,000 single-text inline decorations (overlapping pairs) on the big text. */
  const manyDecos = (shift: number): Decoration[] =>
    Array.from({ length: 3000 }, (_, i) =>
      inline(pt([0, 0], (i + shift) % 4990), pt([0, 0], ((i + shift) % 4990) + 3), { class: `t${i % 7}` }),
    )

  it('groups and segments many decorations in near-linear time', () => {
    // The algorithmic part of a render, without happy-dom's DOM building (whose cost is inherent and
    // load-sensitive). A per-decoration doc walk or a per-cut decoration scan takes hundreds of ms here.
    // Timed as the fastest of several runs after a warm-up (JIT, GC and a loaded machine only ever add
    // time), against a bound well above that but far below the quadratic cost (~800 ms per set).
    const d = doc(...bigDoc())
    const text = 'x'.repeat(5000)
    const sets = [1, 2, 3].map(manyDecos)
    const run = () => {
      for (const decos of sets) {
        const grouped = groupDecorations(d, decos)
        const parts = leafParts(text, grouped.get('0,0'), null)
        expect(parts.map((part) => (part.kind === 'text' ? part.text : '')).join('')).toBe(text)
      }
    }
    run()
    let best = Infinity
    for (let i = 0; i < 5; i++) {
      const start = performance.now()
      run()
      best = Math.min(best, (performance.now() - start) / sets.length)
    }
    expect(best).toBeLessThan(150)
  })

  it('renders and updates many decorations (smoke bound)', () => {
    const { view } = mount(bigDoc(), manyDecos(0))
    const start = performance.now()
    for (let shift = 1; shift <= 3; shift++) redecorate(view, manyDecos(shift))
    const elapsed = (performance.now() - start) / 3
    expect(view.renderer.leafAt([0, 0])!.textContent).toHaveLength(5000)
    expect(view.renderer.leafAt([0, 0])!.querySelectorAll('[data-penline-deco]').length).toBeGreaterThan(2900)
    // Generous: DOM building in happy-dom dominates and slows down under a loaded test run.
    expect(elapsed).toBeLessThan(1500)
  })

  it('splits a decoration spanning blocks over the texts between them only', () => {
    const d = doc(p('a', txt('ab')), p('b', txt('cd'), txt('ef', 'bold')), p('c', txt('gh')), p('z', txt('zz')))
    const grouped = groupDecorations(d, [inline(pt([2, 0], 1), pt([0, 0], 1), { class: 'x' })])
    expect([...grouped.keys()]).toEqual(['0,0', '1,0', '1,1', '2,0'])
    expect(grouped.get('0,0')!.inline[0]).toMatchObject({ from: 1, to: 2 })
    expect(grouped.get('1,1')!.inline[0]).toMatchObject({ from: 0, to: 2 })
    expect(grouped.get('2,0')!.inline[0]).toMatchObject({ from: 0, to: 1 })
  })

  it('a selection-only update keeps an unchanged decorated leaf', () => {
    const decos = [inline(pt([0, 0], 1), pt([0, 0], 3), { class: 'x' })]
    const { editor, view } = mount([p('p1', txt('abcde')), p('p2', txt('fgh'))], decos)
    const leaf = view.renderer.leafAt([0, 0])!
    const span = leaf.querySelector('[data-penline-deco]')!
    const nodes = Array.from(leaf.childNodes)
    editor.dispatch(editor.createTransaction().setSelection(caret([1, 0], 2)))
    expect(view.renderer.leafAt([0, 0])).toBe(leaf)
    expect(leaf.querySelector('[data-penline-deco]')).toBe(span)
    expect(Array.from(leaf.childNodes)).toEqual(nodes)
  })
})
