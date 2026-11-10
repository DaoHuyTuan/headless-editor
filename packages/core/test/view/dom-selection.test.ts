// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mainRange, single } from '../../src/model/selection'
import { definePlugin } from '../../src/plugin/define'
import type { ElementNode, Node, Selection } from '../../src/model/types'
import { Renderer, domToModel, modelToDom, readDomSelection, writeDomSelection } from '../../src/internal'
import { createTestEditor, doc, txt } from '../../src/testing/index'
import { testBold, testParagraph } from '../fixtures'

const p = (id: string, ...children: (Node | string)[]): ElementNode => ({
  id,
  type: 'paragraph',
  data: {},
  children: children.map((c) => (typeof c === 'string' ? txt(c) : c)),
})
const node = (id: string, type: string, ...children: Node[]): ElementNode => ({ id, type, data: {}, children })

const callout = definePlugin({
  name: 'callout',
  node: { kind: 'block' },
  renderHTML: () => ['aside', ['span', { contenteditable: 'false' }, 'Note:'], ['div', 0], ['footer', 'end']],
})

function setup() {
  const editor = createTestEditor({ plugins: [testParagraph, testBold, callout] })
  const root = document.createElement('div')
  document.body.appendChild(root)
  return { editor, root, renderer: new Renderer(root, editor) }
}

