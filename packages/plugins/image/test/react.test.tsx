// @vitest-environment happy-dom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nodeSelection, type Editor } from '@hte/core'
import { doc, el, sel, txt } from '@hte/core/testing'
import { paragraph } from '@hte/paragraph'
import { EditorContent, useEditor } from '@hte/react'
import { image, type ImageData } from '../src/index'
import { ImageView } from '../src/react'

const plugins = [paragraph, image] as const
type TestEditor = Editor<typeof plugins>

function Harness({ onEditor, data }: { onEditor: (e: TestEditor) => void; data?: Partial<ImageData> }) {
  const editor = useEditor({
    plugins,
    content: doc(
      el('paragraph', txt('ab')),
      el('image', { src: 'https://x.test/a.png', alt: 'cat', ...data }),
      el('paragraph', txt('cd')),
    ),
    selection: sel([0, 0], 1),
    nodeViews: { image: ImageView },
  })
  onEditor(editor)
  return <EditorContent editor={editor} data-testid="content" />
}

let errors: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  errors = vi.spyOn(console, 'error')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const dataOf = (e: TestEditor) => (e.state.doc.children[1] as unknown as { data: ImageData }).data

function setup(data?: Partial<ImageData>) {
  let editor!: TestEditor
  const utils = render(
    <StrictMode>
      <Harness onEditor={(e) => (editor = e)} data={data} />
    </StrictMode>,
  )
  const root = utils.getByTestId('content')
  return {
    editor: () => editor,
    root,
    figure: () => root.querySelector('figure.hte-image') as HTMLElement,
    input: () => root.querySelector('input') as HTMLInputElement,
    handle: () => root.querySelector('.hte-image-resize') as HTMLElement,
  }
}

