// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { definePlugin } from '../src/plugin/define'
import { Registry } from '../src/plugin/registry'
import type { Doc, ElementNode, Node } from '../src/model/types'
import type { DOMOutputSpec, MarkDOM } from '../src/plugin/types'
import { Editor, parseHTML, serializeHTML } from '../src/index'
import { corePlugin } from '../src/core-plugin'
import { createTestEditor, doc, el, stripIds, txt } from '../src/testing/index'
import { testBold, testParagraph } from './fixtures'

const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))

const italic = definePlugin({
  name: 'italic',
  mark: { render: () => ({ tag: 'em' }) },
  parseHTML: [{ tag: 'em' }, { tag: 'i' }, { style: 'font-style', getData: (_el, v) => (v === 'italic' ? {} : false) }],
})
const color = definePlugin({
  name: 'color',
  mark: { render: (d: { value?: string }) => ({ tag: 'span', style: { backgroundColor: String(d.value) } }) },
  parseHTML: [{ style: 'color', getData: (_el, v) => ({ value: v ?? '' }) }],
})
const boldStyle = testBold.extend({
  parseHTML: [
    { tag: 'strong' },
    { tag: 'b', getData: (el) => (el.style.fontWeight === 'normal' ? false : {}) },
    { style: 'font-weight', getData: (_el, v) => (v === 'bold' || Number(v) >= 600 ? {} : false) },
  ],
})
const heading = definePlugin({
  name: 'heading',
  node: { kind: 'block', content: 'inline' },
  options: { prefix: 'h' },
  parseHTML: [1, 2, 3].map((level) => ({ tag: `h${level}`, getData: () => ({ level }) })),
  renderHTML: (node, { options }) => [`${options.prefix}${String(node.data.level)}`, { class: undefined, 'data-x': 1 }, 0],
})
const link = definePlugin({
  name: 'link',
  node: { kind: 'inline', content: 'text' },
  parseHTML: [{ tag: 'a', getData: (el) => ({ href: el.getAttribute('href') ?? '' }) }],
  renderHTML: (node) => ['a', { href: String(node.data.href) }, 0],
})
const plain = definePlugin({ name: 'plain', node: { kind: 'block', content: 'inline' } })
const widget = definePlugin({ name: 'widget', node: { kind: 'block', atom: true }, renderHTML: () => ['hr'] })
const divRule = definePlugin({
  name: 'callout',
  node: { kind: 'block', content: 'inline' },
  parseHTML: [{ tag: 'div', priority: 60 }],
  renderHTML: () => ['div', { class: 'callout' }, 0],
})

const allPlugins = [testParagraph, boldStyle, italic, color, heading, link, plain, widget]
const reg = new Registry([corePlugin, ...allPlugins])
const opts = (name: string) => reg.plugins.find((pl) => pl.name === name)?.spec.options

const serialize = (d: Doc) => serializeHTML(d, reg, opts)
const parse = (html: string) => stripIds(parseHTML(html, reg))