let ctx: ReturnType<typeof setup>
beforeEach(() => {
  ctx = setup()
})
afterEach(() => {
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

const textIn = (el: globalThis.Node): Text => {
  const walker = document.createTreeWalker(el, 4 /* SHOW_TEXT */)
  return walker.nextNode() as Text
}

describe('modelToDom', () => {
  it('maps into the DOM text inside mark wrappers', () => {
    ctx.renderer.render(doc(p('p1', txt('a'), txt('b', 'bold'))))
    const { node: n, offset } = modelToDom(ctx.renderer, { path: [0, 1], offset: 1 })
    expect(n.nodeType).toBe(3)
    expect((n as Text).data).toBe('b')
    expect(n.parentElement!.tagName).toBe('STRONG')
    expect(offset).toBe(1)
  })

  it('maps an empty leaf to (leaf, 0)', () => {
    ctx.renderer.render(doc(p('p1', txt(''))))
    const leaf = ctx.renderer.leafAt([0, 0])!
    expect(modelToDom(ctx.renderer, { path: [0, 0], offset: 0 })).toEqual({ node: leaf, offset: 0 })
  })

  it('throws for a point with no leaf', () => {
    ctx.renderer.render(doc(p('p1', 'a')))
    expect(() => modelToDom(ctx.renderer, { path: [3, 0], offset: 0 })).toThrow()
  })

  it('writeDomSelection skips (does not throw) when a point has no rendered leaf', () => {
    ctx.renderer.render(doc(node('w', 'widget', txt('hidden')), p('p1', 'a')))
    const domSel = document.getSelection()!
    const leaf = ctx.renderer.leafAt([1, 0])!
    domSel.collapse(textIn(leaf), 1)
    const unrendered: Selection = single({ anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 0 } })
    expect(() => writeDomSelection(ctx.renderer, unrendered, domSel)).not.toThrow()
    expect(domSel.anchorNode).toBe(textIn(leaf))
    expect(domSel.anchorOffset).toBe(1)
  })
})

describe('domToModel', () => {
  it('maps a DOM text inside mark wrappers back to the model', () => {
    ctx.renderer.render(doc(p('p1', txt('a'), txt('b', 'bold'))))
    const { node: n, offset } = modelToDom(ctx.renderer, { path: [0, 1], offset: 1 })
    expect(domToModel(ctx.renderer, n, offset)).toEqual({ path: [0, 1], offset: 1 })
  })

  it('clamps a text offset to the text length', () => {
    ctx.renderer.render(doc(p('p1', 'abc')))
    expect(domToModel(ctx.renderer, textIn(ctx.root), 9)).toEqual({ path: [0, 0], offset: 3 })
  })

  it('maps an element container child index to the nearest leaf boundary', () => {
    ctx.renderer.render(doc(p('p1', txt('a'), txt('b', 'bold'))))
    const para = ctx.renderer.elementAt([0])!
    expect(domToModel(ctx.renderer, para, 1)).toEqual({ path: [0, 1], offset: 0 })
    expect(domToModel(ctx.renderer, para, 0)).toEqual({ path: [0, 0], offset: 0 })
    expect(domToModel(ctx.renderer, para, 2)).toEqual({ path: [0, 1], offset: 1 })
  })

  it('maps the root container to leaf boundaries across blocks', () => {
    ctx.renderer.render(doc(p('p1', 'ab'), p('p2', 'cd')))
    expect(domToModel(ctx.renderer, ctx.root, 1)).toEqual({ path: [1, 0], offset: 0 })
    expect(domToModel(ctx.renderer, ctx.root, 2)).toEqual({ path: [1, 0], offset: 2 })
  })

  it('maps the leaf span and mark wrappers as containers', () => {
    ctx.renderer.render(doc(p('p1', txt('bc', 'bold'))))
    const leaf = ctx.renderer.leafAt([0, 0])!
    const strong = leaf.firstChild!
    expect(domToModel(ctx.renderer, leaf, 0)).toEqual({ path: [0, 0], offset: 0 })
    expect(domToModel(ctx.renderer, leaf, 1)).toEqual({ path: [0, 0], offset: 2 })
    expect(domToModel(ctx.renderer, strong, 0)).toEqual({ path: [0, 0], offset: 0 })
    expect(domToModel(ctx.renderer, strong, 1)).toEqual({ path: [0, 0], offset: 2 })
  })

  it('maps a break and its leaf to offset 0', () => {
    ctx.renderer.render(doc(p('p1', txt(''))))
    const leaf = ctx.renderer.leafAt([0, 0])!
    const br = leaf.querySelector('br[data-penline-break]')!
    expect(domToModel(ctx.renderer, br, 0)).toEqual({ path: [0, 0], offset: 0 })
    expect(domToModel(ctx.renderer, leaf, 1)).toEqual({ path: [0, 0], offset: 0 })
  })

  it('returns null outside the root', () => {
    ctx.renderer.render(doc(p('p1', 'a')))
    const outside = document.createElement('div')
    outside.textContent = 'x'
    document.body.appendChild(outside)
    expect(domToModel(ctx.renderer, outside, 0)).toBeNull()
    expect(domToModel(ctx.renderer, outside.firstChild!, 0)).toBeNull()
  })

  it('maps static spec nodes to the nearest leaf in their element', () => {
    ctx.renderer.render(doc(p('p0', 'x'), node('c', 'callout', p('p1', 'ab'))))
    const aside = ctx.renderer.elementAt([1])!
    const label = aside.querySelector('span[contenteditable]')!
    const footer = aside.querySelector('footer')!
    expect(domToModel(ctx.renderer, label.firstChild!, 2)).toEqual({ path: [1, 0, 0], offset: 0 })
    expect(domToModel(ctx.renderer, footer.firstChild!, 1)).toEqual({ path: [1, 0, 0], offset: 2 })
    expect(domToModel(ctx.renderer, footer, 0)).toEqual({ path: [1, 0, 0], offset: 2 })
    expect(domToModel(ctx.renderer, aside, 0)).toEqual({ path: [1, 0, 0], offset: 0 })
  })

  it('maps positions inside unknown elements to the nearest leaf before or after', () => {
    ctx.renderer.render(doc(p('p1', 'ab'), node('u', 'mystery'), p('p2', 'cd')))
    const unknown = ctx.renderer.elementAt([1])!
    expect(domToModel(ctx.renderer, unknown, 0)).toEqual({ path: [0, 0], offset: 2 })

    ctx.renderer.render(doc(node('u', 'mystery'), p('p2', 'cd')))
    expect(domToModel(ctx.renderer, ctx.renderer.elementAt([0])!, 0)).toEqual({ path: [1, 0], offset: 0 })
  })

  it('maps positions in a non-editable block to the boundary before it, or after it past its middle (5.7)', () => {
    const figure = definePlugin({
      name: 'figure',
      node: { kind: 'block', atom: true },
      renderHTML: () => ['figure', { contenteditable: 'false' }, ['span', 'A'], ['span', 'B']],
    })
    const editor = createTestEditor({ plugins: [testParagraph, figure] })
    const root = document.createElement('div')
    document.body.appendChild(root)
    const renderer = new Renderer(root, editor)
    renderer.render(doc(p('p1', 'ab'), node('f', 'figure'), p('p2', 'cd')))
    const fig = renderer.elementAt([1])!
    const [a, b] = Array.from(fig.querySelectorAll('span')).map((s) => s.firstChild!)
    const before = { path: [0, 0], offset: 2 }
    const after = { path: [2, 0], offset: 0 }
    expect(domToModel(renderer, fig, 0)).toEqual(before)
    expect(domToModel(renderer, fig, 1)).toEqual(before)
    expect(domToModel(renderer, fig, 2)).toEqual(after)
    expect(domToModel(renderer, a!, 1)).toEqual(before)
    expect(domToModel(renderer, b!, 0)).toEqual(before)
    expect(domToModel(renderer, b!, 1)).toEqual(after)
  })

  it('returns null when the doc has no leaves', () => {
    ctx.renderer.render(doc(node('u', 'mystery')))
    expect(domToModel(ctx.renderer, ctx.root, 0)).toBeNull()
  })
})

describe('read/writeDomSelection', () => {
  const domSel = () => document.getSelection()!

  it('round-trips a cross-block selection', () => {
    ctx.renderer.render(doc(p('p1', txt('a'), txt('b', 'bold')), p('p2', 'cde')))
    const sel: Selection = single({ anchor: { path: [0, 1], offset: 1 }, focus: { path: [1, 0], offset: 2 } })
    writeDomSelection(ctx.renderer, sel, domSel())
    expect(readDomSelection(ctx.renderer, domSel())).toEqual(sel)
  })

  it('preserves a backward direction', () => {
    ctx.renderer.render(doc(p('p1', 'ab'), p('p2', 'cd')))
    const sel: Selection = single({ anchor: { path: [1, 0], offset: 1 }, focus: { path: [0, 0], offset: 1 } })
    writeDomSelection(ctx.renderer, sel, domSel())
    expect(readDomSelection(ctx.renderer, domSel())).toEqual(sel)
  })

  it('does nothing when the DOM already matches', () => {
    ctx.renderer.render(doc(p('p1', 'ab')))
    const sel: Selection = single({ anchor: { path: [0, 0], offset: 1 }, focus: { path: [0, 0], offset: 1 } })
    writeDomSelection(ctx.renderer, sel, domSel())
    const spy = vi.spyOn(domSel(), 'setBaseAndExtent')
    writeDomSelection(ctx.renderer, sel, domSel())
    expect(spy).not.toHaveBeenCalled()
  })

  it('moves a DOM caret outside the leaves into them, even when it maps to the same point', () => {
    // E.g. the browser collapsed the caret into the root after its leaf was replaced.
    ctx.renderer.render(doc(p('p1', '')))
    domSel().setBaseAndExtent(ctx.root, 0, ctx.root, 0)
    const sel: Selection = single({ anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 0 } })
    expect(readDomSelection(ctx.renderer, domSel())).toEqual(sel)
    writeDomSelection(ctx.renderer, sel, domSel())
    const leaf = ctx.renderer.leafAt([0, 0])!
    expect(domSel().anchorNode).toBe(leaf)
    expect(domSel().focusNode).toBe(leaf)
    // Now in the leaf: a second write does nothing.
    const spy = vi.spyOn(domSel(), 'setBaseAndExtent')
    writeDomSelection(ctx.renderer, sel, domSel())
    expect(spy).not.toHaveBeenCalled()
  })

  it('moves a collapsed DOM caret parked at a block element child index into the leaf (5.14)', () => {
    ctx.renderer.render(doc(p('p1', txt('a'), txt('b', 'bold'))))
    const para = ctx.renderer.elementAt([0])!
    domSel().collapse(para, 1)
    const sel: Selection = single({ anchor: { path: [0, 1], offset: 0 }, focus: { path: [0, 1], offset: 0 } })
    expect(readDomSelection(ctx.renderer, domSel())).toEqual(sel)
    writeDomSelection(ctx.renderer, sel, domSel())
    expect(ctx.renderer.leafAt([0, 1])!.contains(domSel().anchorNode)).toBe(true)
    expect(readDomSelection(ctx.renderer, domSel())).toEqual(sel)
  })

  it('moves a collapsed DOM caret in a static spec text into the leaf it maps to (5.7)', () => {
    ctx.renderer.render(doc(p('p0', 'x'), node('c', 'callout', p('p1', 'ab'))))
    const footerText = ctx.renderer.elementAt([1])!.querySelector('footer')!.firstChild!
    domSel().collapse(footerText, 1)
    const sel: Selection = single({ anchor: { path: [1, 0, 0], offset: 2 }, focus: { path: [1, 0, 0], offset: 2 } })
    expect(readDomSelection(ctx.renderer, domSel())).toEqual(sel)
    writeDomSelection(ctx.renderer, sel, domSel())
    expect(ctx.renderer.leafAt([1, 0, 0])!.contains(domSel().anchorNode)).toBe(true)
  })

  it('keeps a non-collapsed DOM selection ending at a block boundary that maps to the model (mid-drag)', () => {
    ctx.renderer.render(doc(p('p1', 'ab'), p('p2', 'cd')))
    const leaf = textIn(ctx.renderer.leafAt([0, 0])!)
    const para2 = ctx.renderer.elementAt([1])!
    domSel().setBaseAndExtent(leaf, 1, para2, 0)
    const sel: Selection = single({ anchor: { path: [0, 0], offset: 1 }, focus: { path: [1, 0], offset: 0 } })
    expect(readDomSelection(ctx.renderer, domSel())).toEqual(sel)
    const spy = vi.spyOn(domSel(), 'setBaseAndExtent')
    writeDomSelection(ctx.renderer, sel, domSel())
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('maps the caret after a trailing newline to the end of the text, before the trailing break', () => {
    ctx.renderer.render(doc(p('p1', 'a\n')))
    const leaf = ctx.renderer.leafAt([0, 0])!
    const text = leaf.firstChild as Text
    expect(modelToDom(ctx.renderer, { path: [0, 0], offset: 2 })).toEqual({ node: text, offset: 2 })
    expect(domToModel(ctx.renderer, leaf, 1)).toEqual({ path: [0, 0], offset: 2 })
    expect(domToModel(ctx.renderer, leaf, 2)).toEqual({ path: [0, 0], offset: 2 })
    expect(domToModel(ctx.renderer, leaf.querySelector('br')!, 0)).toEqual({ path: [0, 0], offset: 2 })
  })

  it('reads null with no ranges or outside the root', () => {
    ctx.renderer.render(doc(p('p1', 'ab')))
    domSel().removeAllRanges()
    expect(readDomSelection(ctx.renderer, domSel())).toBeNull()
    const outside = document.createElement('div')
    outside.textContent = 'x'
    document.body.appendChild(outside)
    domSel().setBaseAndExtent(outside.firstChild!, 0, outside.firstChild!, 1)
    expect(readDomSelection(ctx.renderer, domSel())).toBeNull()
  })

  it('clears a DOM selection inside the root for a null selection, but not one outside', () => {
    ctx.renderer.render(doc(p('p1', 'ab')))
    writeDomSelection(ctx.renderer, single({ anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 1 } }), domSel())
    writeDomSelection(ctx.renderer, null, domSel())
    expect(domSel().rangeCount).toBe(0)

    const outside = document.createElement('div')
    outside.textContent = 'x'
    document.body.appendChild(outside)
    domSel().setBaseAndExtent(outside.firstChild!, 0, outside.firstChild!, 1)
    writeDomSelection(ctx.renderer, null, domSel())
    expect(domSel().rangeCount).toBe(1)
  })
})

describe('read/writeDomSelection: node selections', () => {
  const domSel = () => document.getSelection()!
  const atom = definePlugin({ name: 'atom', node: { kind: 'block', atom: true } })
  const inlineAtom = definePlugin({ name: 'chip', node: { kind: 'inline', atom: true } })

  function setupAtoms() {
    const editor = createTestEditor({ plugins: [testParagraph, atom, inlineAtom] })
    const root = document.createElement('div')
    document.body.appendChild(root)
    const renderer = new Renderer(root, editor)
    renderer.render(doc(p('p1', 'ab'), node('a1', 'atom'), p('p2', 'c', node('c1', 'chip'), 'd')))
    return { root, renderer }
  }

  it('writes a node selection around the element root and reads it back', () => {
    const { root, renderer } = setupAtoms()
    const sel: Selection = single({ anchor: { path: [0, 0], offset: 2 }, focus: { path: [0, 0], offset: 2 }, node: [1] })
    writeDomSelection(renderer, sel, domSel())
    expect(domSel().anchorNode).toBe(root)
    expect(domSel().anchorOffset).toBe(1)
    expect(domSel().focusNode).toBe(root)
    expect(domSel().focusOffset).toBe(2)
    expect(readDomSelection(renderer, domSel())).toEqual(sel)
  })

  it('writing a caret over a node selection with the same caret replaces the DOM range', () => {
    const { renderer } = setupAtoms()
    const caretSel: Selection = single({ anchor: { path: [0, 0], offset: 2 }, focus: { path: [0, 0], offset: 2 } })
    writeDomSelection(renderer, single({ ...mainRange(caretSel), node: [1] }), domSel())
    writeDomSelection(renderer, caretSel, domSel())
    expect(readDomSelection(renderer, domSel())).toEqual(caretSel)
  })

  it('never reads a node selection for an inline element', () => {
    const { renderer } = setupAtoms()
    const chip = renderer.elementAt([2, 1])!
    const parent = chip.parentNode!
    const i = Array.prototype.indexOf.call(parent.childNodes, chip) as number
    domSel().setBaseAndExtent(parent, i, parent, i + 1)
    expect(readDomSelection(renderer, domSel())?.ranges[0]?.node).toBeUndefined()
  })
})

describe('inline atoms: DOM <-> model mapping', () => {
  const domSel = () => document.getSelection()!
  const chip = definePlugin({
    name: 'chip',
    node: { kind: 'inline', atom: true },
    renderHTML: () => ['span', { class: 'chip' }, '@abcd'],
  })
  const viewChip = definePlugin({ name: 'viewChip', node: { kind: 'inline', atom: true } })

  function setupChip(...children: (Node | string)[]) {
    const editor = createTestEditor({ plugins: [testParagraph, testBold, chip, viewChip] })
    const root = document.createElement('div')
    document.body.appendChild(root)
    const renderer = new Renderer(root, editor)
    renderer.render(doc(p('p1', ...children)))
    return { root, renderer }
  }

  it('renders the inline atom root non-editable and empty texts beside it as zero-width leaves', () => {
    const { renderer } = setupChip(txt(''), node('c1', 'chip'), txt(''))
    const chipDom = renderer.elementAt([0, 1])!
    expect(chipDom.getAttribute('contenteditable')).toBe('false')
    for (const path of [[0, 0], [0, 2]]) {
      const leaf = renderer.leafAt(path)!
      expect(leaf.querySelector('br')).toBeNull()
      expect(leaf.textContent).toBe('\u200b')
    }
  })

  it('model -> DOM -> model round-trips at every caret around the chip', () => {
    const { renderer } = setupChip(txt(''), node('c1', 'chip'), txt('ab'), node('c2', 'chip'), txt(''))
    for (const point of [
      { path: [0, 0], offset: 0 },
      { path: [0, 2], offset: 0 },
      { path: [0, 2], offset: 1 },
      { path: [0, 2], offset: 2 },
      { path: [0, 4], offset: 0 },
    ]) {
      const dom = modelToDom(renderer, point)
      expect(domToModel(renderer, dom.node, dom.offset)).toEqual(point)
    }
  })

  it('maps a DOM text offset after the zero-width placeholder to model offset 0', () => {
    const { renderer } = setupChip(txt('a'), node('c1', 'chip'), txt(''))
    const t = textIn(renderer.leafAt([0, 2])!)
    expect(domToModel(renderer, t, 1)).toEqual({ path: [0, 2], offset: 0 })
  })

  it('counts only the placeholder of a zero-width leaf as not text, not a real U+200B typed beside it (5.15)', () => {
    const { renderer } = setupChip(txt('a'), node('c1', 'chip'), txt(''))
    const t = textIn(renderer.leafAt([0, 2])!)
    // The user typed a real zero-width space next to the placeholder before the next render.
    t.data = '\u200b\u200b'
    expect(domToModel(renderer, t, 2)).toEqual({ path: [0, 2], offset: 1 })
    expect(domToModel(renderer, t, 1)).toEqual({ path: [0, 2], offset: 0 })
    expect(modelToDom(renderer, { path: [0, 2], offset: 1 })).toEqual({ node: t, offset: 2 })
  })

  it('maps positions inside the chip to the boundary before it, or after it past its middle', () => {
    const { renderer } = setupChip(txt('x'), node('c1', 'chip'), txt('y'))
    const chipText = textIn(renderer.elementAt([0, 1])!)
    expect(chipText.data).toBe('@abcd')
    expect(domToModel(renderer, chipText, 0)).toEqual({ path: [0, 0], offset: 1 })
    expect(domToModel(renderer, chipText, 2)).toEqual({ path: [0, 0], offset: 1 })
    expect(domToModel(renderer, chipText, 3)).toEqual({ path: [0, 2], offset: 0 })
    expect(domToModel(renderer, chipText, 5)).toEqual({ path: [0, 2], offset: 0 })
    const chipDom = renderer.elementAt([0, 1])!
    expect(domToModel(renderer, chipDom, 0)).toEqual({ path: [0, 0], offset: 1 })
    expect(domToModel(renderer, chipDom, 1)).toEqual({ path: [0, 2], offset: 0 })
  })

  it('maps container positions next to the chip to the adjacent text leaves', () => {
    const { renderer } = setupChip(txt('x'), node('c1', 'chip'), txt('y'))
    const chipDom = renderer.elementAt([0, 1])!
    const parent = chipDom.parentNode!
    const i = Array.prototype.indexOf.call(parent.childNodes, chipDom) as number
    expect(domToModel(renderer, parent, i)).toEqual({ path: [0, 0], offset: 1 })
    expect(domToModel(renderer, parent, i + 1)).toEqual({ path: [0, 2], offset: 0 })
  })

  it('writeDomSelection keeps a DOM selection on the chip that maps to the model selection', () => {
    const { renderer } = setupChip(txt('x'), node('c1', 'chip'), txt('y'))
    const chipDom = renderer.elementAt([0, 1])!
    const chipText = textIn(chipDom)
    const leafX = textIn(renderer.leafAt([0, 0])!)
    // E.g. mid-drag: from inside "x" to past the middle of the chip (its text, then the chip element).
    for (const [focusNode, focusOffset] of [
      [chipText, 4],
      [chipDom, 1],
    ] as const) {
      domSel().setBaseAndExtent(leafX, 0, focusNode, focusOffset)
      const sel: Selection = single({ anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 2], offset: 0 } })
      expect(readDomSelection(renderer, domSel())).toEqual(sel)
      const spy = vi.spyOn(domSel(), 'setBaseAndExtent')
      writeDomSelection(renderer, sel, domSel())
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
      expect(domSel().focusNode).toBe(focusNode)
    }
  })

  it('writeDomSelection places the caret in the text leaves beside the chip', () => {
    const { renderer } = setupChip(txt(''), node('c1', 'viewChip'), txt(''))
    const sel: Selection = single({ anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 2], offset: 0 } })
    writeDomSelection(renderer, sel, domSel())
    expect(renderer.leafAt([0, 0])!.contains(domSel().anchorNode)).toBe(true)
    expect(renderer.leafAt([0, 2])!.contains(domSel().focusNode)).toBe(true)
    expect(readDomSelection(renderer, domSel())).toEqual(sel)
  })
})

