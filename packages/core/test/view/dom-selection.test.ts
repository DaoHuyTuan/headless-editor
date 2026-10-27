// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { definePlugin } from '../../src/plugin/define'
import type { ElementNode, Node, Selection } from '../../src/model/types'
import { Renderer, domToModel, modelToDom, readDomSelection, writeDomSelection } from '../../src/index'
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
    const unrendered: Selection = { anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 0 } }
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
    const br = leaf.querySelector('br[data-hte-break]')!
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

  it('returns null when the doc has no leaves', () => {
    ctx.renderer.render(doc(node('u', 'mystery')))
    expect(domToModel(ctx.renderer, ctx.root, 0)).toBeNull()
  })
})

describe('read/writeDomSelection', () => {
  const domSel = () => document.getSelection()!

  it('round-trips a cross-block selection', () => {
    ctx.renderer.render(doc(p('p1', txt('a'), txt('b', 'bold')), p('p2', 'cde')))
    const sel: Selection = { anchor: { path: [0, 1], offset: 1 }, focus: { path: [1, 0], offset: 2 } }
    writeDomSelection(ctx.renderer, sel, domSel())
    expect(readDomSelection(ctx.renderer, domSel())).toEqual(sel)
  })

  it('preserves a backward direction', () => {
    ctx.renderer.render(doc(p('p1', 'ab'), p('p2', 'cd')))
    const sel: Selection = { anchor: { path: [1, 0], offset: 1 }, focus: { path: [0, 0], offset: 1 } }
    writeDomSelection(ctx.renderer, sel, domSel())
    expect(readDomSelection(ctx.renderer, domSel())).toEqual(sel)
  })

  it('does nothing when the DOM already matches', () => {
    ctx.renderer.render(doc(p('p1', 'ab')))
    const sel: Selection = { anchor: { path: [0, 0], offset: 1 }, focus: { path: [0, 0], offset: 1 } }
    writeDomSelection(ctx.renderer, sel, domSel())
    const spy = vi.spyOn(domSel(), 'setBaseAndExtent')
    writeDomSelection(ctx.renderer, sel, domSel())
    expect(spy).not.toHaveBeenCalled()
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
    writeDomSelection(ctx.renderer, { anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 1 } }, domSel())
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
    const sel: Selection = { anchor: { path: [0, 0], offset: 2 }, focus: { path: [0, 0], offset: 2 }, node: [1] }
    writeDomSelection(renderer, sel, domSel())
    expect(domSel().anchorNode).toBe(root)
    expect(domSel().anchorOffset).toBe(1)
    expect(domSel().focusNode).toBe(root)
    expect(domSel().focusOffset).toBe(2)
    expect(readDomSelection(renderer, domSel())).toEqual(sel)
  })

  it('writing a caret over a node selection with the same caret replaces the DOM range', () => {
    const { renderer } = setupAtoms()
    const caretSel: Selection = { anchor: { path: [0, 0], offset: 2 }, focus: { path: [0, 0], offset: 2 } }
    writeDomSelection(renderer, { ...caretSel, node: [1] }, domSel())
    writeDomSelection(renderer, caretSel, domSel())
    expect(readDomSelection(renderer, domSel())).toEqual(caretSel)
  })

  it('never reads a node selection for an inline element', () => {
    const { renderer } = setupAtoms()
    const chip = renderer.elementAt([2, 1])!
    const parent = chip.parentNode!
    const i = Array.prototype.indexOf.call(parent.childNodes, chip) as number
    domSel().setBaseAndExtent(parent, i, parent, i + 1)
    expect(readDomSelection(renderer, domSel())?.node).toBeUndefined()
  })
})
