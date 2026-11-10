// @vitest-environment happy-dom
import { StrictMode, type ComponentType, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isNodeSelection, nodeSelection, type Editor, type NodeViewPropsOf } from '@penline/core'
import { doc, el, sel, txt } from '@penline/core/testing'
import { paragraph } from '@penline/paragraph'
import { EditorContent, useEditor } from '@penline/react'
import { image, type ImageData } from '../src/index'
import {
  Image,
  ImageView,
  useAltDraft,
  useImageContext,
  useImageResize,
  useImageState,
  type ImagePartProps,
} from '../src/react'

const plugins = [paragraph, image] as const
type TestEditor = Editor<typeof plugins>

type View = ComponentType<NodeViewPropsOf<typeof image>>

function Harness({ onEditor, data, view }: { onEditor: (e: TestEditor) => void; data?: Partial<ImageData>; view: View }) {
  const editor = useEditor({
    plugins,
    content: doc(
      el('paragraph', txt('ab')),
      el('image', { src: 'https://x.test/a.png', alt: 'cat', ...data }),
      el('paragraph', txt('cd')),
    ),
    selection: sel([0, 0], 1),
    nodeViews: { image: view },
  })
  onEditor(editor)
  return <EditorContent editor={editor} data-testid="content" />
}

let errors: ReturnType<typeof vi.spyOn>
let warns: ReturnType<typeof vi.spyOn>
/** Set by a test that expects a console.warn (the unsafe src drop). */
let warnExpected = false
beforeEach(() => {
  errors = vi.spyOn(console, 'error')
  warns = vi.spyOn(console, 'warn')
  warnExpected = false
})
afterEach(() => {
  // Clean up and restore first, so a failing assertion below never leaves a mounted tree or a spy
  // behind for the next tests (cascading failures). The calls are read before the restore.
  cleanup()
  const errorCalls = [...errors.mock.calls]
  const warnCalls = [...warns.mock.calls]
  vi.restoreAllMocks()
  // StrictMode: no React error or warning in any test (unmounting included).
  expect(errorCalls).toEqual([])
  if (!warnExpected) expect(warnCalls).toEqual([])
})

const dataOf = (e: TestEditor) => (e.state.doc.children[1] as unknown as { data: ImageData }).data