describe('serializeHTML', () => {
  it('renders elements and marks', () => {
    expect(serialize(doc(p(txt('a'), txt('b', 'bold'))))).toBe('<p>a<strong>b</strong></p>')
  })

  it('escapes text', () => {
    expect(serialize(doc(p(txt('<&>'))))).toBe('<p>&lt;&amp;&gt;</p>')
  })

  it('renders an empty text as an empty element', () => {
    expect(serialize(doc(p(txt(''))))).toBe('<p></p>')
  })

  it('skips unknown nodes', () => {
    expect(serialize(doc(el('mystery', txt('w')), p('x')))).toBe('<p>x</p>')
  })

  it('nests marks with the lowest rank outermost', () => {
    const d = doc(p(txt('a', { type: 'italic', data: {} }, { type: 'bold', data: {} })))
    expect(serialize(d)).toBe('<p><strong><em>a</em></strong></p>')
  })

  it('renders mark styles and escapes attribute values', () => {
    const d = doc(p(txt('a', { type: 'color', data: { value: '"red" & <b>' } })))
    expect(serialize(d)).toBe('<p><span style="background-color: &quot;red&quot; &amp; &lt;b&gt;;">a</span></p>')
  })

  it('drops a mark style declaration with an unterminated string (it would swallow the rest in CSS)', () => {
    const d = doc(p(txt('a', { type: 'color', data: { value: 'red"' } })))
    expect(serialize(d)).toBe('<p><span>a</span></p>')
  })

  it('passes plugin options and handles attrs (undefined skipped, numbers stringified)', () => {
    expect(serialize(doc(el('heading', { level: 2 }, txt('t'))))).toBe('<h2 data-x="1">t</h2>')
    const custom = serializeHTML(doc(el('heading', { level: 2 }, txt('t'))), reg, (n) =>
      n === 'heading' ? { prefix: 'x' } : undefined,
    )
    expect(custom).toBe('<x2 data-x="1">t</x2>')
  })

  it('renders inline elements, atoms and void tags', () => {
    const d = doc(p('a', el('link', { href: 'u?a=1&b=2' }, txt('l')), 'b'), el('widget', {}))
    expect(serialize(d)).toBe('<p>a<a href="u?a=1&amp;b=2">l</a>b</p><hr>')
  })

  it('unwraps elements without renderHTML', () => {
    expect(serialize(doc(el('plain', txt('a', 'bold'))))).toBe('<strong>a</strong>')
  })

  describe('validates tag and attribute names', () => {
    const withRender = (renderHTML: () => DOMOutputSpec) =>
      new Registry([corePlugin, testParagraph.extend({ renderHTML })])
    const ser = (r: Registry) => serializeHTML(doc(p('x')), r, () => undefined)

    it('throws on an invalid renderHTML tag', () => {
      expect(() => ser(withRender(() => ['h1 onmouseover=x', 0]))).toThrow('Invalid HTML tag name "h1 onmouseover=x"')
      expect(() => ser(withRender(() => ['p', 0, ['b><i', 'y']]))).toThrow('Invalid HTML tag name "b><i"')
    })

    it('throws on an invalid renderHTML attribute name', () => {
      expect(() => ser(withRender(() => ['p', { 'onclick x': '1' }, 0]))).toThrow(
        'Invalid HTML attribute name "onclick x"',
      )
      expect(() => ser(withRender(() => ['p', { 'a"b': '1' }, 0]))).toThrow('Invalid HTML attribute name "a"b"')
    })

    it('throws on an invalid mark tag or attribute name', () => {
      const markReg = (render: () => MarkDOM) =>
        new Registry([corePlugin, testParagraph, definePlugin({ name: 'm', mark: { render } })])
      const d = doc(p(txt('a', 'm')))
      expect(() => serializeHTML(d, markReg(() => ({ tag: 'span x' })), () => undefined)).toThrow(
        'Invalid HTML tag name "span x"',
      )
      expect(() =>
        serializeHTML(d, markReg(() => ({ tag: 'span', attrs: { 'x y': '1' } })), () => undefined),
      ).toThrow('Invalid HTML attribute name "x y"')
    })

    it('accepts valid names', () => {
      const r = withRender(() => ['p', { 'data-id': 'i', 'aria-label': 'l', 'xlink:href': 'h' }, ['svg:g', 0]])
      expect(ser(r)).toBe('<p data-id="i" aria-label="l" xlink:href="h"><svg:g>x</svg:g></p>')
    })
  })

  it('does not need a DOM', () => {
    vi.stubGlobal('document', undefined)
    vi.stubGlobal('DOMParser', undefined)
    try {
      expect(serialize(doc(p('x')))).toBe('<p>x</p>')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('parseHTML', () => {
  it('parses blocks and marks', () => {
    expect(parse('<p>a<b>b</b></p>')).toEqual(stripIds([p(txt('a'), txt('b', 'bold'))]))
  })

  it('turns unknown block tags into default blocks', () => {
    expect(parse('<div>x</div>')).toEqual(stripIds([p('x')]))
    expect(parse('<h4>x</h4><blockquote>y</blockquote>')).toEqual(stripIds([p('x'), p('y')]))
  })

  it('wraps bare text into a default block', () => {
    expect(parse('hello')).toEqual(stripIds([p('hello')]))
  })

  it('unwraps unknown block tags that contain blocks', () => {
    expect(parse('<section><p>a</p><p>b</p></section>')).toEqual(stripIds([p('a'), p('b')]))
    expect(parse('<div>a<p>b</p>c</div>')).toEqual(stripIds([p('a'), p('b'), p('c')]))
  })

  it('drops whitespace between blocks', () => {
    expect(parse('<p>a</p>\n   <p>b</p>')).toEqual(stripIds([p('a'), p('b')]))
  })

  it('collapses whitespace runs', () => {
    expect(parse('<p>a   b</p>')).toEqual(stripIds([p('a b')]))
    expect(parse('<p>a <b> b</b></p>')).toEqual(stripIds([p(txt('a '), txt('b', 'bold'))]))
  })

  it('unwraps unknown inline tags, keeping marks', () => {
    expect(parse('<p><span>a<b><u>b</u></b></span></p>')).toEqual(stripIds([p(txt('a'), txt('b', 'bold'))]))
  })

  it('matches style rules and lets getData reject', () => {
    expect(parse('<p><span style="font-weight: 700; font-style: italic">a</span></p>')).toEqual(
      stripIds([p(txt('a', 'bold', 'italic'))]),
    )
    expect(parse('<p><b style="font-weight: normal">a</b></p>')).toEqual(stripIds([p('a')]))
    expect(parse('<p><span style="color: red">a</span></p>')).toEqual(
      stripIds([p(txt('a', { type: 'color', data: { value: 'red' } }))]),
    )
  })

  it('parses element data, inline elements and nesting', () => {
    expect(parse('<h2>t</h2><p>a<a href="u">l</a></p>')).toEqual(
      stripIds([el('heading', { level: 2 }, txt('t')), p('a', el('link', { href: 'u' }, txt('l')))]),
    )
  })

  it('tries element rules by priority', () => {
    const r = new Registry([corePlugin, testParagraph, divRule])
    expect(stripIds(parseHTML('<div>x</div>', r))).toEqual(stripIds([el('callout', txt('x'))]))
  })

  it('splits blocks at <br>', () => {
    expect(parse('<p>a<br>b</p>')).toEqual(stripIds([p('a'), p('b')]))
    expect(parse('<p>a<br><br>b<br></p>')).toEqual(stripIds([p('a'), p(''), p('b')]))
  })

  it('ignores comments and scripts', () => {
    expect(parse('<p>a<!-- c --><script>x()</script></p>')).toEqual(stripIds([p('a')]))
  })

  it('skips embedded content and form controls', () => {
    const html =
      '<p>a<iframe>f</iframe><object>o</object><embed><svg><text>s</text></svg>' +
      '<select><option>x</option></select><textarea>t</textarea><button>b</button>c</p>'
    expect(parse(html)).toEqual(stripIds([p('ac')]))
  })

  it('gives each element an id', () => {
    const [block] = parseHTML('<p>a</p>', reg) as ElementNode[]
    expect(typeof block!.id).toBe('string')
  })

  it('round-trips', () => {
    const html = '<h2 data-x="1">t</h2><p>a<strong>b<em>c</em></strong><a href="u">l</a></p>'
    const parsed = parseHTML(html, reg) as ElementNode[]
    expect(serialize({ type: 'doc', children: parsed })).toBe(html)
  })

  it('requires DOMParser', () => {
    vi.stubGlobal('DOMParser', undefined)
    try {
      expect(() => parseHTML('<p>a</p>', reg)).toThrow('parseHTML requires a DOM (DOMParser)')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('Editor HTML', () => {
  it('setContent(html) and getHTML', () => {
    const ed = createTestEditor({ plugins: [testParagraph, testBold] })
    ed.setContent('<p>x</p>')
    expect(ed.getHTML()).toBe('<p>x</p>')
  })

  it('loads string content through coerceDoc and normalize', () => {
    const ed = new Editor({ plugins: [testParagraph, testBold], content: '<p>a <b>b</b></p><p></p>' })
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p(txt('a '), txt('b', 'bold')), p(''))))
    expect(ed.getHTML()).toBe('<p>a <strong>b</strong></p><p></p>')
  })

  it('loads empty HTML as one empty block', () => {
    const ed = new Editor({ plugins: [testParagraph], content: '' })
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p(''))))
  })

  it('getHTML uses live plugin options', () => {
    const ed = createTestEditor({ plugins: [testParagraph, heading], doc: doc(el('heading', { level: 1 }, txt('t'))) })
    ed.setPluginOptions('heading', { prefix: 'x' })
    expect(ed.getHTML()).toBe('<x1 data-x="1">t</x1>')
  })
})

describe('HTML edge cases (Batch 4)', () => {
  it('collapses whitespace across the texts inside an inline element (4.7)', () => {
    expect(parse('<p>x<a href="u"> b <i> c</i></a></p>')).toEqual(
      stripIds([p('x', el('link', { href: 'u' }, txt(' b '), txt('c', 'italic')))]),
    )
  })

  it('treats a whitespace-only block like an empty one (4.9)', () => {
    expect(parse('<div> </div>')).toEqual(parse('<div></div>'))
    expect(parse('<div> </div>')).toEqual(stripIds([p('')]))
  })

  it('keeps the whitespace of <pre> content, edges included (4.9)', () => {
    expect(parse('<pre>  a\n  b  </pre>')).toEqual(stripIds([p('  a\n  b  ')]))
  })

  it('applies mark styles on elements a node rule matches (4.8)', () => {
    expect(parse('<p style="font-weight: bold">a</p>')).toEqual(stripIds([p(txt('a', 'bold'))]))
    expect(parse('<p>x<a href="u" style="font-style: italic">b</a></p>')).toEqual(
      stripIds([p('x', el('link', { href: 'u' }, txt('b', 'italic')))]),
    )
  })

  it('parses very deep nesting without overflowing the stack (4.10)', () => {
    const depth = 20_000
    const html = `<p>${'<span>'.repeat(depth)}deep${'</span>'.repeat(depth)}</p>`
    expect(parse(html)).toEqual(stripIds([p('deep')]))
  })

  it('serializes only the first content hole, like the renderer (4.11)', () => {
    const twice = definePlugin({
      name: 'twice',
      node: { kind: 'block', content: 'inline' },
      renderHTML: () => ['div', 0, ['span', 0]],
    })
    const r = new Registry([corePlugin, testParagraph, twice])
    expect(serializeHTML(doc(el('twice', {}, txt('a'))), r, () => undefined)).toBe('<div>a<span></span></div>')
  })

  it('rejects a content hole inside a void tag, in the serializer and the renderer (4.9)', () => {
    const voidHole = definePlugin({
      name: 'voidHole',
      node: { kind: 'block', content: 'inline' },
      renderHTML: () => ['img', 0],
    })
    const r = new Registry([corePlugin, testParagraph, voidHole])
    expect(() => serializeHTML(doc(el('voidHole', {}, txt('a'))), r, () => undefined)).toThrow(/void tag "img"/)
    const ed = createTestEditor({ plugins: [testParagraph, voidHole], doc: doc(el('voidHole', {}, txt('a'))) })
    const root = document.createElement('div')
    expect(() => ed.mount(root)).toThrow(/void tag "img"/)
  })
})
