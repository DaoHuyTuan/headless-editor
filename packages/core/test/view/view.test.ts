// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mainRange, single } from '../../src/model/selection'
import type { ElementNode, Selection } from '../../src/model/types'
import { EditorView, Renderer, modelToDom } from '../../src/index'
import { definePlugin } from '../../src/plugin/define'
import { createTestEditor, doc, txt } from '../../src/testing/index'
import { testBold, testParagraph } from '../fixtures'

const p = (id: string, text: string): ElementNode => ({ id, type: 'paragraph', data: {}, children: [txt(text)] })
const caret = (path: number[], offset: number): Selection => single({ anchor: { path, offset }, focus: { path, offset } })

function setup(text = 'ab', selection: Selection = caret([0, 0], 0)) {
  const editor = createTestEditor({ plugins: [testParagraph, testBold], doc: doc(p('p1', text)), selection })
  const root = document.createElement('div')
  document.body.appendChild(root)
  return { editor, root }
}

type Entry = { target: EventTarget; type: string; fn: unknown }

/** Records add/removeEventListener calls on `targets` and returns the listeners still attached. */
function trackListeners(...targets: EventTarget[]) {
  const live: Entry[] = []
  const spies = targets.flatMap((target) => {
    const add = vi.spyOn(target, 'addEventListener').mockImplementation(function (this: EventTarget, type, fn) {
      live.push({ target, type, fn })
      return EventTarget.prototype.addEventListener.call(this, type, fn)
    })
    const remove = vi.spyOn(target, 'removeEventListener').mockImplementation(function (this: EventTarget, type, fn) {
      const i = live.findIndex((e) => e.target === target && e.type === type && e.fn === fn)
      if (i >= 0) live.splice(i, 1)
      return EventTarget.prototype.removeEventListener.call(this, type, fn)
    })
    return [add, remove]
  })
  return { live, adds: () => spies.filter((_, i) => i % 2 === 0).reduce((n, s) => n + s.mock.calls.length, 0) }
}

