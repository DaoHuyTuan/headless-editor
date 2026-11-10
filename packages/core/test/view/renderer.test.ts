// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { definePlugin } from '../../src/plugin/define'
import type { ElementNode, Node } from '../../src/model/types'
import { Renderer } from '../../src/internal'
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
      '<p data-penline-id="p1"><span data-penline-leaf="">a</span><span data-penline-leaf=""><strong>b</strong></span></p>',
    )
  })

  it('renders an empty text as a break', () => {
    ctx.renderer.render(doc(p('p1', txt(''))))
    expect(ctx.root.innerHTML).toBe('<p data-penline-id="p1"><span data-penline-leaf=""><br data-penline-break=""></span></p>')
  })

  it('ends the last text of an element with a break when it ends with a newline', () => {
    ctx.renderer.render(doc(p('p1', 'a\n')))
    expect(ctx.root.innerHTML).toBe('<p data-penline-id="p1"><span data-penline-leaf="">a\n<br data-penline-break=""></span></p>')
    // Inside its marks, like the text.
    ctx.renderer.render(doc(p('p1', txt('b\n', 'bold'))))
    expect(ctx.root.innerHTML).toBe(
      '<p data-penline-id="p1"><span data-penline-leaf=""><strong>b\n<br data-penline-break=""></strong></span></p>',
    )
  })

  it('adds no trailing break to a text ending with a newline that is not last, nor to one ending elsewhere', () => {
    ctx.renderer.render(doc(p('p1', txt('a\n'), txt('b', 'bold')), p('p2', 'a\nb')))
    expect(ctx.root.innerHTML).toBe(
      '<p data-penline-id="p1"><span data-penline-leaf="">a\n</span><span data-penline-leaf=""><strong>b</strong></span></p>' +
        '<p data-penline-id="p2"><span data-penline-leaf="">a\nb</span></p>',
    )
  })

  it('adds or drops the trailing break of an unchanged text as the texts after it go and come', () => {
    ctx.renderer.render(doc(p('p1', txt('a\n'), txt('b', 'bold'))))
    const leaf = ctx.renderer.leafAt([0, 0])!
    ctx.renderer.render(doc(p('p1', txt('a\n'))))
    expect(ctx.renderer.leafAt([0, 0])).toBe(leaf)
    expect(leaf.innerHTML).toBe('a\n<br data-penline-break="">')
    ctx.renderer.render(doc(p('p1', txt('a\n'), txt('c', 'bold'))))
    expect(leaf.innerHTML).toBe('a\n')
  })

  it('keeps a leaf with a trailing break intact across renders and restores a removed break', () => {
    ctx.renderer.render(doc(p('p1', 'a\n')))
    const leaf = ctx.renderer.leafAt([0, 0])!
    const text = leaf.firstChild
    ctx.renderer.render(doc(p('p1', 'a\n')))
    expect(leaf.firstChild).toBe(text)
    leaf.querySelector('br')!.remove()
    ctx.renderer.render(doc(p('p1', 'a\n')))
    expect(leaf.innerHTML).toBe('a\n<br data-penline-break="">')
  })

  it('nests marks by rank (lowest outermost) regardless of model order, ignoring unknown marks', () => {
    ctx.renderer.render(
      doc(p('p1', txt('x', { type: 'color', data: { value: 'red' } }, 'italic', 'nope', 'bold'))),
    )
    const leaf = ctx.root.querySelector('[data-penline-leaf]')!
    expect(leaf.innerHTML).toBe(
      '<strong><em><span data-c="1" style="background-color: red;">x</span></em></strong>',
    )
  })

  it('renders renderHTML specs with options, attrs and the content hole', () => {
    ctx.renderer.render(doc(node('h', 'heading', { level: 2 }, txt('T'))))
    expect(ctx.root.innerHTML).toBe('<h2 class="x" data-penline-id="h"><span data-penline-leaf="">T</span></h2>')
  })

  it('places children at a nested hole', () => {
    ctx.renderer.render(doc(node('c', 'callout', {}, p('p1', 'a'))))
    expect(ctx.root.innerHTML).toBe(
      '<aside data-penline-id="c"><span contenteditable="false">Note:</span><div><p data-penline-id="p1"><span data-penline-leaf="">a</span></p></div><footer>end</footer></aside>',
    )
  })

  it('appends children to the root when the spec has no hole', () => {
    ctx.renderer.render(doc(node('s', 'noHole', {}, txt('a'))))
    expect(ctx.root.innerHTML).toBe('<section a="1" data-penline-id="s"><span data-penline-leaf="">a</span></section>')
  })

  it('wraps known elements without renderHTML in a div (block) or span (inline)', () => {
    ctx.renderer.render(doc(node('b', 'bare', {}, txt('a'), node('i', 'bareInline', {}, txt('b')))))
    expect(ctx.root.innerHTML).toBe(
      '<div data-penline-id="b"><span data-penline-leaf="">a</span><span data-penline-id="i"><span data-penline-leaf="">b</span></span></div>',
    )
  })

  it('renders unknown elements as non-editable placeholders without children', () => {
    ctx.renderer.render(doc(node('u', 'mystery', {}, txt('hidden'))))
    expect(ctx.root.innerHTML).toBe('<div data-penline-id="u" data-penline-unknown="mystery" contenteditable="false"></div>')
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
    expect(root.querySelector('[data-penline-leaf]')!.ownerDocument).toBe(other)
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
      '<p data-penline-id="p1"><span data-penline-leaf="">a</span></p><p data-penline-id="p2"><span data-penline-leaf="">bc</span></p>',
    )
  })

  it('updates the Text node of a leaf in place when only its text changes', () => {
    const { renderer, root } = ctx
    renderer.render(doc(p('p1', 'a', txt('b', 'bold'))))
    const [plain, marked] = [...root.querySelectorAll('[data-penline-leaf]')]
    const plainText = plain!.firstChild
    const markedText = marked!.querySelector('strong')!.firstChild
    renderer.render(doc(p('p1', 'ax', txt('by', 'bold'))))
    expect(plain!.firstChild).toBe(plainText)
    expect(marked!.querySelector('strong')!.firstChild).toBe(markedText)
    expect(root.innerHTML).toBe(
      '<p data-penline-id="p1"><span data-penline-leaf="">ax</span><span data-penline-leaf=""><strong>by</strong></span></p>',
    )
  })

  it('still rebuilds a leaf whose marks change', () => {
    const { renderer, root } = ctx
    renderer.render(doc(p('p1', 'a')))
    const leaf = root.querySelector('[data-penline-leaf]')!
    const before = leaf.firstChild
    renderer.render(doc(p('p1', txt('a', 'bold'))))
    expect(leaf.firstChild).not.toBe(before)
    expect(leaf.innerHTML).toBe('<strong>a</strong>')
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
      '<p data-penline-id="p1"><span data-penline-leaf="">a</span></p><p data-penline-id="p4"><span data-penline-leaf="">d</span></p><p data-penline-id="p3"><span data-penline-leaf="">c</span></p>',
    )
    expect(root.children[0]).toBe(p1)
    expect(root.children[2]).toBe(p3)
    expect(ctx.renderer.elementAt([1])).toBe(root.children[1])
  })

  it('moves an element between parents, keeping its DOM', () => {
    const { renderer, root } = ctx
    renderer.render(doc(node('c1', 'callout', {}, p('p1', 'a')), node('c2', 'callout', {})))
    const p1 = root.querySelector('[data-penline-id="p1"]')
    renderer.render(doc(node('c1', 'callout', {}), node('c2', 'callout', {}, p('p1', 'a'))))
    expect(root.querySelector('[data-penline-id="c2"] [data-penline-id="p1"]')).toBe(p1)
    expect(root.querySelectorAll('[data-penline-id="p1"]').length).toBe(1)
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
    expect(root.innerHTML).toBe('<h3 class="x" data-penline-id="h"><span data-penline-leaf="">T</span></h3>')
    expect(root.firstElementChild).not.toBe(h1)
    expect(root.firstElementChild!.firstElementChild).toBe(leaf)
    expect(renderer.elementAt([0])).toBe(root.firstElementChild)
  })

  it('re-renders an element root when its type changes', () => {
    const { renderer, root } = ctx
    renderer.render(doc(p('x', 'a')))
    renderer.render(doc(node('x', 'heading', { level: 1 }, txt('a'))))
    expect(root.innerHTML).toBe('<h1 class="x" data-penline-id="x"><span data-penline-leaf="">a</span></h1>')
  })

  it('reconciles leaves positionally: reuses unchanged, updates changed, adds and removes', () => {
    const { renderer, root } = ctx
    renderer.render(doc(p('p1', txt('a'), txt('b', 'bold'), txt('c'))))
    const leaves = [...root.querySelectorAll('[data-penline-leaf]')]
    const textA = leaves[0]!.firstChild
    renderer.render(doc(p('p1', txt('a'), txt('b'))))
    const after = [...root.querySelectorAll('[data-penline-leaf]')]
    expect(after.length).toBe(2)
    expect(after[0]).toBe(leaves[0])
    expect(after[0]!.firstChild).toBe(textA)
    expect(after[1]).toBe(leaves[1])
    expect(root.innerHTML).toBe('<p data-penline-id="p1"><span data-penline-leaf="">a</span><span data-penline-leaf="">b</span></p>')
    renderer.render(doc(p('p1', txt('a'), txt('b'), txt(''))))
    expect(root.innerHTML).toBe(
      '<p data-penline-id="p1"><span data-penline-leaf="">a</span><span data-penline-leaf="">b</span><span data-penline-leaf=""><br data-penline-break=""></span></p>',
    )
  })

  it('keeps leaves before inline elements in order', () => {
    const { renderer, root } = ctx
    renderer.render(doc(node('b', 'bare', {}, txt('a'), node('i', 'bareInline', {}, txt('b')), txt('c'))))
    renderer.render(doc(node('b', 'bare', {}, txt('a'), txt('c'), node('i', 'bareInline', {}, txt('b')))))
    expect(root.innerHTML).toBe(
      '<div data-penline-id="b"><span data-penline-leaf="">a</span><span data-penline-leaf="">c</span><span data-penline-id="i"><span data-penline-leaf="">b</span></span></div>',
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
    expect(root.querySelectorAll('[data-penline-leaf]').length).toBe(1)
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

  it('never removes skipLeaf when a leaf before it goes away (no skipPath)', () => {
    const { renderer, root } = ctx
    renderer.render(doc(p('p1', txt('a', 'bold'), txt('b'))))
    const [l0, l1] = [renderer.leafAt([0, 0])!, renderer.leafAt([0, 1])!]
    const text = l1.firstChild
    renderer.render(doc(p('p1', txt('ab'))), { skipLeaf: l1 })
    expect(root.contains(l1)).toBe(true)
    expect(l1.firstChild).toBe(text)
    expect(renderer.leafAt([0, 0])).toBe(l0)
  })

  it('pins skipLeaf to skipPath when a leaf before it is removed', () => {
    const { renderer, root } = ctx
    renderer.render(doc(p('p1', txt('a', 'bold'), txt('b'))))
    const l1 = renderer.leafAt([0, 1])!
    const text = l1.firstChild
    renderer.render(doc(p('p1', txt('ab'))), { skipLeaf: l1, skipPath: [0, 0] })
    expect(root.querySelectorAll('[data-penline-leaf]').length).toBe(1)
    expect(root.contains(l1)).toBe(true)
    expect(l1.firstChild).toBe(text)
    expect(renderer.leafAt([0, 0])).toBe(l1)
    expect(renderer.pathOfLeaf(l1)).toEqual([0, 0])
    renderer.render(doc(p('p1', txt('ab'))))
    expect(root.innerHTML).toBe('<p data-penline-id="p1"><span data-penline-leaf="">ab</span></p>')
    expect(renderer.leafAt([0, 0])).toBe(l1)
  })

  it('pins skipLeaf to skipPath when a leaf is inserted before it', () => {
    const { renderer, root } = ctx
    renderer.render(doc(p('p1', txt('b'))))
    const leaf = renderer.leafAt([0, 0])!
    const text = leaf.firstChild
    renderer.render(doc(p('p1', txt('x', 'bold'), txt('b'))), { skipLeaf: leaf, skipPath: [0, 1] })
    expect(root.querySelectorAll('[data-penline-leaf]').length).toBe(2)
    expect(renderer.leafAt([0, 1])).toBe(leaf)
    expect(renderer.pathOfLeaf(leaf)).toEqual([0, 1])
    expect(leaf.firstChild).toBe(text)
    expect(root.innerHTML).toBe(
      '<p data-penline-id="p1"><span data-penline-leaf=""><strong>x</strong></span><span data-penline-leaf="">b</span></p>',
    )
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

describe('Renderer: foreign DOM cleanup', () => {
  it('clears pre-existing root content on the first render', () => {
    const { editor } = ctx
    const root = document.createElement('div')
    root.innerHTML = 'junk<b>old</b><p data-penline-id="p1">stale</p>'
    new Renderer(root, editor).render(doc(p('p1', 'a')))
    expect(root.innerHTML).toBe('<p data-penline-id="p1"><span data-penline-leaf="">a</span></p>')
  })

  it('removes stray nodes the browser put into a hole or the root', () => {
    const { renderer, root } = ctx
    renderer.render(doc(p('p1', txt('a'), txt('b', 'bold'))))
    const p1 = root.firstElementChild!
    p1.insertBefore(document.createTextNode('stray'), p1.children[1]!)
    p1.appendChild(document.createElement('br'))
    root.appendChild(document.createTextNode('loose'))
    renderer.render(doc(p('p1', txt('a'), txt('b', 'bold'))))
    expect(root.innerHTML).toBe(
      '<p data-penline-id="p1"><span data-penline-leaf="">a</span><span data-penline-leaf=""><strong>b</strong></span></p>',
    )
    expect(root.firstElementChild).toBe(p1)
  })

  it('corrects a non-skipped leaf whose DOM was changed', () => {
    const { renderer, root } = ctx
    renderer.render(doc(p('p1', txt('a'), txt('b', 'bold'))))
    const [l0, l1] = [renderer.leafAt([0, 0])!, renderer.leafAt([0, 1])!]
    l0.appendChild(document.createTextNode('x'))
    ;(l1.firstChild!.firstChild as Text).data = 'zz'
    renderer.render(doc(p('p1', txt('a'), txt('b', 'bold'))))
    expect(root.innerHTML).toBe(
      '<p data-penline-id="p1"><span data-penline-leaf="">a</span><span data-penline-leaf=""><strong>b</strong></span></p>',
    )
    expect(renderer.leafAt([0, 0])).toBe(l0)
  })

  it('does not correct skipLeaf', () => {
    const { renderer } = ctx
    renderer.render(doc(p('p1', txt('a'))))
    const leaf = renderer.leafAt([0, 0])!
    leaf.appendChild(document.createTextNode('x'))
    renderer.render(doc(p('p1', txt('a'))), { skipLeaf: leaf })
    expect(leaf.innerHTML).toBe('ax')
  })

  it('preserves static spec siblings around the hole while sweeping it', () => {
    const { renderer, root } = ctx
    renderer.render(doc(node('c', 'callout', {}, p('p1', 'a')), node('s', 'noHole', {}, txt('b'))))
    const inner = root.querySelector('aside > div')!
    inner.appendChild(document.createTextNode('stray'))
    root.querySelector('section')!.appendChild(document.createTextNode('stray'))
    renderer.render(doc(node('c', 'callout', {}, p('p1', 'a'), p('p2', 'b')), node('s', 'noHole', {}, txt('b'))))
    expect(root.innerHTML).toBe(
      '<aside data-penline-id="c"><span contenteditable="false">Note:</span><div><p data-penline-id="p1"><span data-penline-leaf="">a</span></p><p data-penline-id="p2"><span data-penline-leaf="">b</span></p></div><footer>end</footer></aside>' +
        '<section a="1" data-penline-id="s"><span data-penline-leaf="">b</span></section>',
    )
  })

  it('keeps static siblings when the hole shares its parent with them', () => {
    const editor = createTestEditor({
      plugins: [
        testParagraph,
        definePlugin({
          name: 'fig',
          node: { kind: 'block' },
          renderHTML: () => ['figure', ['b', 'pre'], 0, ['i', 'post']],
        }),
      ],
    })
    const root = document.createElement('div')
    const r = new Renderer(root, editor)
    r.render(doc(node('f', 'fig', {}, p('p1', 'a'))))
    const fig = root.firstElementChild!
    fig.insertBefore(document.createTextNode('stray'), fig.lastChild)
    r.render(doc(node('f', 'fig', {}, p('p2', 'z'), p('p1', 'a'))))
    expect(root.innerHTML).toBe(
      '<figure data-penline-id="f"><b>pre</b><p data-penline-id="p2"><span data-penline-leaf="">z</span></p><p data-penline-id="p1"><span data-penline-leaf="">a</span></p><i>post</i></figure>',
    )
    expect(r.elementAt([0, 1])).toBe(root.querySelector('[data-penline-id="p1"]'))
  })

  it('re-renders an element shell whose hole boundary nodes were removed, keeping child DOM', () => {
    const { renderer, root } = ctx
    renderer.render(doc(node('c', 'callout', {}, p('p1', 'a'))))
    const p1 = root.querySelector('[data-penline-id="p1"]')
    const aside = root.firstElementChild!
    aside.querySelector(':scope > div')!.remove() // the hole itself
    renderer.render(doc(node('c', 'callout', {}, p('p1', 'a'))))
    expect(root.firstElementChild).not.toBe(aside)
    expect(root.querySelector('aside > div > [data-penline-id="p1"]')).toBe(p1)
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
    expect(renderer.elementAt([1, 0])).toBe(root.querySelector('[data-penline-id="p2"]'))
    expect(renderer.elementAt([1])).toBe(root.querySelector('[data-penline-id="c"]'))
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
    expect(renderer.elementAt([0])!.getAttribute('data-penline-unknown')).toBe('mystery')
  })
})

describe('Renderer: invalidate', () => {
  it('rebuilds shells of the given type on the next render, keeping children DOM', () => {
    const d = doc(node('h', 'heading', { level: 2 }, txt('T')), p('p1', 'a'))
    ctx.renderer.render(d)
    const h = ctx.root.querySelector('h2')!
    const leaf = h.firstChild
    const para = ctx.root.querySelector('p')
    ctx.renderer.invalidate('heading')
    ctx.renderer.render(d)
    const h2 = ctx.root.querySelector('h2')!
    expect(h2).not.toBe(h)
    expect(h2.firstChild).toBe(leaf)
    expect(ctx.root.querySelector('p')).toBe(para)
    ctx.renderer.render(d)
    expect(ctx.root.querySelector('h2')).toBe(h2)
  })
})

describe('Renderer: mark invalidation', () => {
  it('re-renders leaves carrying the invalidated mark only', () => {
    const tag = definePlugin({
      name: 'tagged',
      options: { cls: 'one' },
      mark: { render: (_d, { options }) => ({ tag: 'u', attrs: { class: options.cls } }) },
    })
    const editor = createTestEditor({ plugins: [testParagraph, testBold, tag] })
    const root = document.createElement('div')
    const renderer = new Renderer(root, editor)
    const d = doc(p('p1', txt('a', 'tagged'), txt('b', 'bold')))
    renderer.render(d)
    const leaves = [...root.querySelectorAll('[data-penline-leaf]')]
    expect(leaves[0]!.innerHTML).toBe('<u class="one">a</u>')
    editor.setPluginOptions('tagged', { cls: 'two' })
    renderer.render(d)
    expect(root.querySelectorAll('[data-penline-leaf]')[0]!.innerHTML).toBe('<u class="one">a</u>')
    renderer.invalidateMark('tagged')
    renderer.render(d)
    const after = [...root.querySelectorAll('[data-penline-leaf]')]
    expect(after[0]!.innerHTML).toBe('<u class="two">a</u>')
    expect(after[1]).toBe(leaves[1])
  })
})
