// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { definePlugin } from '../../src/plugin/define'
import type { ElementNode, Node } from '../../src/model/types'
import { Renderer } from '../../src/index'
import { createTestEditor, doc, txt } from '../../src/testing/index'
import { testBold, testParagraph } from '../fixtures'

const p = (id: string, ...children: (Node | string)[]): ElementNode => ({
  id,
  type: 'paragraph',
  data: {},
  children: children.map((c) => (typeof c === 'string' ? txt(c) : c)),
})
const node = (id: string, type: string, data: ElementNode['data'], ...children: Node[]): ElementNode => ({
  id,
  type,
  data,
  children,
})

const italic = definePlugin({ name: 'italic', mark: { render: () => ({ tag: 'em' }) } })
const color = definePlugin({
  name: 'color',
  mark: {
    render: (d: { value?: string }) => ({ tag: 'span', attrs: { 'data-c': '1' }, style: { backgroundColor: String(d.value) } }),
  },
})
const heading = definePlugin({
  name: 'heading',
  node: { kind: 'block', content: 'inline' },
  options: { prefix: 'h' },
  renderHTML: (n, { options }) => [`${options.prefix}${String(n.data.level)}`, { class: 'x', 'data-u': undefined }, 0],
})
const callout = definePlugin({
  name: 'callout',
  node: { kind: 'block' },
  renderHTML: () => ['aside', ['span', { contenteditable: 'false' }, 'Note:'], ['div', 0], ['footer', 'end']],
})
const noHole = definePlugin({ name: 'noHole', node: { kind: 'block' }, renderHTML: () => ['section', { a: 1 }] })
const bare = definePlugin({ name: 'bare', node: { kind: 'block' } })
const bareInline = definePlugin({ name: 'bareInline', node: { kind: 'inline' } })
const bad = definePlugin({ name: 'bad', node: { kind: 'block' }, renderHTML: () => ['bad tag', 0] })
const badAttr = definePlugin({ name: 'badAttr', node: { kind: 'block' }, renderHTML: () => ['p', { 'on click': 'x' }, 0] })
const badMark = definePlugin({ name: 'badMark', mark: { render: () => ({ tag: 'x y' }) } })

function setup() {
  const editor = createTestEditor({
    plugins: [testParagraph, testBold, italic, color, heading, callout, noHole, bare, bareInline, bad, badAttr, badMark],
  })
  const root = document.createElement('div')
  return { editor, root, renderer: new Renderer(root, editor) }
}

let ctx: ReturnType<typeof setup>
beforeEach(() => {
  ctx = setup()
})

describe('Renderer: root setup', () => {
  it('makes the root an editable multiline textbox', () => {
    const { root } = ctx
    expect(root.getAttribute('contenteditable')).toBe('true')
    expect(root.getAttribute('role')).toBe('textbox')
    expect(root.getAttribute('aria-multiline')).toBe('true')
    expect(root.style.whiteSpace).toBe('pre-wrap')
  })
})

