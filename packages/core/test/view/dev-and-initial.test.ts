// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { definePlugin } from '../../src/plugin/define'
import { nodeSelection, type NodeViewFactory } from '../../src/index'
import type { ElementNode, Node } from '../../src/model/types'
import { createTestEditor, doc, el, txt } from '../../src/testing/index'
import { testParagraph } from '../fixtures'

const image = definePlugin({ name: 'image', node: { kind: 'block', atom: true } })
const box = definePlugin({ name: 'box', node: { kind: 'block', content: 'inline' } })
const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('the initial render (5.6)', () => {
  it('marks the node of an initial node selection as selected', () => {
    const content = doc(p('a'), el('image', {}), p('b'))
    const editor = createTestEditor({ plugins: [testParagraph, image], doc: content })
    const tr = editor.createTransaction()
    tr.setSelection(nodeSelection(tr.doc, editor.registry, [1]))
    editor.dispatch(tr)
    const root = document.createElement('div')
    document.body.appendChild(root)
    editor.mount(root)
    // createTestEditor gives the content fresh ids: read the image's from the state.
    const id = (editor.state.doc.children[1] as ElementNode).id
    const img = root.querySelector(`[data-penline-id="${id}"]`)!
    expect(img.hasAttribute('data-penline-selected')).toBe(true)
  })
})

describe('editor.dev', () => {
  it('is the dev option, read-only', () => {
    expect(createTestEditor({ plugins: [testParagraph], dev: true }).dev).toBe(true)
    expect(createTestEditor({ plugins: [testParagraph], dev: false }).dev).toBe(false)
  })
})

describe('the contentDOM placement warning is dev-only (5.12)', () => {
  /** Places its contentDOM inside a contenteditable="false" wrapper: a misuse the warning reports. */
  const badView: NodeViewFactory = (container, props) => {
    const wrapper = document.createElement('div')
    wrapper.setAttribute('contenteditable', 'false')
    wrapper.append(props.contentDOM!)
    container.append(wrapper)
    return { update: () => {}, destroy: () => {} }
  }

  for (const dev of [true, false]) {
    it(`${dev ? 'warns' : 'stays silent'} with dev: ${dev}`, () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const editor = createTestEditor({
        plugins: [testParagraph, box],
        doc: doc(el('box', {}, txt('x'))),
        nodeViews: { box: badView },
        dev,
      })
      const root = document.createElement('div')
      document.body.appendChild(root)
      editor.mount(root)
      editor.view!.update(editor.state)
      const placement = warn.mock.calls.filter((c) => String(c[0]).includes('contenteditable="false"'))
      expect(placement.length > 0).toBe(dev)
    })
  }
})