afterEach(() => {
  vi.restoreAllMocks()
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

describe('EditorView with an unknown block', () => {
  const widget = (id: string, text: string): ElementNode => ({ id, type: 'widget', data: {}, children: [txt(text)] })

  function setupUnknown(children: ElementNode[]) {
    const editor = createTestEditor({ plugins: [testParagraph, testBold], doc: doc(...children) })
    const root = document.createElement('div')
    document.body.appendChild(root)
    editor.mount(root)
    return { editor, root, view: editor.view! }
  }

  it('starts in the first editable text and focus() does not throw', () => {
    const { editor, view } = setupUnknown([widget('w', 'Title'), p('p1', 'body')])
    expect(editor.state.selection).toEqual(caret([1, 0], 0))
    expect(() => view.focus()).not.toThrow()
  })

  it.each([
    ['first', [widget('w', 'Title'), p('p1', 'body')], caret([1, 0], 0)],
    ['last', [p('p1', 'body'), widget('w', 'Title')], caret([0, 0], 0)],
  ])('Mod-a with the unknown block %s selects only editable text and later listeners still run', (_, children, start) => {
    const { editor, view } = setupUnknown(children as ElementNode[])
    view.focus()
    const seen: unknown[] = []
    editor.on('transaction', ({ tr }) => seen.push(tr.selection))
    expect(() => editor.runKeymap('Mod-a')).not.toThrow()
    const path = mainRange(start as Selection).anchor.path
    expect(editor.state.selection).toEqual(single({ anchor: { path, offset: 0 }, focus: { path, offset: 4 } }))
    expect(seen).toHaveLength(1)
  })

  it('Backspace at the start of the block after it does nothing; the content stays rendered', () => {
    const { editor, root, view } = setupUnknown([widget('w', 'Title'), p('p1', 'body')])
    view.focus()
    const before = editor.state.doc
    expect(editor.handleIntent({ inputType: 'deleteContentBackward', data: null, range: mainRange(caret([1, 0], 0)) })).toBe(true)
    expect(editor.state.doc).toBe(before)
    expect(root.textContent).toBe('body')
    expect(editor.getHTML()).toContain('body')
  })
})

describe('EditorView', () => {
  it('renders the document on mount', () => {
    const { editor, root } = setup('hello')
    editor.mount(root)
    expect(editor.view).toBeInstanceOf(EditorView)
    expect(editor.view!.root).toBe(root)
    expect(editor.view!.renderer).toBeInstanceOf(Renderer)
    expect(root.querySelectorAll('p')).toHaveLength(1)
    expect(root.textContent).toBe('hello')
    expect(root.getAttribute('contenteditable')).toBe('true')
  })

  it('re-renders on transactions', () => {
    const { editor, root } = setup('ab', caret([0, 0], 2))
    editor.mount(root)
    editor.commands.insertText('x')
    expect(root.textContent).toBe('abx')
  })

  it('writes the model selection to the DOM after rendering when focused', () => {
    const { editor, root } = setup('ab', caret([0, 0], 2))
    editor.mount(root)
    editor.view!.focus()
    expect(document.activeElement).toBe(root)
    const domSel = document.getSelection()!
    expect(domSel.anchorNode && root.contains(domSel.anchorNode)).toBe(true)
    editor.commands.insertText('x')
    expect(domSel.anchorNode).toBe(modelToDom(editor.view!.renderer, { path: [0, 0], offset: 3 }).node)
    expect(domSel.anchorOffset).toBe(3)
  })

  it('does not touch the DOM selection when not focused', () => {
    const { editor, root } = setup('ab', caret([0, 0], 2))
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    outside.focus()
    editor.mount(root)
    editor.commands.insertText('x')
    const domSel = document.getSelection()!
    expect(domSel.anchorNode !== null && root.contains(domSel.anchorNode)).toBe(false)
  })

  it('syncs a DOM selection change inside the root to the model, outside history', () => {
    const { editor, root } = setup('abc')
    editor.mount(root)
    const spy = vi.fn()
    editor.on('transaction', spy)
    const { node, offset } = modelToDom(editor.view!.renderer, { path: [0, 0], offset: 2 })
    document.getSelection()!.setBaseAndExtent(node, offset, node, offset)
    document.dispatchEvent(new Event('selectionchange'))
    expect(editor.state.selection).toEqual(caret([0, 0], 2))
    const tr = spy.mock.calls.at(-1)![0].tr
    expect(tr.meta.origin).toBe('selection')
    expect(tr.meta.addToHistory).toBe(false)
  })

  it('ignores selectionchange when the selection is outside the root, unchanged, or composing', () => {
    const { editor, root } = setup('abc')
    const outside = document.createElement('div')
    outside.textContent = 'zz'
    document.body.appendChild(outside)
    editor.mount(root)
    const spy = vi.fn()
    editor.on('transaction', spy)

    document.getSelection()!.setBaseAndExtent(outside.firstChild!, 1, outside.firstChild!, 1)
    document.dispatchEvent(new Event('selectionchange'))

    const at0 = modelToDom(editor.view!.renderer, { path: [0, 0], offset: 0 })
    document.getSelection()!.setBaseAndExtent(at0.node, at0.offset, at0.node, at0.offset)
    document.dispatchEvent(new Event('selectionchange'))

    ;(editor.view as unknown as { composing: boolean }).composing = true
    const at1 = modelToDom(editor.view!.renderer, { path: [0, 0], offset: 1 })
    document.getSelection()!.setBaseAndExtent(at1.node, at1.offset, at1.node, at1.offset)
    document.dispatchEvent(new Event('selectionchange'))

    expect(spy).not.toHaveBeenCalled()
    expect(editor.state.selection).toEqual(caret([0, 0], 0))
  })

  it('does not dispatch for selectionchange caused by its own selection writes', () => {
    const { editor, root } = setup('abc', caret([0, 0], 1))
    editor.mount(root)
    editor.view!.focus()
    const spy = vi.fn()
    editor.on('transaction', spy)
    editor.commands.insertText('x')
    document.dispatchEvent(new Event('selectionchange'))
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('unmount removes every listener it added and stops rendering', () => {
    const { editor, root } = setup('ab', caret([0, 0], 2))
    const tracked = trackListeners(root, document, window)
    editor.mount(root)
    expect(tracked.adds()).toBeGreaterThan(0)
    editor.unmount()
    expect(tracked.live).toEqual([])
    expect(editor.view).toBeNull()
    expect(root.textContent).toBe('ab')
    editor.commands.insertText('x')
    expect(root.textContent).toBe('ab')
    expect(() => editor.unmount()).not.toThrow()
  })

  it('mounting twice on the same element is a no-op', () => {
    const { editor, root } = setup('ab')
    const render = vi.spyOn(Renderer.prototype, 'render')
    const tracked = trackListeners(root, document)
    editor.mount(root)
    const view = editor.view
    const adds = tracked.adds()
    editor.mount(root)
    expect(editor.view).toBe(view)
    expect(render).toHaveBeenCalledTimes(1)
    expect(tracked.adds()).toBe(adds)
    expect(root.querySelectorAll('p')).toHaveLength(1)
  })

  it('mounting on a different element unmounts first', () => {
    const { editor, root } = setup('ab', caret([0, 0], 2))
    const other = document.createElement('div')
    document.body.appendChild(other)
    const tracked = trackListeners(root, document)
    editor.mount(root)
    const first = editor.view!
    editor.mount(other)
    expect(editor.view).not.toBe(first)
    expect(editor.view!.root).toBe(other)
    expect(tracked.live.filter((e) => e.target === root)).toEqual([])
    expect(tracked.live.filter((e) => e.target === document)).toHaveLength(1)
    editor.commands.insertText('x')
    expect(other.textContent).toBe('abx')
    expect(root.textContent).toBe('ab')
  })

  it('remounts cleanly after unmount (StrictMode double mount)', () => {
    const { editor, root } = setup('ab', caret([0, 0], 2))
    const tracked = trackListeners(root, document)
    editor.mount(root)
    editor.unmount()
    editor.mount(root)
    expect(tracked.live.filter((e) => e.target === document)).toHaveLength(1)
    const spy = vi.fn()
    editor.on('transaction', spy)
    editor.commands.insertText('x')
    expect(root.textContent).toBe('abx')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('mounting on a different element gives the old root back its own attributes', () => {
    const { editor, root } = setup('ab')
    root.setAttribute('role', 'region')
    root.style.whiteSpace = 'normal'
    const other = document.createElement('div')
    document.body.appendChild(other)
    editor.mount(root)
    expect(root.getAttribute('contenteditable')).toBe('true')
    editor.mount(other)
    expect(root.hasAttribute('contenteditable')).toBe(false)
    expect(root.getAttribute('role')).toBe('region')
    expect(root.hasAttribute('aria-multiline')).toBe(false)
    expect(root.style.whiteSpace).toBe('normal')
    expect(root.textContent).toBe('ab')
    expect(other.getAttribute('contenteditable')).toBe('true')
    editor.unmount()
    expect(other.hasAttribute('contenteditable')).toBe(false)
    expect(other.hasAttribute('style')).toBe(false)
  })

  it('a remount on the same root after unmount renders the document once, editable again', () => {
    const { editor, root } = setup('ab')
    editor.mount(root)
    editor.unmount()
    root.appendChild(document.createElement('span')).textContent = 'stray'
    editor.mount(root)
    expect(root.getAttribute('contenteditable')).toBe('true')
    expect(root.querySelectorAll('p')).toHaveLength(1)
    expect(root.children).toHaveLength(1)
    expect(root.textContent).toBe('ab')
  })

  it('attach and listen after destroy are no-ops that return a no-op disposer', () => {
    const { editor, root } = setup()
    editor.mount(root)
    const view = editor.view!
    view.destroy()
    const module = vi.fn(() => () => {})
    const disposeModule = view.attach(module)
    expect(module).not.toHaveBeenCalled()
    const fn = vi.fn()
    const tracked = trackListeners(root)
    const disposeListener = view.listen(root, 'keydown', fn)
    expect(tracked.adds()).toBe(0)
    root.dispatchEvent(new KeyboardEvent('keydown'))
    expect(fn).not.toHaveBeenCalled()
    expect(() => {
      disposeModule()
      disposeListener()
    }).not.toThrow()
  })

  it('the disposers of attach and listen remove early, once', () => {
    const { editor, root } = setup()
    editor.mount(root)
    const view = editor.view!
    const cleanup = vi.fn()
    const dispose = view.attach(() => cleanup)
    const fn = vi.fn()
    const unlisten = view.listen(root, 'keydown', fn)
    dispose()
    unlisten()
    root.dispatchEvent(new KeyboardEvent('keydown'))
    expect(fn).not.toHaveBeenCalled()
    view.destroy()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('destroy on the view is idempotent; editor.destroy unmounts', () => {
    const { editor, root } = setup()
    const tracked = trackListeners(root, document)
    editor.mount(root)
    const view = editor.view!
    view.destroy()
    view.destroy()
    expect(tracked.live).toEqual([])
    editor.mount(root)
    editor.destroy()
    expect(editor.view).toBeNull()
    expect(tracked.live).toEqual([])
  })

  it('keeps the last 20 recorded inputs', () => {
    const { editor, root } = setup()
    editor.mount(root)
    const view = editor.view!
    expect(view.composing).toBe(false)
    for (let i = 0; i < 25; i++) view.recordInput({ inputType: 'insertText', data: String(i), time: i })
    expect(view.recentInput).toHaveLength(20)
    expect(view.recentInput[0]!.data).toBe('5')
    expect(view.recentInput.at(-1)!.data).toBe('24')
  })
})

describe('EditorView: plugin options', () => {
  const boxed = definePlugin({
    name: 'boxed',
    node: { kind: 'block', content: 'inline' },
    options: { className: 'a' },
    renderHTML: (_n, { options }) => ['div', { class: String(options.className) }, 0],
  })

  it('rebuilds the element shell on setPluginOptions and reuses the children DOM', () => {
    const editor = createTestEditor({
      plugins: [testParagraph, boxed],
      doc: doc({ id: 'b1', type: 'boxed', data: {}, children: [txt('hi')] }),
    })
    const root = document.createElement('div')
    document.body.appendChild(root)
    editor.mount(root)
    const shell = root.querySelector('[data-penline-id]')!
    const leaf = root.querySelector('[data-penline-leaf]')!
    expect(shell.className).toBe('a')
    editor.setPluginOptions('boxed', { className: 'b' })
    const next = root.querySelector('[data-penline-id]')!
    expect(next.className).toBe('b')
    expect(next).not.toBe(shell)
    expect(root.querySelector('[data-penline-leaf]')).toBe(leaf)
    expect(next.contains(leaf)).toBe(true)
  })

  it('ignores options changes after unmount and for plugins without a node', () => {
    const editor = createTestEditor({ plugins: [testParagraph, testBold, boxed], doc: doc(p('p1', 'x')) })
    const root = document.createElement('div')
    editor.mount(root)
    const dom = root.querySelector('p')
    editor.setPluginOptions('bold', { a: 1 })
    expect(root.querySelector('p')).toBe(dom)
    editor.unmount()
    editor.setPluginOptions('boxed', { className: 'q' })
  })
})