function setup(data?: Partial<ImageData>, view: View = ImageView) {
  let editor!: TestEditor
  const utils = render(
    <StrictMode>
      <Harness onEditor={(e) => (editor = e)} data={data} view={view} />
    </StrictMode>,
  )
  const root = utils.getByTestId('content')
  return {
    editor: () => editor,
    root,
    figure: () => root.querySelector('figure[data-penline-image]') as HTMLElement,
    input: () => root.querySelector('input') as HTMLInputElement,
    handle: () => root.querySelector('[data-penline-image] > span[data-editor-ignore]') as HTMLElement,
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

  it('never renders an unsafe src: the image is dropped on load', () => {
    warnExpected = true
    const warn = warns.mockImplementation(() => {})
    const t = setup({ src: 'javascript:alert(1)' })
    expect(t.figure()).toBeNull()
    expect(t.root.innerHTML).not.toContain('javascript:')
    expect(warn).toHaveBeenCalled()
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
    expect(t.figure().hasAttribute('data-selected')).toBe(false)
    act(() => {
      const e = t.editor()
      const tr = e.createTransaction()
      tr.setSelection(nodeSelection(e.state.doc, e.registry, [1]))
      e.dispatch(tr)
    })
    expect(t.figure().getAttribute('data-selected')).toBe('')
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

  it.each(['lostpointercapture', 'pointercancel'])('%s ends the drag without committing', (type) => {
    const t = setup({ width: 100 })
    const img = t.figure().querySelector('img')!
    img.getBoundingClientRect = () => ({ width: 100 }) as DOMRect
    const handle = t.handle()
    handle.setPointerCapture = vi.fn()
    handle.releasePointerCapture = vi.fn()
    const ptr = (name: string, clientX: number) =>
      fireEvent(handle, new MouseEvent(name, { bubbles: true, clientX, button: 0 }))
    const before = t.editor().state
    ptr('pointerdown', 10)
    ptr('pointermove', 60)
    expect(img.getAttribute('width')).toBe('150')
    ptr(type, 60)
    // The live width is gone and nothing was dispatched; a later stray move or up does nothing.
    expect(img.getAttribute('width')).toBe('100')
    ptr('pointermove', 90)
    ptr('pointerup', 90)
    expect(img.getAttribute('width')).toBe('100')
    expect(t.editor().state).toBe(before)
  })

  it('a mousedown on the picture node-selects the image; on the resize handle or the alt input it does not', () => {
    const t = setup({ width: 100 })
    const before = t.editor().state.selection
    for (const target of [t.handle(), t.input()]) {
      const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
      act(() => {
        target.dispatchEvent(down)
      })
      expect(down.defaultPrevented).toBe(false)
      expect(t.editor().state.selection).toEqual(before)
      expect(t.figure().hasAttribute('data-selected')).toBe(false)
    }
    // Control: the same press on the <img> does node-select it.
    act(() => {
      t.figure().querySelector('img')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    })
    expect(isNodeSelection(t.editor().state.selection!)).toBe(true)
    expect(t.figure().getAttribute('data-selected')).toBe('')
  })

  it('the view keeps an unsafe src out of the <img> even when the data holds one (safeSrc guard)', () => {
    // The schema never lets such a src into the doc; a view handed one anyway (here by overriding the
    // node) must still not render it.
    const t = setup(undefined, (p) => (
      <ImageView {...p} node={{ ...p.node, data: { ...p.node.data, src: ' javascript:alert(1)' } }} />
    ))
    const img = t.figure().querySelector('img')!
    expect(img.hasAttribute('src')).toBe(false)
    expect(t.root.innerHTML).not.toContain('javascript:')
  })

  it('the resize handle has an accessible role and label', () => {
    const t = setup({ width: 100 })
    expect(t.handle().getAttribute('role')).toBe('separator')
    expect(t.handle().getAttribute('aria-orientation')).toBe('vertical')
    expect(t.handle().getAttribute('aria-label')).toBe('Resize image')
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
    const figures = () => Array.from(t.root.querySelectorAll('figure[data-penline-image]'))
    expect(figures().filter((f) => f.hasAttribute('data-uploading'))).toHaveLength(1)
    await act(async () => {
      resolve('https://x.test/b.png')
      await e.storage.image.whenIdle()
    })
    expect(figures().filter((f) => f.hasAttribute('data-uploading'))).toHaveLength(0)
    expect(errors).not.toHaveBeenCalled()
  })
})

type Props = NodeViewPropsOf<typeof image>

/** Gives the node view container a width and the picture a measured width, for resize tests. */
function measure(root: HTMLElement, imgWidth: number, space = 400) {
  const container = root.querySelector('[data-penline-node-view]') as HTMLElement
  Object.defineProperty(container, 'clientWidth', { configurable: true, value: space })
  const img = container.querySelector('img')!
  img.getBoundingClientRect = () => ({ width: imgWidth }) as DOMRect
  return img
}

function drag(handle: HTMLElement, from: number, to: number) {
  handle.setPointerCapture = vi.fn()
  handle.releasePointerCapture = vi.fn()
  const ptr = (type: string, clientX: number) =>
    fireEvent(handle, new MouseEvent(type, { bubbles: true, clientX, button: 0 }))
  ptr('pointerdown', from)
  ptr('pointermove', to)
  ptr('pointerup', to)
}

function withView(render: (p: Props) => ReactNode): View {
  return function CustomizedView(p: Props) {
    return <>{render(p)}</>
  }
}

const NoAlt = withView((p) => <ImageView {...p} parts={{ altInput: false }} />)

function Grip({ className }: ImagePartProps) {
  return <Image.ResizeHandle className={`grip ${className ?? ''}`} />
}
const CustomGrip = withView((p) => <ImageView {...p} parts={{ resizeHandle: Grip }} classNames={{ resizeHandle: 'rh' }} />)

const Classed = withView((p) => (
  <ImageView {...p} classNames={{ root: 'r', img: 'i', altInput: 'a', resizeHandle: 'h' }} />
))

/** A view built only from the headless hooks: the author adds no data-editor-ignore. */
function HookView(props: Props) {
  const { selected, uploading } = useImageState(props)
  const { width, handleProps } = useImageResize(props)
  const { inputProps } = useAltDraft(props)
  return (
    <div className="custom" data-up={uploading ? '' : undefined} data-sel={selected ? '' : undefined}>
      <img src={props.node.data.src} alt={props.node.data.alt} width={width} />
      <input {...inputProps} />
      <i className="grip" {...handleProps} />
    </div>
  )
}

function Orphan() {
  useImageContext()
  return null
}

describe('ImageView customization', () => {
  it('parts: { altInput: false } hides the input; resize still works', () => {
    const t = setup({ width: 100 }, NoAlt)
    expect(t.root.querySelector('input')).toBeNull()
    measure(t.root, 100)
    drag(t.handle(), 10, 50)
    expect(dataOf(t.editor()).width).toBe(140)
  })

  it('a replacement resizeHandle built with Image.ResizeHandle still resizes and is ignored by the editor', () => {
    const t = setup({ width: 100 }, CustomGrip)
    const grip = t.root.querySelector('.grip') as HTMLElement
    expect(grip.className).toBe('grip rh')
    expect(grip.hasAttribute('data-editor-ignore')).toBe(true)
    measure(t.root, 100)
    drag(grip, 0, 30)
    expect(dataOf(t.editor()).width).toBe(130)
  })

  it('classNames go on the root and each part', () => {
    const t = setup(undefined, Classed)
    expect(t.figure().className).toBe('r')
    expect(t.figure().querySelector('img')!.className).toBe('i')
    expect(t.input().className).toBe('a')
    expect(t.handle().className).toBe('h')
  })

  it('a view built only from the hooks: alt edit, resize, uploading, and controls ignored by the editor', async () => {
    const t = setup({ width: 100 }, HookView)
    const view = () => t.root.querySelector('.custom') as HTMLElement
    const input = view().querySelector('input')!
    const grip = view().querySelector('.grip') as HTMLElement
    expect(input.hasAttribute('data-editor-ignore')).toBe(true)
    expect(input.getAttribute('aria-label')).toBe('Alt text')
    expect(grip.hasAttribute('data-editor-ignore')).toBe(true)
    expect(grip.style.touchAction).toBe('none')

    fireEvent.change(input, { target: { value: 'dog' } })
    fireEvent.blur(input)
    expect(dataOf(t.editor()).alt).toBe('dog')

    const img = measure(t.root, 100)
    drag(grip, 0, 20)
    expect(dataOf(t.editor()).width).toBe(120)
    expect(img.getAttribute('width')).toBe('120')

    act(() => {
      const e = t.editor()
      const tr = e.createTransaction()
      tr.setSelection(nodeSelection(e.state.doc, e.registry, [1]))
      e.dispatch(tr)
    })
    expect(view().hasAttribute('data-sel')).toBe(true)

    let resolve!: (u: string) => void
    const e = t.editor()
    e.setPluginOptions('image', { upload: () => new Promise<string>((r) => (resolve = r)) })
    const created = URL.createObjectURL
    URL.createObjectURL = () => 'blob:test/2'
    try {
      act(() => {
        e.storage.image.upload([new File(['x'], 'a.png', { type: 'image/png' })])
      })
    } finally {
      URL.createObjectURL = created
    }
    const uploading = () => t.root.querySelectorAll('.custom[data-up]').length
    expect(uploading()).toBe(1)
    await act(async () => {
      resolve('https://x.test/b.png')
      await e.storage.image.whenIdle()
    })
    expect(uploading()).toBe(0)
  })

  it('useImageContext throws outside Image.Root', () => {
    // React reports the render error; that is the point of this test.
    errors.mockImplementation(() => {})
    expect(() => render(<Orphan />)).toThrow(/Image.Root/)
    errors.mockReset()
  })
})