describe('Renderer: DOM contract', () => {
  it('renders elements with ids and text leaves with marks', () => {
    ctx.renderer.render(doc(p('p1', txt('a'), txt('b', 'bold'))))
    expect(ctx.root.innerHTML).toBe(
      '<p data-hte-id="p1"><span data-hte-leaf="">a</span><span data-hte-leaf=""><strong>b</strong></span></p>',
    )
  })

  it('renders an empty text as a break', () => {
    ctx.renderer.render(doc(p('p1', txt(''))))
    expect(ctx.root.innerHTML).toBe('<p data-hte-id="p1"><span data-hte-leaf=""><br data-hte-break=""></span></p>')
  })

  it('nests marks by rank (lowest outermost) regardless of model order, ignoring unknown marks', () => {
    ctx.renderer.render(
      doc(p('p1', txt('x', { type: 'color', data: { value: 'red' } }, 'italic', 'nope', 'bold'))),
    )
    const leaf = ctx.root.querySelector('[data-hte-leaf]')!
    expect(leaf.innerHTML).toBe(
      '<strong><em><span data-c="1" style="background-color: red;">x</span></em></strong>',
    )
  })

  it('renders renderHTML specs with options, attrs and the content hole', () => {
    ctx.renderer.render(doc(node('h', 'heading', { level: 2 }, txt('T'))))
    expect(ctx.root.innerHTML).toBe('<h2 class="x" data-hte-id="h"><span data-hte-leaf="">T</span></h2>')
  })

  it('places children at a nested hole', () => {
    ctx.renderer.render(doc(node('c', 'callout', {}, p('p1', 'a'))))
    expect(ctx.root.innerHTML).toBe(
      '<aside data-hte-id="c"><span contenteditable="false">Note:</span><div><p data-hte-id="p1"><span data-hte-leaf="">a</span></p></div><footer>end</footer></aside>',
    )
  })

  it('appends children to the root when the spec has no hole', () => {
    ctx.renderer.render(doc(node('s', 'noHole', {}, txt('a'))))
    expect(ctx.root.innerHTML).toBe('<section a="1" data-hte-id="s"><span data-hte-leaf="">a</span></section>')
  })

  it('wraps known elements without renderHTML in a div (block) or span (inline)', () => {
    ctx.renderer.render(doc(node('b', 'bare', {}, txt('a'), node('i', 'bareInline', {}, txt('b')))))
    expect(ctx.root.innerHTML).toBe(
      '<div data-hte-id="b"><span data-hte-leaf="">a</span><span data-hte-id="i"><span data-hte-leaf="">b</span></span></div>',
    )
  })

  it('renders unknown elements as non-editable placeholders without children', () => {
    ctx.renderer.render(doc(node('u', 'mystery', {}, txt('hidden'))))
    expect(ctx.root.innerHTML).toBe('<div data-hte-id="u" data-hte-unknown="mystery" contenteditable="false"></div>')
  })

  it('throws on invalid tag or attribute names', () => {
    expect(() => ctx.renderer.render(doc(node('x', 'bad', {}, txt('a'))))).toThrow('Invalid HTML tag name "bad tag"')
    expect(() => setup().renderer.render(doc(node('x', 'badAttr', {}, txt('a'))))).toThrow(
      'Invalid HTML attribute name "on click"',
    )
    expect(() => setup().renderer.render(doc(p('x', txt('a', 'badMark'))))).toThrow('Invalid HTML tag name "x y"')
  })

  it('creates nodes with the root ownerDocument', () => {
    const { editor } = ctx
    const other = document.implementation.createHTMLDocument('other')
    const root = other.createElement('div')
    const r = new Renderer(root, editor)
    r.render(doc(p('p1', 'a')))
    expect(root.firstElementChild!.ownerDocument).toBe(other)
    expect(root.querySelector('[data-hte-leaf]')!.ownerDocument).toBe(other)
  })
})

