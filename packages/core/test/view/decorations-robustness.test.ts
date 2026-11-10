// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { single } from '../../src/model/selection'
import type { ElementNode, Node, Point } from '../../src/model/types'
import { Renderer, type Decoration } from '../../src/index'
import { createTestEditor, doc, txt } from '../../src/testing/index'
import { testParagraph } from '../fixtures'
import { definePlugin } from '../../src/plugin/define'
import { groupDecorations } from '../../src/view/decorations'

const p = (id: string, ...children: Node[]): ElementNode => ({ id, type: 'paragraph', data: {}, children })
const pt = (path: number[], offset: number): Point => ({ path, offset })
const inline = (from: Point, to: Point, attrs: Record<string, string>): Decoration => ({ type: 'inline', from, to, attrs })

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('a throwing decorations hook', () => {
  let failing = true
  const boom = definePlugin({
    name: 'boom',
    decorations: () => {
      if (failing) throw new Error('deco boom')
      return []
    },
  })
  const good = definePlugin({
    name: 'good',
    decorations: () => [inline(pt([0, 0], 0), pt([0, 0], 1), { class: 'g' })],
  })

  it('is reported and skipped on mount and update; the other plugins still decorate', () => {
    failing = true
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const editor = createTestEditor({
      plugins: [testParagraph, boom, good],
      doc: doc(p('p1', txt('ab'))),
      selection: single({ anchor: pt([0, 0], 0), focus: pt([0, 0], 0) }),
    })
    const root = document.createElement('div')
    document.body.appendChild(root)
    expect(() => editor.mount(root)).not.toThrow()
    expect(root.querySelector('[data-penline-deco]')!.className).toBe('g')
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0]![0])).toContain('boom')
    expect(() => editor.view!.update(editor.state)).not.toThrow()
    expect(error).toHaveBeenCalledTimes(2)
    expect(root.querySelector('[data-penline-deco]')!.className).toBe('g')
    failing = false
  })
})

function setup() {
  const editor = createTestEditor({ plugins: [testParagraph] })
  const root = document.createElement('div')
  return { root, renderer: new Renderer(root, editor) }
}

describe('decoration attribute names', () => {
  it('drops a decoration with an invalid attribute name in groupDecorations, with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = doc(p('p1', txt('ab')))
    const out = groupDecorations(d, [inline(pt([0, 0], 0), pt([0, 0], 1), { 'on click': 'x' }), inline(pt([0, 0], 1), pt([0, 0], 2), { class: 'ok' })])
    expect(out.get('0,0')!.inline).toEqual([{ from: 1, to: 2, attrs: { class: 'ok' } }])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('on click')
  })

  it('renders without the bad decoration instead of throwing mid-render', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { renderer, root } = setup()
    expect(() =>
      renderer.render(doc(p('p1', txt('ab')), p('p2', txt('c'))), {
        decorations: [inline(pt([0, 0], 0), pt([0, 0], 1), { 'bad name': 'x' }), inline(pt([1, 0], 0), pt([1, 0], 1), { class: 'ok' })],
      }),
    ).not.toThrow()
    expect(root.innerHTML).toBe(
      '<p data-penline-id="p1"><span data-penline-leaf="">ab</span></p>' +
        '<p data-penline-id="p2"><span data-penline-leaf=""><span data-penline-deco="" class="ok">c</span></span></p>',
    )
  })
})

describe('duplicate widget keys', () => {
  it('keep an unchanged leaf (and its duplicate widget) across renders', () => {
    const { renderer, root } = setup()
    const render = vi.fn((d: Document) => d.createElement('i'))
    const decos: Decoration[] = [
      { type: 'widget', at: pt([0, 0], 0), key: 'k', render },
      { type: 'widget', at: pt([0, 0], 1), key: 'k', render },
    ]
    const d = doc(p('p1', txt('ab')))
    renderer.render(d, { decorations: decos })
    const leaf = renderer.leafAt([0, 0])!
    const nodes = [...leaf.childNodes]
    expect(nodes.length).toBe(4)
    expect(render).toHaveBeenCalledTimes(2)
    renderer.render(d, { decorations: decos })
    renderer.render(d, { decorations: decos })
    expect(render).toHaveBeenCalledTimes(2)
    expect([...leaf.childNodes]).toEqual(nodes)
    expect(root.querySelectorAll('i').length).toBe(2)
  })

  it('keep unchanged leaves when the same key is decorated in two texts', () => {
    const { renderer } = setup()
    const render = vi.fn((d: Document) => d.createElement('i'))
    const decos: Decoration[] = [
      { type: 'widget', at: pt([0, 0], 0), key: 'k', render },
      { type: 'widget', at: pt([1, 0], 0), key: 'k', render },
    ]
    const d = doc(p('p1', txt('a')), p('p2', txt('b')))
    renderer.render(d, { decorations: decos })
    const second = [...renderer.leafAt([1, 0])!.childNodes]
    renderer.render(d, { decorations: decos })
    expect(render).toHaveBeenCalledTimes(2)
    expect([...renderer.leafAt([1, 0])!.childNodes]).toEqual(second)
  })
})

describe('leafIntact and decoration attributes', () => {
  it('repairs a decoration span whose attributes were changed outside the renderer', () => {
    const { renderer, root } = setup()
    const decos = [inline(pt([0, 0], 0), pt([0, 0], 1), { class: 'hl', 'data-x': '1' })]
    const d = doc(p('p1', txt('ab')))
    renderer.render(d, { decorations: decos })
    const span = root.querySelector('[data-penline-deco]')!
    span.setAttribute('class', 'other')
    span.removeAttribute('data-x')
    span.setAttribute('style', 'color: red')
    renderer.render(d, { decorations: decos })
    const fixed = root.querySelector('[data-penline-deco]')!
    expect(fixed.getAttribute('class')).toBe('hl')
    expect(fixed.getAttribute('data-x')).toBe('1')
    expect(fixed.hasAttribute('style')).toBe(false)
  })
})