describe('inline atoms without text: past the middle (3.14)', () => {
  /** Two icons, no text: the middle is between them. */
  const icons = definePlugin({
    name: 'icons',
    node: { kind: 'inline', atom: true },
    renderHTML: () => ['span', { class: 'icons' }, ['i', { class: 'a' }], ['i', { class: 'b' }]],
  })

  it('a position inside the second child is past the middle, inside the first is not', () => {
    const editor = createTestEditor({ plugins: [testParagraph, icons] })
    const root = document.createElement('div')
    document.body.appendChild(root)
    const renderer = new Renderer(root, editor)
    renderer.render(doc({ id: 'p1', type: 'paragraph', data: {}, children: [txt('x'), { id: 'c1', type: 'icons', data: {} }, txt('y')] }))
    const el = renderer.elementAt([0, 1])!
    const [first, second] = [el.querySelector('i.a')!, el.querySelector('i.b')!]
    expect(domToModel(renderer, first, 0)).toEqual({ path: [0, 0], offset: 1 })
    expect(domToModel(renderer, second, 0)).toEqual({ path: [0, 2], offset: 0 })
    // On the atom element itself: offsets 0 and 1 are before, 2 (after both icons) is after.
    expect(domToModel(renderer, el, 1)).toEqual({ path: [0, 0], offset: 1 })
    expect(domToModel(renderer, el, 2)).toEqual({ path: [0, 2], offset: 0 })
    root.remove()
  })
})