describe('Renderer: keyed patching', () => {
  it('reuses an element DOM when only its text changes', () => {
    const { renderer, root } = ctx
    renderer.render(doc(p('p1', 'a'), p('p2', 'b')))
    const p1 = root.children[0]
    const p2 = root.children[1]
    const leaf1 = p1!.firstElementChild
    renderer.render(doc(p('p1', 'a'), p('p2', 'bc')))
    expect(root.children[0]).toBe(p1)
    expect(root.children[1]).toBe(p2)
    expect(p1!.firstElementChild).toBe(leaf1)
    expect(root.innerHTML).toBe(
      '<p data-hte-id="p1"><span data-hte-leaf="">a</span></p><p data-hte-id="p2"><span data-hte-leaf="">bc</span></p>',
    )
  })

  it('reuses both elements when reordered', () => {
    const { renderer, root } = ctx
    renderer.render(doc(p('p1', 'a'), p('p2', 'b')))
    const [p1, p2] = [root.children[0], root.children[1]]
    renderer.render(doc(p('p2', 'b'), p('p1', 'a')))
    expect(root.children[0]).toBe(p2)
    expect(root.children[1]).toBe(p1)
    expect(root.children.length).toBe(2)
  })

  it('inserts and removes elements', () => {
    const { renderer, root } = ctx
    renderer.render(doc(p('p1', 'a'), p('p2', 'b'), p('p3', 'c')))
    const p1 = root.children[0]
    const p3 = root.children[2]
    renderer.render(doc(p('p1', 'a'), p('p4', 'd'), p('p3', 'c')))
    expect(root.innerHTML).toBe(
      '<p data-hte-id="p1"><span data-hte-leaf="">a</span></p><p data-hte-id="p4"><span data-hte-leaf="">d</span></p><p data-hte-id="p3"><span data-hte-leaf="">c</span></p>',
    )
    expect(root.children[0]).toBe(p1)
    expect(root.children[2]).toBe(p3)
    expect(ctx.renderer.elementAt([1])).toBe(root.children[1])
  })

  it('moves an element between parents, keeping its DOM', () => {
    const { renderer, root } = ctx
    renderer.render(doc(node('c1', 'callout', {}, p('p1', 'a')), node('c2', 'callout', {})))
    const p1 = root.querySelector('[data-hte-id="p1"]')
    renderer.render(doc(node('c1', 'callout', {}), node('c2', 'callout', {}, p('p1', 'a'))))
    expect(root.querySelector('[data-hte-id="c2"] [data-hte-id="p1"]')).toBe(p1)
    expect(root.querySelectorAll('[data-hte-id="p1"]').length).toBe(1)
    expect(renderer.elementAt([1, 0])).toBe(p1)
  })

  it('re-renders an element root when its data changes but keeps child DOM', () => {
    const { renderer, root } = ctx
    renderer.render(doc(node('h', 'heading', { level: 1 }, txt('T'))))
    const h1 = root.firstElementChild
    const leaf = h1!.firstElementChild
    renderer.render(doc(node('h', 'heading', { level: 1 }, txt('T'))))
    expect(root.firstElementChild).toBe(h1) // deep-equal data → reused
    renderer.render(doc(node('h', 'heading', { level: 3 }, txt('T'))))
    expect(root.innerHTML).toBe('<h3 class="x" data-hte-id="h"><span data-hte-leaf="">T</span></h3>')
    expect(root.firstElementChild).not.toBe(h1)
    expect(root.firstElementChild!.firstElementChild).toBe(leaf)
    expect(renderer.elementAt([0])).toBe(root.firstElementChild)
  })

  it('re-renders an element root when its type changes', () => {
    const { renderer, root } = ctx
    renderer.render(doc(p('x', 'a')))
    renderer.render(doc(node('x', 'heading', { level: 1 }, txt('a'))))
    expect(root.innerHTML).toBe('<h1 class="x" data-hte-id="x"><span data-hte-leaf="">a</span></h1>')
  })

  it('reconciles leaves positionally: reuses unchanged, updates changed, adds and removes', () => {
    const { renderer, root } = ctx
    renderer.render(doc(p('p1', txt('a'), txt('b', 'bold'), txt('c'))))
    const leaves = [...root.querySelectorAll('[data-hte-leaf]')]
    const textA = leaves[0]!.firstChild
    renderer.render(doc(p('p1', txt('a'), txt('b'))))
    const after = [...root.querySelectorAll('[data-hte-leaf]')]
    expect(after.length).toBe(2)
    expect(after[0]).toBe(leaves[0])
    expect(after[0]!.firstChild).toBe(textA)
    expect(after[1]).toBe(leaves[1])
    expect(root.innerHTML).toBe('<p data-hte-id="p1"><span data-hte-leaf="">a</span><span data-hte-leaf="">b</span></p>')
    renderer.render(doc(p('p1', txt('a'), txt('b'), txt(''))))
    expect(root.innerHTML).toBe(
      '<p data-hte-id="p1"><span data-hte-leaf="">a</span><span data-hte-leaf="">b</span><span data-hte-leaf=""><br data-hte-break=""></span></p>',
    )
  })

  it('keeps leaves before inline elements in order', () => {
    const { renderer, root } = ctx
    renderer.render(doc(node('b', 'bare', {}, txt('a'), node('i', 'bareInline', {}, txt('b')), txt('c'))))
    renderer.render(doc(node('b', 'bare', {}, txt('a'), txt('c'), node('i', 'bareInline', {}, txt('b')))))
    expect(root.innerHTML).toBe(
      '<div data-hte-id="b"><span data-hte-leaf="">a</span><span data-hte-leaf="">c</span><span data-hte-id="i"><span data-hte-leaf="">b</span></span></div>',
    )
  })

  it('leaves skipLeaf untouched even when the model differs, then catches up', () => {
    const { renderer, root } = ctx
    renderer.render(doc(p('p1', txt('ab'))))
    const leaf = renderer.leafAt([0, 0])!
    const text = leaf.firstChild
    renderer.render(doc(p('p1', txt('abc', 'bold'))), { skipLeaf: leaf })
    expect(renderer.leafAt([0, 0])).toBe(leaf)
    expect(leaf.firstChild).toBe(text)
    expect(leaf.innerHTML).toBe('ab')
    renderer.render(doc(p('p1', txt('abc', 'bold'))))
    expect(leaf.innerHTML).toBe('<strong>abc</strong>')
    expect(root.querySelectorAll('[data-hte-leaf]').length).toBe(1)
  })

  it('does not rewrite a skipped leaf whose DOM already matches the model', () => {
    const { renderer } = ctx
    renderer.render(doc(p('p1', txt('ab'))))
    const leaf = renderer.leafAt([0, 0])!
    const text = leaf.firstChild as Text
    text.data = 'abc' // the browser typed into it (e.g. IME)
    renderer.render(doc(p('p1', txt('abc'))), { skipLeaf: leaf })
    renderer.render(doc(p('p1', txt('abc'))))
    expect(leaf.firstChild).toBe(text)
  })

  it('drops ids that are no longer in the doc', () => {
    const { renderer, root } = ctx
    renderer.render(doc(p('p1', 'a'), p('p2', 'b')))
    const p2 = root.children[1]
    renderer.render(doc(p('p1', 'a')))
    renderer.render(doc(p('p1', 'a'), p('p2', 'b')))
    expect(root.children[1]).not.toBe(p2)
  })
})

