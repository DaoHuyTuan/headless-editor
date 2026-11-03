// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestEditor, doc, el, sel, txt } from '../../src/testing/index'
import { testParagraph } from '../fixtures'

afterEach(() => {
  vi.restoreAllMocks()
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

function setup(content = doc(el('paragraph', txt('abcd')))) {
  const editor = createTestEditor({ plugins: [testParagraph], doc: content, selection: sel([0, 0], 1) })
  const root = document.createElement('div')
  document.body.appendChild(root)
  editor.mount(root)
  return { editor, root }
}

describe('coordsAt', () => {
  it('returns the range rect at the DOM position of the point', () => {
    const { editor } = setup()
    const seen: { node: Node; offset: number }[] = []
    vi.spyOn(Range.prototype, 'setStart').mockImplementation(function (node: Node, offset: number) {
      seen.push({ node, offset })
    })
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 10, top: 20, bottom: 36, right: 10, width: 0, height: 16, x: 10, y: 20, toJSON: () => ({}),
    } as DOMRect)
    expect(editor.coordsAt({ path: [0, 0], offset: 2 })).toEqual({ left: 10, top: 20, bottom: 36 })
    expect(seen[0]!.offset).toBe(2)
  })

  it('falls back to the first client rect when the bounding rect is empty', () => {
    const { editor } = setup()
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([
      { left: 5, top: 6, bottom: 22, right: 5, width: 0, height: 16 },
    ] as unknown as DOMRectList)
    expect(editor.view!.coordsAt({ path: [0, 0], offset: 0 })).toEqual({ left: 5, top: 6, bottom: 22 })
  })

  it('falls back to the leaf element rect when the range has no rects', () => {
    const { editor, root } = setup()
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([] as unknown as DOMRectList)
    const leaf = root.querySelector('[data-hte-leaf]') as HTMLElement
    vi.spyOn(leaf, 'getBoundingClientRect').mockReturnValue({
      left: 7, top: 8, bottom: 24, right: 50, width: 43, height: 16, x: 7, y: 8, toJSON: () => ({}),
    } as DOMRect)
    expect(editor.coordsAt({ path: [0, 0], offset: 1 })).toEqual({ left: 7, top: 8, bottom: 24 })
  })

  it('returns null when unmounted', () => {
    const { editor } = setup()
    editor.unmount()
    expect(editor.coordsAt({ path: [0, 0], offset: 1 })).toBeNull()
  })

  it('returns null for a point with no rendered leaf', () => {
    const { editor } = setup()
    expect(editor.coordsAt({ path: [5, 0], offset: 0 })).toBeNull()
  })
})