describe('ImageView', () => {
  it('renders img, alt input and resize handle', () => {
    const t = setup({ width: 120 })
    const img = t.figure().querySelector('img')!
    expect(img.getAttribute('src')).toBe('https://x.test/a.png')
    expect(img.getAttribute('alt')).toBe('cat')
    expect(img.getAttribute('width')).toBe('120')
    expect(img.getAttribute('draggable')).toBe('false')
    expect(t.input().value).toBe('cat')
    expect(t.input().getAttribute('aria-label')).toBe('Alt text')
    expect(t.input().hasAttribute('data-editor-ignore')).toBe(true)
    expect(t.handle().hasAttribute('data-editor-ignore')).toBe(true)
    expect(errors).not.toHaveBeenCalled()
  })

  it('does not render an unsafe src', () => {
    const t = setup({ src: 'javascript:alert(1)' })
    expect(t.figure().querySelector('img')!.hasAttribute('src')).toBe(false)
    expect(errors).not.toHaveBeenCalled()
  })

  it('commits the alt on blur as one undo step', () => {
    const t = setup()
    const before = t.editor().state
    fireEvent.change(t.input(), { target: { value: 'dog' } })
    expect(t.editor().state).toBe(before)
    fireEvent.blur(t.input())
    expect(dataOf(t.editor()).alt).toBe('dog')
    act(() => {
      t.editor().commands.undo()
    })
    expect(dataOf(t.editor()).alt).toBe('cat')
    expect(t.input().value).toBe('cat')
    expect(errors).not.toHaveBeenCalled()
  })

  it('commits the alt on Enter, and only once', () => {
    const t = setup()
    const spy = vi.fn()
    t.editor().on('transaction', spy)
    fireEvent.change(t.input(), { target: { value: 'dog' } })
    fireEvent.keyDown(t.input(), { key: 'Enter' })
    fireEvent.blur(t.input())
    expect(dataOf(t.editor()).alt).toBe('dog')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('does not dispatch when the alt is unchanged', () => {
    const t = setup()
    const before = t.editor().state
    fireEvent.focus(t.input())
    fireEvent.keyDown(t.input(), { key: 'Enter' })
    fireEvent.blur(t.input())
    expect(t.editor().state).toBe(before)
  })

  it('Escape reverts the draft and blurs without a tr', () => {
    const t = setup()
    const before = t.editor().state
    t.input().focus()
    fireEvent.change(t.input(), { target: { value: 'dog' } })
    fireEvent.keyDown(t.input(), { key: 'Escape' })
    expect(t.input().value).toBe('cat')
    expect(document.activeElement).not.toBe(t.input())
    fireEvent.blur(t.input())
    expect(t.editor().state).toBe(before)
  })

  it('typing in the input is not intercepted and keeps the model selection', () => {
    const t = setup()
    const selection = t.editor().state.selection
    const ev = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    t.input().dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
    fireEvent.change(t.input(), { target: { value: 'catx' } })
    expect(t.input().value).toBe('catx')
    expect(t.editor().state.selection).toBe(selection)
  })

  it('syncs the draft when the alt changes from outside while not focused', () => {
    const t = setup()
    fireEvent.change(t.input(), { target: { value: 'dog' } })
    fireEvent.blur(t.input())
    act(() => {
      t.editor().commands.undo()
    })
    expect(t.input().value).toBe('cat')
    act(() => {
      t.editor().commands.redo()
    })
    expect(t.input().value).toBe('dog')
  })

  it('an outside alt change while focused survives blur when the draft was not edited', () => {
    const t = setup()
    t.input().focus()
    fireEvent.focus(t.input())
    act(() => {
      const e = t.editor()
      const tr = e.createTransaction()
      tr.setNodeData([1], { alt: 'outside' })
      e.dispatch(tr)
    })
    const spy = vi.fn()
    t.editor().on('transaction', spy)
    fireEvent.blur(t.input())
    expect(spy).not.toHaveBeenCalled()
    expect(dataOf(t.editor()).alt).toBe('outside')
    expect(t.input().value).toBe('outside')
  })

  it('data-selected follows the node selection', () => {
    const t = setup()
    expect(t.figure().getAttribute('data-selected')).toBe('false')
    act(() => {
      const e = t.editor()
      const tr = e.createTransaction()
      tr.setSelection(nodeSelection(e.state.doc, e.registry, [1]))
      e.dispatch(tr)
    })
    expect(t.figure().getAttribute('data-selected')).toBe('true')
    expect(errors).not.toHaveBeenCalled()
  })

  it('resizes with pointer capture, commits a rounded width on pointerup, clamped', () => {
    const t = setup({ width: 100 })
    const parent = t.figure().parentElement!
    Object.defineProperty(parent, 'clientWidth', { configurable: true, value: 400 })
    const img = t.figure().querySelector('img')!
    img.getBoundingClientRect = () => ({ width: 100 }) as DOMRect
    const handle = t.handle()
    const capture = vi.fn()
    const release = vi.fn()
    handle.setPointerCapture = capture
    handle.releasePointerCapture = release
    const ptr = (type: string, clientX: number) =>
      fireEvent(handle, new MouseEvent(type, { bubbles: true, clientX, button: 0 }))
    const before = t.editor().state

    ptr('pointerdown', 10)
    expect(capture).toHaveBeenCalled()
    ptr('pointermove', 60.4)
    expect(img.getAttribute('width')).toBe('150.4')
    expect(t.editor().state).toBe(before)
    ptr('pointerup', 60.4)
    expect(dataOf(t.editor()).width).toBe(150)
    expect(release).toHaveBeenCalled()

    ptr('pointerdown', 0)
    ptr('pointermove', 9999)
    ptr('pointerup', 9999)
    expect(dataOf(t.editor()).width).toBe(400)
    ptr('pointerdown', 0)
    ptr('pointermove', -9999)
    ptr('pointerup', -9999)
    expect(dataOf(t.editor()).width).toBe(32)
    expect(errors).not.toHaveBeenCalled()
  })

  it('a resize drag without movement does not dispatch', () => {
    const t = setup({ width: 100 })
    const handle = t.handle()
    handle.setPointerCapture = vi.fn()
    handle.releasePointerCapture = vi.fn()
    const before = t.editor().state
    fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, clientX: 5 }))
    fireEvent(handle, new MouseEvent('pointerup', { bubbles: true, clientX: 5 }))
    expect(t.editor().state).toBe(before)
  })

  it('sets data-uploading while the upload is pending', async () => {
    const t = setup()
    let resolve!: (u: string) => void
    const e = t.editor()
    e.setPluginOptions('image', { upload: () => new Promise<string>((r) => (resolve = r)) })
    const created = URL.createObjectURL
    URL.createObjectURL = () => 'blob:test/1'
    try {
      act(() => {
        e.storage.image.upload([new File(['x'], 'a.png', { type: 'image/png' })])
      })
    } finally {
      URL.createObjectURL = created
    }
    const figures = () => Array.from(t.root.querySelectorAll('figure.hte-image'))
    expect(figures().filter((f) => f.hasAttribute('data-uploading'))).toHaveLength(1)
    await act(async () => {
      resolve('https://x.test/b.png')
      await e.storage.image.whenIdle()
    })
    expect(figures().filter((f) => f.hasAttribute('data-uploading'))).toHaveLength(0)
    expect(errors).not.toHaveBeenCalled()
  })
})
