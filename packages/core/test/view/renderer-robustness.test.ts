// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { definePlugin } from '../../src/plugin/define'
import type { ElementNode, Node } from '../../src/model/types'
import { Renderer, type NodeViewFactory } from '../../src/index'
import { createTestEditor, doc, txt } from '../../src/testing/index'
import { testParagraph } from '../fixtures'

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

let throwing = false
const flaky = definePlugin({
  name: 'flaky',
  node: { kind: 'block' },
  renderHTML: () => {
    if (throwing) throw new Error('boom')
    return ['section', 0]
  },
})
const heading = definePlugin({
  name: 'heading',
  node: { kind: 'block', content: 'inline' },
  options: { prefix: 'h' },
  renderHTML: (n, { options }) => [`${options.prefix}${String(n.data.level)}`, 0],
})
const framed = definePlugin({
  name: 'framed',
  node: { kind: 'block', content: 'inline' },
  renderHTML: () => ['div', ['span', { contenteditable: 'false' }, 'A'], 0, ['span', { contenteditable: 'false' }, 'Z']],
})
const image = definePlugin({ name: 'image', node: { kind: 'block', atom: true } })

function recordingView() {
  const created: HTMLElement[] = []
  let destroyed = 0
  const factory: NodeViewFactory = (container) => {
    created.push(container)
    container.textContent = 'view'
    return { update: () => {}, destroy: () => void destroyed++ }
  }
  return { factory, created, destroyed: () => destroyed }
}

function setup(nodeViews: Record<string, NodeViewFactory> = {}) {
  const editor = createTestEditor({ plugins: [testParagraph, flaky, heading, framed, image], nodeViews })
  const root = document.createElement('div')
  return { editor, root, renderer: new Renderer(root, editor) }
}

afterEach(() => {
  throwing = false
})

describe('Renderer: a render that throws', () => {
  it('keeps pending shell invalidations for the next render', () => {
    const { renderer, root } = setup()
    const d = (v: number) => doc(node('f', 'flaky', { v }, txt('x')), node('h', 'heading', { level: 1 }, txt('T')))
    renderer.render(d(1))
    const h = root.querySelector('h1')!
    renderer.invalidate('heading')
    throwing = true
    expect(() => renderer.render(d(2))).toThrow('boom')
    throwing = false
    renderer.render(d(2))
    expect(root.querySelector('h1')).not.toBe(h)
    expect(root.querySelectorAll('[data-hte-id="h"]').length).toBe(1)
  })

  it('shows the node view rebuilt by the failed render, or a newer one, never a destroyed one', () => {
    const view = recordingView()
    const { renderer, root } = setup({ image: view.factory })
    const d = (v: number) => doc(node('i', 'image', {}), node('f', 'flaky', { v }, txt('x')))
    renderer.render(d(1))
    renderer.invalidateNodeView('i')
    throwing = true
    expect(() => renderer.render(d(2))).toThrow('boom')
    throwing = false
    renderer.render(d(2))
    expect(root.children[0]).toBe(view.created.at(-1))
    expect(view.destroyed()).toBe(view.created.length - 1)
    expect(renderer.elementAt([0])).toBe(view.created.at(-1))
    expect(root.querySelectorAll('[data-hte-id="i"]').length).toBe(1)
  })

  it('keeps element lookups consistent with the DOM after recovering', () => {
    const { renderer, root } = setup()
    const d = (level: number, v: number) =>
      doc(node('h', 'heading', { level }, txt('T')), node('f', 'flaky', { v }, txt('x')))
    renderer.render(d(1, 1))
    throwing = true
    expect(() => renderer.render(d(2, 2))).toThrow('boom')
    throwing = false
    renderer.render(d(2, 2))
    const h2 = root.querySelector('h2')!
    expect(root.querySelector('h1')).toBeNull()
    expect(renderer.elementAt([0])).toBe(h2)
    expect(renderer.leafAt([0, 0])!.parentNode).toBe(h2)
    expect(renderer.nodeOfElement(h2)!.data).toEqual({ level: 2 })
  })
})

describe('Renderer: skipLeaf', () => {
  it('puts back a skipLeaf found outside its hole window (before the static `before` node)', () => {
    const { renderer, root } = setup()
    const d = doc(node('fr', 'framed', {}, txt('x')))
    renderer.render(d)
    const leaf = renderer.leafAt([0, 0])!
    const frame = root.firstElementChild!
    frame.insertBefore(leaf, frame.firstChild)
    renderer.render(d, { skipLeaf: leaf, skipPath: [0, 0] })
    expect(root.innerHTML).toBe(
      '<div data-hte-id="fr"><span contenteditable="false">A</span><span data-hte-leaf="">x</span><span contenteditable="false">Z</span></div>',
    )
    expect(renderer.leafAt([0, 0])).toBe(leaf)
  })

  it('does not move the element holding skipLeaf when its siblings are reordered', () => {
    const { renderer, root } = setup()
    renderer.render(doc(p('p1', 'a'), p('p2', 'b')))
    const leaf = renderer.leafAt([0, 0])!
    const p1 = root.children[0]!
    const insert = vi.spyOn(root, 'insertBefore')
    renderer.render(doc(p('p2', 'b'), p('p1', 'a')), { skipLeaf: leaf, skipPath: [1, 0] })
    expect(insert.mock.calls.some(([moved]) => moved === p1)).toBe(false)
    expect([...root.children].map((c) => c.getAttribute('data-hte-id'))).toEqual(['p2', 'p1'])
    expect(renderer.leafAt([1, 0])).toBe(leaf)
  })

  it('defers rebuilding the shell around skipLeaf to the next render without it', () => {
    const { renderer, root } = setup()
    renderer.render(doc(node('h', 'heading', { level: 1 }, txt('T'))))
    const leaf = renderer.leafAt([0, 0])!
    const h1 = root.firstElementChild!
    renderer.render(doc(node('h', 'heading', { level: 2 }, txt('T'))), { skipLeaf: leaf, skipPath: [0, 0] })
    expect(root.firstElementChild).toBe(h1)
    expect(leaf.parentNode).toBe(h1)
    expect(renderer.leafAt([0, 0])).toBe(leaf)
    renderer.render(doc(node('h', 'heading', { level: 2 }, txt('T'))))
    const h2 = root.firstElementChild!
    expect(h2.tagName).toBe('H2')
    expect(leaf.parentNode).toBe(h2)
    expect(root.querySelectorAll('[data-hte-id="h"]').length).toBe(1)
  })
})
