// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { definePlugin, type NodeViewFactory } from '../../src/index'
import { createTestEditor, doc, el, sel, txt } from '../../src/testing/index'
import { testParagraph } from '../fixtures'

const image = definePlugin({ name: 'image', node: { kind: 'block', atom: true } })

/** A node view with a `data-editor-ignore` button. */
const imageView: NodeViewFactory = (container) => {
  const button = document.createElement('button')
  button.setAttribute('data-editor-ignore', '')
  button.textContent = 'edit'
  container.append(button)
  return { update: () => {}, destroy: () => {} }
}

function setup() {
  const editor = createTestEditor({
    plugins: [testParagraph, image],
    doc: doc(el('paragraph', txt('ab')), el('image', { src: 'a.png' })),
    selection: sel([0, 0], 2),
    nodeViews: { image: imageView },
  })
  const root = document.createElement('div')
  document.body.appendChild(root)
  editor.mount(root)
  editor.view!.focus()
  return { editor, root, view: editor.view! }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const beforeInput = (target: EventTarget, data: string): InputEvent => {
  const e = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data })
  target.dispatchEvent(e)
  return e
}

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

describe('data-editor-ignore is scoped to node views', () => {
  it('is honoured inside a node view: its events are left alone', () => {
    const { editor, root } = setup()
    const button = root.querySelector('button[data-editor-ignore]')!
    const e = beforeInput(button, 'x')
    expect(e.defaultPrevented).toBe(false)
    expect(editor.getJSON().children[0]).toMatchObject({ children: [{ text: 'ab' }] })
  })

  it('outside a node view it does not make events ignored', () => {
    const { editor, root, view } = setup()
    const block = root.querySelector('p')!
    block.setAttribute('data-editor-ignore', '')
    const e = beforeInput(view.renderer.leafAt([0, 0])!, 'x')
    expect(e.defaultPrevented).toBe(true)
    expect(editor.getJSON().children[0]).toMatchObject({ children: [{ text: 'abx' }] })
  })

  it('outside a node view it does not make mutations ignored', async () => {
    const { root, view } = setup()
    root.querySelector('p')!.setAttribute('data-editor-ignore', '')
    await flush()
    view.renderer.leafAt([0, 0])!.textContent = 'zzz'
    await flush()
    expect(root.querySelector('p')!.textContent).toBe('ab')
  })
})