describe('Renderer: lookups', () => {
  it('maps paths to leaves and elements and back', () => {
    const { renderer, root } = ctx
    renderer.render(doc(p('p1', 'a'), node('c', 'callout', {}, p('p2', txt('b'), txt('c', 'bold')))))
    const leaf = renderer.leafAt([1, 0, 1])!
    expect(leaf.textContent).toBe('c')
    expect(renderer.pathOfLeaf(leaf)).toEqual([1, 0, 1])
    expect(renderer.pathOfLeaf(leaf.firstElementChild!)).toBeNull()
    expect(renderer.pathOfLeaf(renderer.leafAt([0, 0])!)).toEqual([0, 0])
    expect(renderer.elementAt([1, 0])).toBe(root.querySelector('[data-hte-id="p2"]'))
    expect(renderer.elementAt([1])).toBe(root.querySelector('[data-hte-id="c"]'))
    expect(renderer.elementAt([0, 0])).toBeNull() // a leaf, not an element
    expect(renderer.leafAt([1, 0])).toBeNull() // an element, not a leaf
    expect(renderer.leafAt([5, 0])).toBeNull()
    expect(renderer.elementAt([])).toBeNull()
    expect(renderer.pathOfLeaf(document.createElement('span'))).toBeNull()
  })

  it('stays correct after patches', () => {
    const { renderer } = ctx
    renderer.render(doc(p('p1', 'a'), p('p2', txt('b'), txt('c', 'bold'))))
    const leafC = renderer.leafAt([1, 1])!
    renderer.render(doc(p('p0', 'z'), p('p2', txt('b'), txt('c', 'bold')), p('p1', 'a')))
    expect(renderer.leafAt([1, 1])).toBe(leafC)
    expect(renderer.pathOfLeaf(leafC)).toEqual([1, 1])
    expect(renderer.leafAt([2, 0])!.textContent).toBe('a')
    renderer.render(doc(p('p1', 'a')))
    expect(renderer.pathOfLeaf(leafC)).toBeNull()
  })

  it('returns null for leaves inside unknown elements', () => {
    const { renderer } = ctx
    renderer.render(doc(node('u', 'mystery', {}, txt('x'))))
    expect(renderer.leafAt([0, 0])).toBeNull()
    expect(renderer.elementAt([0])!.getAttribute('data-hte-unknown')).toBe('mystery')
  })
})
