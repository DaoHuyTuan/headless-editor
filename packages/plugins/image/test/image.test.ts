// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSelection, mainRange } from '@hte/core'
import {
  clearHistory,
  FRAGMENT_MIME,
  nodeSelection,
  serializeForClipboard,
  serializeHTML,
  toRange,
  type Doc,
  type ElementNode,
  type InputIntent,
} from '@hte/core'
import { createTestEditor, doc, el, sel, stripIds, txt } from '@hte/core/testing'
import { paragraph } from '@hte/paragraph'
import { image, safeSrc } from '../src/index'

interface Deferred {
  file: File
  resolve: (url: string) => void
  reject: (e: unknown) => void
}

const p = (...children: ReturnType<typeof txt>[]) => el('paragraph', ...children)
const png = (name = 'a.png') => new File(['x'], name, { type: 'image/png' })
const pdf = () => new File(['x'], 'a.pdf', { type: 'application/pdf' })
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

function images(d: Doc): ElementNode[] {
  return d.children.filter((n) => n.type === 'image')
}

function text(d: Doc): string {
  return d.children
    .flatMap((b) => b.children ?? [])
    .map((n) => ('text' in n ? n.text : ''))
    .join('')
}

function transfer(files: File[], data: Record<string, string>): DataTransfer {
  return { files, types: Object.keys(data), getData: (t: string) => data[t] ?? '' } as unknown as DataTransfer
}

function intent(inputType: string, dt: DataTransfer): InputIntent {
  return { inputType, data: null, range: null, dataTransfer: dt }
}

let created: string[]
let revoked: string[]
const origCreate = URL.createObjectURL
const origRevoke = URL.revokeObjectURL

beforeEach(() => {
  created = []
  revoked = []
  URL.createObjectURL = (() => {
    const url = `blob:test/${created.length + 1}`
    created.push(url)
    return url
  }) as typeof URL.createObjectURL
  URL.revokeObjectURL = ((url: string) => {
    revoked.push(url)
  }) as typeof URL.revokeObjectURL
})

afterEach(() => {
  URL.createObjectURL = origCreate
  URL.revokeObjectURL = origRevoke
})

function setup() {
  const uploads: Deferred[] = []
  const onUploadError = vi.fn()
  const upload = (file: File) =>
    new Promise<string>((resolve, reject) => {
      uploads.push({ file, resolve, reject })
    })
  const editor = createTestEditor({
    plugins: [paragraph, image.configure({ upload, onUploadError })],
    doc: doc(p(txt('ab'))),
    selection: sel([0, 0], 2),
  })
  return { editor, uploads, onUploadError }
}

describe('image upload', () => {
  it('inserts a blob preview, swaps in the uploaded URL, and is one undo step', async () => {
    const { editor, uploads } = setup()
    editor.storage.image.upload([png()])
    const [img] = images(editor.state.doc as Doc)
    expect(img!.data).toEqual({ src: 'blob:test/1', alt: '' })
    expect(editor.storage.image.isUploading()).toBe(true)
    expect(editor.storage.image.isPending(img!.id)).toBe(true)

    uploads[0]!.resolve('https://x/a.png')
    await editor.storage.image.whenIdle()
    expect(images(editor.state.doc as Doc)[0]!.data).toEqual({ src: 'https://x/a.png', alt: '' })
    expect(editor.storage.image.isUploading()).toBe(false)
    expect(editor.storage.image.isPending(img!.id)).toBe(false)

    expect(editor.commands.undo()).toBe(true)
    expect(images(editor.state.doc as Doc)).toHaveLength(0)
    // The success / bookkeeping trs added no history entries.
    expect(editor.commands.undo()).toBe(false)
    expect(editor.commands.redo()).toBe(true)
    expect(images(editor.state.doc as Doc)[0]!.data.src).toBe('https://x/a.png')
  })

  it('whenIdle resolves immediately when nothing is pending', async () => {
    const { editor } = setup()
    await expect(editor.storage.image.whenIdle()).resolves.toBeUndefined()
  })

  it('a failed upload removes the image and calls onUploadError', async () => {
    const { editor, uploads, onUploadError } = setup()
    const file = png()
    editor.storage.image.upload([file])
    const err = new Error('boom')
    uploads[0]!.reject(err)
    await editor.storage.image.whenIdle()
    expect(images(editor.state.doc as Doc)).toHaveLength(0)
    expect(onUploadError).toHaveBeenCalledWith(err, file)
    expect(editor.storage.image.isUploading()).toBe(false)
    expect(text(editor.state.doc as Doc)).toBe('ab')
  })

  it('a failed upload after the user changed the src: undo never brings the dead blob back', async () => {
    const { editor, uploads } = setup()
    editor.storage.image.upload([png()])
    const path = [1]
    const tr = editor.createTransaction()
    tr.setNodeData(path, { src: 'https://x/mine.png' })
    editor.dispatch(tr)
    uploads[0]!.reject(new Error('boom'))
    await editor.storage.image.whenIdle()
    expect(images(editor.state.doc as Doc).map((i) => i.data.src)).toEqual(['https://x/mine.png'])
    while (editor.commands.undo()) {
      expect(images(editor.state.doc as Doc).map((i) => i.data.src)).not.toContain('blob:test/1')
    }
  })

  it('a failed upload at the end of the last block leaves no trailing empty paragraph', async () => {
    const { editor, uploads } = setup()
    editor.storage.image.upload([png()])
    expect((editor.state.doc as Doc).children.map((b) => b.type)).toEqual(['paragraph', 'image', 'paragraph'])
    uploads[0]!.reject(new Error('boom'))
    await editor.storage.image.whenIdle()
    expect(stripIds(editor.state.doc as Doc)).toEqual(stripIds(doc(p(txt('ab')))))
    expect(editor.state.selection).toEqual(sel([0, 0], 2))
  })

  it('a failed upload keeps an empty paragraph the user typed into meanwhile', async () => {
    const { editor, uploads } = setup()
    editor.storage.image.upload([png()])
    editor.commands.insertText('x')
    uploads[0]!.reject(new Error('boom'))
    await editor.storage.image.whenIdle()
    expect(text(editor.state.doc as Doc)).toBe('abx')
    expect((editor.state.doc as Doc).children).toHaveLength(2)
  })

  it('Review Focus 1: undo before the upload resolves, then redo restores the uploaded URL', async () => {
    const { editor, uploads } = setup()
    editor.storage.image.upload([png()])
    expect(editor.commands.undo()).toBe(true)
    expect(images(editor.state.doc as Doc)).toHaveLength(0)
    uploads[0]!.resolve('https://x/a.png')
    await editor.storage.image.whenIdle()
    expect(images(editor.state.doc as Doc)).toHaveLength(0)
    expect(editor.commands.redo()).toBe(true)
    expect(images(editor.state.doc as Doc)[0]!.data.src).toBe('https://x/a.png')
  })

  it('Review Focus 1: undo then redo before resolving restores the blob, rewritten when it resolves', async () => {
    const { editor, uploads } = setup()
    editor.storage.image.upload([png()])
    editor.commands.undo()
    editor.commands.redo()
    expect(images(editor.state.doc as Doc)[0]!.data.src).toBe('blob:test/1')
    uploads[0]!.resolve('https://x/a.png')
    await editor.storage.image.whenIdle()
    expect(images(editor.state.doc as Doc)[0]!.data.src).toBe('https://x/a.png')
  })

  it('deleting the image while pending: no throw, no reinsertion; undo brings it back uploaded', async () => {
    const { editor, uploads } = setup()
    editor.storage.image.upload([png()])
    const tr = editor.createTransaction()
    tr.meta.origin = 'command'
    tr.removeNode([1])
    editor.dispatch(tr)
    expect(images(editor.state.doc as Doc)).toHaveLength(0)
    uploads[0]!.resolve('https://x/a.png')
    await editor.storage.image.whenIdle()
    expect(images(editor.state.doc as Doc)).toHaveLength(0)
    expect(editor.commands.undo()).toBe(true)
    expect(images(editor.state.doc as Doc)[0]!.data.src).toBe('https://x/a.png')
  })

  it('a failed upload after the image was deleted does not throw', async () => {
    const { editor, uploads, onUploadError } = setup()
    editor.storage.image.upload([png()])
    editor.commands.undo()
    uploads[0]!.reject(new Error('boom'))
    await editor.storage.image.whenIdle()
    expect(images(editor.state.doc as Doc)).toHaveLength(0)
    expect(onUploadError).toHaveBeenCalledTimes(1)
  })

  it('delete while pending, then the upload fails: undo restores no blob image', async () => {
    const { editor, uploads, onUploadError } = setup()
    editor.storage.image.upload([png()])
    const tr = editor.createTransaction()
    tr.meta.origin = 'command'
    tr.removeNode([1])
    editor.dispatch(tr)
    uploads[0]!.reject(new Error('boom'))
    await editor.storage.image.whenIdle()
    expect(onUploadError).toHaveBeenCalledTimes(1)
    editor.commands.undo()
    expect(images(editor.state.doc as Doc)).toHaveLength(0)
    expect(editor.getHTML()).not.toContain('blob:')
  })

  it('undo, then the upload fails: redo restores no blob image', async () => {
    const { editor, uploads } = setup()
    editor.storage.image.upload([png()])
    editor.commands.undo()
    uploads[0]!.reject(new Error('boom'))
    await editor.storage.image.whenIdle()
    editor.commands.redo()
    expect(images(editor.state.doc as Doc)).toHaveLength(0)
    expect(editor.getHTML()).not.toContain('blob:')
  })

  /** Types `data` at the end of the first paragraph (selection-only tr first, then input). */
  function typeInFirst(editor: ReturnType<typeof setup>['editor'], data: string): void {
    const tr = editor.createTransaction()
    const len = text(editor.state.doc as Doc).length
    tr.setSelection(sel([0, 0], len))
    editor.dispatch(tr)
    editor.handleIntent({ inputType: 'insertText', data, range: null })
  }

  it('a failure while the preview is in the doc keeps history: typing done after the upload started is undoable', async () => {
    const { editor, uploads } = setup()
    editor.storage.image.upload([png()])
    typeInFirst(editor, 'c')
    expect(text(editor.state.doc as Doc)).toBe('abc')
    uploads[0]!.reject(new Error('boom'))
    await editor.storage.image.whenIdle()
    expect(images(editor.state.doc as Doc)).toHaveLength(0)
    expect(editor.commands.undo()).toBe(true)
    expect(text(editor.state.doc as Doc)).toBe('ab')
    expect(images(editor.state.doc as Doc)).toHaveLength(0)
    // The upload step itself can't be rebased over the removal of its image: it is dropped.
    expect(editor.commands.undo()).toBe(false)
    expect(editor.commands.redo()).toBe(true)
    expect(text(editor.state.doc as Doc)).toBe('abc')
    expect(editor.getHTML()).not.toContain('blob:')
  })

  it('a failure while the preview is in the doc drops the upload step and every entry below it', async () => {
    // Rebase semantics: the first entry that can't be mapped through the removal (the upload's
    // insert of the preview) is dropped with everything below it, so typing done before the upload
    // is no longer undoable, while the doc keeps it.
    const { editor, uploads } = setup()
    typeInFirst(editor, 'c')
    editor.storage.image.upload([png()])
    uploads[0]!.reject(new Error('boom'))
    await editor.storage.image.whenIdle()
    expect(text(editor.state.doc as Doc)).toBe('abc')
    expect(images(editor.state.doc as Doc)).toHaveLength(0)
    expect(editor.commands.undo()).toBe(false)
    expect(text(editor.state.doc as Doc)).toBe('abc')
    expect(editor.getHTML()).not.toContain('blob:')
  })

  it('undo, then the upload fails: history is cleared (an undone preview can not be mapped)', async () => {
    const { editor, uploads } = setup()
    typeInFirst(editor, 'c')
    editor.storage.image.upload([png()])
    expect(editor.commands.undo()).toBe(true)
    uploads[0]!.reject(new Error('boom'))
    await editor.storage.image.whenIdle()
    expect(editor.commands.redo()).toBe(false)
    expect(editor.commands.undo()).toBe(false)
    expect(text(editor.state.doc as Doc)).toBe('abc')
    expect(editor.getHTML()).not.toContain('blob:')
  })

  it('a throw in the success path keeps the image and is reported, not treated as a failure', async () => {
    const { editor, uploads, onUploadError } = setup()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      editor.storage.image.upload([png()])
      const off = editor.on('transaction', ({ tr }) => {
        if (tr.docChanged && tr.meta.origin === 'plugin') throw new Error('listener boom')
      })
      uploads[0]!.resolve('https://x/a.png')
      await editor.storage.image.whenIdle()
      off()
      expect(images(editor.state.doc as Doc)).toHaveLength(1)
      expect(images(editor.state.doc as Doc)[0]!.data.src).toBe('https://x/a.png')
      expect(onUploadError).not.toHaveBeenCalled()
      expect(errorSpy).toHaveBeenCalledWith('@hte/image:', expect.objectContaining({ message: 'listener boom' }))
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('a throwing onUploadError is reported, not an unhandled rejection', async () => {
    const { editor, uploads, onUploadError } = setup()
    onUploadError.mockImplementation(() => {
      throw new Error('handler boom')
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      editor.storage.image.upload([png()])
      uploads[0]!.reject(new Error('boom'))
      await editor.storage.image.whenIdle()
      await flush()
      expect(images(editor.state.doc as Doc)).toHaveLength(0)
      expect(editor.storage.image.isUploading()).toBe(false)
      expect(errorSpy).toHaveBeenCalledWith('@hte/image:', expect.objectContaining({ message: 'handler boom' }))
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('isUploading / isPending are false after destroy', () => {
    const { editor } = setup()
    editor.storage.image.upload([png()])
    const id = images(editor.state.doc as Doc)[0]!.id
    expect(editor.storage.image.isPending(id)).toBe(true)
    editor.destroy()
    expect(editor.storage.image.isUploading()).toBe(false)
    expect(editor.storage.image.isPending(id)).toBe(false)
  })

  it('leaves a src the user changed while the upload was pending', async () => {
    const { editor, uploads } = setup()
    editor.storage.image.upload([png()])
    editor.commands.setNodeData([1], { src: 'https://x/other.png' })
    uploads[0]!.resolve('https://x/a.png')
    await editor.storage.image.whenIdle()
    expect(images(editor.state.doc as Doc)[0]!.data.src).toBe('https://x/other.png')
  })

  it('skips non-image files and uploads several images', async () => {
    const { editor, uploads } = setup()
    editor.storage.image.upload([png('1.png'), pdf(), png('2.png')])
    expect(uploads.map((u) => u.file.name)).toEqual(['1.png', '2.png'])
    expect(images(editor.state.doc as Doc).map((i) => i.data.src)).toEqual(['blob:test/1', 'blob:test/2'])
    uploads[1]!.resolve('https://x/2.png')
    await flush()
    expect(editor.storage.image.isUploading()).toBe(true)
    uploads[0]!.resolve('https://x/1.png')
    await editor.storage.image.whenIdle()
    expect(images(editor.state.doc as Doc).map((i) => i.data.src)).toEqual(['https://x/1.png', 'https://x/2.png'])
  })

  it('whenIdle resolves when the editor is destroyed while pending, and blob URLs are revoked', async () => {
    const { editor, uploads } = setup()
    editor.storage.image.upload([png()])
    const idle = editor.storage.image.whenIdle()
    editor.destroy()
    await expect(idle).resolves.toBeUndefined()
    expect(revoked).toEqual(['blob:test/1'])
    // A late resolution after destroy does not throw.
    uploads[0]!.resolve('https://x/a.png')
    await flush()
  })

  it('throws a clear error when URL.createObjectURL is unavailable', () => {
    const { editor } = setup()
    ;(URL as { createObjectURL?: unknown }).createObjectURL = undefined
    expect(() => editor.storage.image.upload([png()])).toThrow(/createObjectURL/)
  })
})

describe('Review Focus 4: paste / drop', () => {
  it('a paste with [png, pdf] and text uploads the image only and ignores the text', () => {
    const { editor, uploads } = setup()
    const handled = editor.handleIntent(intent('insertFromPaste', transfer([png(), pdf()], { 'text/plain': 'hi' })))
    expect(handled).toBe(true)
    expect(images(editor.state.doc as Doc)).toHaveLength(1)
    expect(uploads).toHaveLength(1)
    expect(text(editor.state.doc as Doc)).toBe('ab')
  })

  it('a paste with only [pdf] and text inserts the text through the default', () => {
    const { editor, uploads } = setup()
    const handled = editor.handleIntent(intent('insertFromPaste', transfer([pdf()], { 'text/plain': 'hi' })))
    expect(handled).toBe(true)
    expect(images(editor.state.doc as Doc)).toHaveLength(0)
    expect(uploads).toHaveLength(0)
    expect(text(editor.state.doc as Doc)).toBe('abhi')
  })

  it('a drop with an image and html uploads the image only', () => {
    const { editor, uploads } = setup()
    editor.handleIntent(intent('insertFromDrop', transfer([png()], { 'text/html': '<p>hi</p>', 'text/plain': 'hi' })))
    expect(images(editor.state.doc as Doc)).toHaveLength(1)
    expect(uploads).toHaveLength(1)
    expect(text(editor.state.doc as Doc)).toBe('ab')
  })

  it('without a configured upload, an image paste falls back to the default and does not throw', () => {
    const editor = createTestEditor({
      plugins: [paragraph, image],
      doc: doc(p(txt('ab'))),
      selection: sel([0, 0], 2),
    })
    let handled = false
    expect(() => {
      handled = editor.handleIntent(intent('insertFromPaste', transfer([png()], { 'text/plain': 'hi' })))
    }).not.toThrow()
    expect(handled).toBe(true)
    expect(images(editor.state.doc as Doc)).toHaveLength(0)
    expect(text(editor.state.doc as Doc)).toBe('abhi')
    expect(() => editor.storage.image.upload([png()])).toThrow(/options\.upload/)
  })

  it('a drop inserts the image at the drop range', () => {
    const { editor } = setup()
    editor.handleIntent({ ...intent('insertFromDrop', transfer([png()], {})), range: mainRange(sel([0, 0], 0)) })
    expect((editor.state.doc as Doc).children[0]!.type).toBe('image')
  })

  it('a drop while an image is node-selected goes to the drop point and keeps the selected image', () => {
    const { editor } = setup()
    const tr = editor.createTransaction()
    tr.insertNode([1], el('image', { src: 'https://x/a.png', alt: 'old' }))
    tr.insertNode([2], p(txt('cd')))
    tr.setSelection(nodeSelection(tr.doc, editor.registry, [1]))
    editor.dispatch(tr)
    editor.handleIntent({ ...intent('insertFromDrop', transfer([png()], {})), range: mainRange(sel([2, 0], 2)) })
    const imgs = images(editor.state.doc as Doc)
    expect(imgs).toHaveLength(2)
    expect(imgs[0]!.data.alt).toBe('old')
    expect(text(editor.state.doc as Doc)).toBe('abcd')
  })

  it('a text drop while a node is selected inserts at the drop point and keeps the node', () => {
    const { editor } = setup()
    const tr = editor.createTransaction()
    tr.insertNode([1], el('image', { src: 'https://x/a.png', alt: 'old' }))
    tr.insertNode([2], p(txt('cd')))
    tr.setSelection(nodeSelection(tr.doc, editor.registry, [1]))
    editor.dispatch(tr)
    editor.handleIntent({ ...intent('insertFromDrop', transfer([], { 'text/plain': 'XY' })), range: mainRange(sel([2, 0], 1)) })
    expect(images(editor.state.doc as Doc)).toHaveLength(1)
    expect(text(editor.state.doc as Doc)).toBe('abcXYd')
    expect(editor.state.selection).toEqual(sel([2, 0], 3))
  })

  it('an upload resolving with an unsafe URL is treated as a failure', async () => {
    const { editor, uploads, onUploadError } = setup()
    editor.storage.image.upload([png()])
    uploads[0]!.resolve('javascript:alert(1)')
    await editor.storage.image.whenIdle()
    expect(images(editor.state.doc as Doc)).toHaveLength(0)
    expect(onUploadError).toHaveBeenCalledTimes(1)
  })
})

describe('safeSrc', () => {
  it.each([
    ['https://x/a.png', true],
    ['http://x/a.png', true],
    ['HTTPS://x/a.png', true],
    ['blob:https://x/123', true],
    ['data:image/png;base64,AAAA', true],
    ['data:image/jpeg;base64,AAAA', true],
    ['data:image/gif;base64,AAAA', true],
    ['data:image/webp;base64,AAAA', true],
    ['data:image/avif;base64,AAAA', true],
    ['/img/a.png', true],
    ['img/a.png', true],
    ['./a.png?x=1:2', true],
    ['javascript:alert(1)', false],
    ['JavaScript:alert(1)', false],
    [' javascript:alert(1)', false],
    ['java\tscript:alert(1)', false],
    ['data:text/html;base64,AAAA', false],
    ['data:image/svg+xml;base64,AAAA', false],
    ['data:image/png,AAAA', false],
    ['vbscript:msgbox(1)', false],
    ['file:///etc/passwd', false],
    ['', false],
  ])('%s → allowed: %s', (src, ok) => {
    expect(safeSrc(src) !== null).toBe(ok)
  })

  it('returns the src unchanged when allowed', () => {
    expect(safeSrc('https://x/a.png')).toBe('https://x/a.png')
  })
})

describe('image HTML and commands', () => {
  it('parses an <img>, dropping one with an unsafe src', () => {
    const editor = createTestEditor({
      plugins: [paragraph, image],
      content: '<img src="javascript:alert(1)"><img src="https://x/a.png" alt="A" width="120"><p>t</p>',
    })
    const imgs = images(editor.state.doc as Doc)
    expect(imgs).toHaveLength(1)
    expect(imgs[0]!.data).toEqual({ src: 'https://x/a.png', alt: 'A', width: 120 })
  })

  it.each(['99999999999999999999', '9007199254740992', '1'.repeat(400), '0', ' 12px', '1e3'])(
    'parses an <img width="%s"> without a width, keeping the image',
    (width) => {
      const warn = vi.spyOn(console, 'warn')
      try {
        const editor = createTestEditor({ plugins: [paragraph, image], content: `<img src="https://x/a.png" width="${width}">` })
        expect(images(editor.state.doc as Doc).map((i) => i.data)).toEqual([{ src: 'https://x/a.png', alt: '' }])
        expect(warn).not.toHaveBeenCalled()
      } finally {
        warn.mockRestore()
      }
    },
  )

  it('parses the largest safe integer width', () => {
    const editor = createTestEditor({ plugins: [paragraph, image], content: '<img src="https://x/a.png" width=" 9007199254740991 ">' })
    expect(images(editor.state.doc as Doc)[0]!.data.width).toBe(Number.MAX_SAFE_INTEGER)
  })

  it.each([2 ** 53, Infinity, NaN, 1.5, -1])('setNodeData with width %s is rejected', (width) => {
    const editor = createTestEditor({ plugins: [paragraph, image], doc: doc(el('image', { src: 'https://x/a.png', alt: '' })) })
    expect(editor.commands.setNodeData([0], { width })).toBe(false)
    expect(images(editor.state.doc as Doc)[0]!.data.width).toBeUndefined()
  })

  it('parses no image from a javascript: src alone', () => {
    const editor = createTestEditor({ plugins: [paragraph, image], content: '<img src="javascript:alert(1)">' })
    expect(images(editor.state.doc as Doc)).toHaveLength(0)
  })

  it('serializes to a void <img>', () => {
    const editor = createTestEditor({
      plugins: [paragraph, image],
      doc: doc(el('image', { src: 'https://x/a.png', alt: '' })),
    })
    expect(editor.getHTML()).toBe('<img src="https://x/a.png" alt="">')
  })

  it('renderHTML omits an unsafe src (defense in depth: the schema keeps it out of stored data)', () => {
    const editor = createTestEditor({ plugins: [paragraph, image] })
    // An unvalidated doc handed straight to the serializer.
    const raw = doc(el('image', { src: 'javascript:alert(1)', alt: 'x', width: 5 }))
    expect(serializeHTML(raw, editor.registry, (name) => editor.getPluginOptions(name))).toBe('<img alt="x" width="5">')
  })

  it('insertImage inserts an image at the caret', () => {
    const { editor } = setup()
    expect(editor.commands.insertImage('https://x/b.png')).toBe(true)
    expect(images(editor.state.doc as Doc)[0]!.data).toEqual({ src: 'https://x/b.png', alt: '' })
    expect(editor.commands.insertImage('https://x/c.png', 'C')).toBe(true)
    expect(images(editor.state.doc as Doc)[1]!.data).toEqual({ src: 'https://x/c.png', alt: 'C' })
  })

  it('insertImage refuses an unsafe src', () => {
    const { editor } = setup()
    expect(editor.commands.insertImage('javascript:alert(1)')).toBe(false)
    expect(images(editor.state.doc as Doc)).toHaveLength(0)
  })
})

/** Copies the node-selected image at `path` and pastes it at the end of the doc (the JSON flavour). */
function copyPasteImage(editor: ReturnType<typeof setup>['editor'], path: number[]): void {
  const select = editor.createTransaction()
  select.setSelection(nodeSelection(editor.state.doc, editor.registry, path))
  editor.dispatch(select)
  const selected = editor.state.selection!
  const { json, html, text } = serializeForClipboard(editor, toRange(mainRange(selected)), path)
  const end = editor.createTransaction()
  end.setSelection(sel([0, 0], 2))
  editor.dispatch(end)
  editor.handleIntent(intent('insertFromPaste', transfer([], { [FRAGMENT_MIME]: json, 'text/html': html, 'text/plain': text })))
}

describe('copy / paste without the JSON flavour', () => {
  // Safari may strip the custom JSON MIME: the HTML flavour alone must bring the image back with a fresh id.
  it('pasting only the html flavour of a copied image inserts an equal image with a fresh id', () => {
    const editor = createTestEditor({
      plugins: [paragraph, image],
      doc: doc(p(txt('ab')), el('image', { src: 'https://x/a.png', alt: 'A', width: 40 }), p(txt('cd'))),
      selection: sel([0, 0], 0),
    })
    const select = editor.createTransaction()
    select.setSelection(nodeSelection(editor.state.doc, editor.registry, [1]))
    editor.dispatch(select)
    const { html, text } = serializeForClipboard(editor, toRange(mainRange(editor.state.selection!)), [1])
    const end = editor.createTransaction()
    end.setSelection(sel([2, 0], 2))
    editor.dispatch(end)
    editor.handleIntent(intent('insertFromPaste', transfer([], { 'text/html': html, 'text/plain': text })))
    const d = editor.state.doc as Doc
    expect(d.children.map((b) => b.type)).toEqual(['paragraph', 'image', 'paragraph', 'image', 'paragraph'])
    const [first, second] = images(d)
    expect(second!.data).toEqual(first!.data)
    expect(second!.id).not.toBe(first!.id)
  })
})

describe('I1: copies of a pending image', () => {
  it('a pasted copy of a pending image gets the uploaded URL too', async () => {
    const { editor, uploads } = setup()
    editor.storage.image.upload([png()])
    copyPasteImage(editor, [1])
    expect(images(editor.state.doc as Doc).map((i) => i.data.src)).toEqual(['blob:test/1', 'blob:test/1'])
    const ids = images(editor.state.doc as Doc).map((i) => i.id)
    expect(new Set(ids).size).toBe(2)

    uploads[0]!.resolve('https://x/a.png')
    await editor.storage.image.whenIdle()
    expect(editor.storage.image.isUploading()).toBe(false)
    expect(images(editor.state.doc as Doc).map((i) => i.data.src)).toEqual(['https://x/a.png', 'https://x/a.png'])
    expect(JSON.stringify(editor.getJSON())).not.toContain('blob:')

    // History's copies were rewritten too: undo the paste, redo it → the uploaded URL.
    expect(editor.commands.undo()).toBe(true)
    expect(editor.commands.redo()).toBe(true)
    expect(JSON.stringify(editor.getJSON())).not.toContain('blob:')
    expect(images(editor.state.doc as Doc).map((i) => i.data.src)).toEqual(['https://x/a.png', 'https://x/a.png'])
  })

  /** Removes the image element `id` as one undo step. */
  function removeImage(editor: ReturnType<typeof setup>['editor'], id: string): void {
    const tr = editor.createTransaction()
    tr.meta.origin = 'command'
    tr.removeNode([(editor.state.doc as Doc).children.findIndex((n) => n.id === id)])
    editor.dispatch(tr)
  }

  it('the original deleted while pending: the copy is updated, undo restores the original uploaded', async () => {
    const { editor, uploads } = setup()
    editor.storage.image.upload([png()])
    const original = images(editor.state.doc as Doc)[0]!.id
    copyPasteImage(editor, [1])
    removeImage(editor, original)
    uploads[0]!.resolve('https://x/a.png')
    await editor.storage.image.whenIdle()
    expect(images(editor.state.doc as Doc).map((i) => i.data.src)).toEqual(['https://x/a.png'])
    expect(editor.commands.undo()).toBe(true)
    expect(images(editor.state.doc as Doc)).toHaveLength(2)
    expect(JSON.stringify(editor.getJSON())).not.toContain('blob:')
  })

  it('a pasted copy deleted while pending: undo restores it with the uploaded URL', async () => {
    const { editor, uploads } = setup()
    editor.storage.image.upload([png()])
    const original = images(editor.state.doc as Doc)[0]!.id
    copyPasteImage(editor, [1])
    const copy = images(editor.state.doc as Doc).find((i) => i.id !== original)!.id
    removeImage(editor, copy)
    uploads[0]!.resolve('https://x/a.png')
    await editor.storage.image.whenIdle()
    expect(images(editor.state.doc as Doc).map((i) => i.data.src)).toEqual(['https://x/a.png'])
    expect(editor.commands.undo()).toBe(true)
    expect(images(editor.state.doc as Doc).map((i) => i.id).sort()).toEqual([copy, original].sort())
    expect(JSON.stringify(editor.getJSON())).not.toContain('blob:')
  })

  it('a failed upload removes the copies too, and undo / redo bring no blob back', async () => {
    const { editor, uploads, onUploadError } = setup()
    editor.storage.image.upload([png()])
    copyPasteImage(editor, [1])
    uploads[0]!.reject(new Error('boom'))
    await editor.storage.image.whenIdle()
    expect(onUploadError).toHaveBeenCalledTimes(1)
    expect(images(editor.state.doc as Doc)).toHaveLength(0)
    editor.commands.undo()
    editor.commands.redo()
    expect(JSON.stringify(editor.getJSON())).not.toContain('blob:')
  })
})

describe('I2: src policy in stored data', () => {
  const unsafe = ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', 'file:///etc/passwd']

  it.each(unsafe)('loading an image with src %s drops it (with a warning)', (src) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const editor = createTestEditor({
        plugins: [paragraph, image],
        doc: doc(el('image', { src, alt: 'x' }), p(txt('t'))),
      })
      expect(images(editor.state.doc as Doc)).toHaveLength(0)
      expect(JSON.stringify(editor.getJSON())).not.toContain(src.slice(0, 8))
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it.each(['https://x/a.png', 'blob:http://localhost/1', 'data:image/png;base64,iVBORw0KGgo=', '/a.png'])(
    'loading an image with src %s keeps it',
    (src) => {
      const editor = createTestEditor({ plugins: [paragraph, image], doc: doc(el('image', { src, alt: '' })) })
      expect(images(editor.state.doc as Doc)[0]!.data.src).toBe(src)
    },
  )

  it('setNodeData with an unsafe src is rejected', () => {
    const editor = createTestEditor({
      plugins: [paragraph, image],
      doc: doc(el('image', { src: 'https://x/a.png', alt: '' })),
    })
    expect(editor.commands.setNodeData([0], { src: 'data:text/html,<b>x</b>' })).toBe(false)
    expect(editor.commands.setNodeData([0], { src: 'javascript:alert(1)' })).toBe(false)
    expect(images(editor.state.doc as Doc)[0]!.data.src).toBe('https://x/a.png')
    expect(editor.commands.setNodeData([0], { src: 'https://x/b.png' })).toBe(true)
  })

  it.each(['insertFromPaste', 'insertFromDrop'])('a JSON %s with an unsafe image src inserts no image', (inputType) => {
    const { editor } = setup()
    const json = JSON.stringify([{ type: 'image', id: 'evil', data: { src: 'javascript:alert(1)', alt: '' } }])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      editor.handleIntent(intent(inputType, transfer([], { [FRAGMENT_MIME]: json })))
    } finally {
      warn.mockRestore()
    }
    expect(images(editor.state.doc as Doc)).toHaveLength(0)
    expect(JSON.stringify(editor.getJSON())).not.toContain('javascript:')
  })
})

describe('image HTMLAttributes', () => {
  it('merges attributes into <img>; data-driven attributes win', () => {
    const ed = createTestEditor({
      plugins: [paragraph, image.configure({ HTMLAttributes: { class: 'im', alt: 'x' } })],
      content: '<img src="https://x/a.png" alt="">',
    })
    expect(ed.getHTML()).toBe('<img class="im" alt="" src="https://x/a.png">')
  })

  it('HTMLAttributes cannot override src or bypass safeSrc', () => {
    const attrs = { src: 'javascript:alert(1)', SRC: 'javascript:alert(2)' }
    const ed = createTestEditor({
      plugins: [paragraph, image.configure({ HTMLAttributes: attrs })],
      content: '<img src="https://x/a.png" alt="">',
    })
    expect(ed.getHTML()).toBe('<img src="https://x/a.png" alt="">')
    const raw = doc(el('image', { src: 'javascript:alert(1)', alt: 'x' }))
    expect(serializeHTML(raw, ed.registry, (n) => ed.getPluginOptions(n))).toBe('<img alt="x">')
  })
})

describe('image extend(parent)', () => {
  const rounded = image.extend((parent) => ({
    renderHTML: (n, c) => {
      const out = parent.renderHTML!(n, c) as [string, Record<string, unknown>]
      return [out[0], { ...out[1], class: 'rounded' }]
    },
  }))

  it('wraps renderHTML and keeps the src policy', () => {
    const ed = createTestEditor({ plugins: [paragraph, rounded], content: '<img src="https://x/a.png" alt="">' })
    expect(ed.getHTML()).toBe('<img src="https://x/a.png" alt="" class="rounded">')
    const raw = doc(el('image', { src: 'javascript:alert(1)', alt: 'x' }))
    expect(serializeHTML(raw, ed.registry, (n) => ed.getPluginOptions(n))).toBe('<img alt="x" class="rounded">')
    // The schema still rejects an unsafe src.
    expect(ed.commands.insertImage('javascript:alert(1)')).toBe(false)
    expect(JSON.stringify(ed.getJSON())).not.toContain('javascript:')
  })
})

describe('image with several ranges', () => {
  const caret = (path: number[], offset: number) => ({ anchor: { path, offset }, focus: { path, offset } })

  function setupMulti() {
    const uploads: Deferred[] = []
    const onUploadError = vi.fn()
    const upload = (file: File) =>
      new Promise<string>((resolve, reject) => {
        uploads.push({ file, resolve, reject })
      })
    const editor = createTestEditor({
      plugins: [paragraph, image.configure({ upload, onUploadError })],
      doc: doc(p(txt('ab')), p(txt('cd'))),
      selection: createSelection([caret([0, 0], 2), caret([1, 0], 2)]),
    })
    return { editor, uploads, onUploadError }
  }

  const srcs = (editor: ReturnType<typeof setupMulti>['editor']) => images(editor.state.doc as Doc).map((i) => i.data.src)

  it('insertImage inserts at every range', () => {
    const { editor } = setupMulti()
    expect(editor.commands.insertImage('https://x/a.png', 'alt')).toBe(true)
    expect(srcs(editor)).toEqual(['https://x/a.png', 'https://x/a.png'])
    const ids = images(editor.state.doc as Doc).map((i) => i.id)
    expect(new Set(ids).size).toBe(2)
    expect(editor.commands.undo()).toBe(true)
    expect(images(editor.state.doc as Doc)).toHaveLength(0)
  })

  it('upload with two carets uploads once and finalizes both previews', async () => {
    const { editor, uploads } = setupMulti()
    editor.storage.image.upload([png()])
    expect(uploads).toHaveLength(1)
    expect(created).toHaveLength(1)
    expect(srcs(editor)).toEqual(['blob:test/1', 'blob:test/1'])
    const ids = images(editor.state.doc as Doc).map((i) => i.id)
    expect(new Set(ids).size).toBe(2)
    expect(ids.every((id) => editor.storage.image.isPending(id))).toBe(true)

    uploads[0]!.resolve('https://x/a.png')
    await editor.storage.image.whenIdle()
    expect(srcs(editor)).toEqual(['https://x/a.png', 'https://x/a.png'])
    expect(editor.storage.image.isUploading()).toBe(false)
    expect(ids.some((id) => editor.storage.image.isPending(id))).toBe(false)

    // One undo step, and redo brings back the uploaded URLs.
    expect(editor.commands.undo()).toBe(true)
    expect(images(editor.state.doc as Doc)).toHaveLength(0)
    expect(editor.commands.redo()).toBe(true)
    expect(srcs(editor)).toEqual(['https://x/a.png', 'https://x/a.png'])
  })

  it('upload failure removes both previews; an unrelated later entry survives', async () => {
    const { editor, uploads, onUploadError } = setupMulti()
    const file = png()
    editor.storage.image.upload([file])
    // Typing after the upload started (at both carets) is a later, unrelated history entry.
    editor.handleIntent({ inputType: 'insertText', data: 'x', range: null })
    expect(text(editor.state.doc as Doc)).toBe('abxcdx')
    const err = new Error('boom')
    uploads[0]!.reject(err)
    await editor.storage.image.whenIdle()
    expect(images(editor.state.doc as Doc)).toHaveLength(0)
    expect(onUploadError).toHaveBeenCalledTimes(1)
    expect(onUploadError).toHaveBeenCalledWith(err, file)
    expect(editor.getHTML()).not.toContain('blob:')
    expect(editor.commands.undo()).toBe(true)
    expect(text(editor.state.doc as Doc)).toBe('abcd')
    expect(editor.getHTML()).not.toContain('blob:')
  })

  it('a failure after one copy was deleted clears history, so no blob comes back', async () => {
    const { editor, uploads } = setupMulti()
    editor.storage.image.upload([png()])
    const [first] = images(editor.state.doc as Doc)
    const tr = editor.createTransaction()
    tr.meta.origin = 'command'
    tr.removeNode([(editor.state.doc as Doc).children.findIndex((n) => n.id === first!.id)])
    editor.dispatch(tr)
    uploads[0]!.reject(new Error('boom'))
    await editor.storage.image.whenIdle()
    expect(images(editor.state.doc as Doc)).toHaveLength(0)
    editor.commands.undo()
    editor.commands.redo()
    expect(JSON.stringify(editor.getJSON())).not.toContain('blob:')
  })

  it('a failure after the second copy was deleted also clears history (every copy is tracked)', async () => {
    const { editor, uploads } = setupMulti()
    editor.storage.image.upload([png()])
    const copy = images(editor.state.doc as Doc)[1]!
    const tr = editor.createTransaction()
    tr.meta.origin = 'command'
    tr.removeNode([(editor.state.doc as Doc).children.findIndex((n) => n.id === copy.id)])
    editor.dispatch(tr)
    uploads[0]!.reject(new Error('boom'))
    await editor.storage.image.whenIdle()
    expect(images(editor.state.doc as Doc)).toHaveLength(0)
    expect(editor.commands.undo()).toBe(false)
    editor.commands.redo()
    expect(JSON.stringify(editor.getJSON())).not.toContain('blob:')
  })

  it('a success after the second copy was deleted rewrites it in history', async () => {
    const { editor, uploads } = setupMulti()
    editor.storage.image.upload([png()])
    const copy = images(editor.state.doc as Doc)[1]!
    const tr = editor.createTransaction()
    tr.meta.origin = 'command'
    tr.removeNode([(editor.state.doc as Doc).children.findIndex((n) => n.id === copy.id)])
    editor.dispatch(tr)
    uploads[0]!.resolve('https://x/a.png')
    await editor.storage.image.whenIdle()
    expect(editor.commands.undo()).toBe(true)
    expect(JSON.stringify(editor.getJSON())).not.toContain('blob:')
    expect(srcs(editor)).toEqual(['https://x/a.png', 'https://x/a.png'])
  })

  it('two files with two carets upload twice, each with its own previews', async () => {
    const { editor, uploads } = setupMulti()
    editor.storage.image.upload([png('a.png'), png('b.png')])
    expect(uploads).toHaveLength(2)
    expect(images(editor.state.doc as Doc)).toHaveLength(4)
    uploads[0]!.resolve('https://x/a.png')
    uploads[1]!.resolve('https://x/b.png')
    await editor.storage.image.whenIdle()
    expect(srcs(editor).sort()).toEqual(['https://x/a.png', 'https://x/a.png', 'https://x/b.png', 'https://x/b.png'])
  })

  it('every copy is pending from the first state that shows them', () => {
    const { editor } = setupMulti()
    const seen: string[][] = []
    editor.on('transaction', () => {
      const shown = images(editor.state.doc as Doc).map((i) => i.id)
      if (shown.length > 0) seen.push(shown.filter((id) => !editor.storage.image.isPending(id)))
    })
    editor.storage.image.upload([png()])
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((notPending) => notPending.length === 0)).toBe(true)
  })

  it('an image-file paste targeted at a range that is not the main one goes to that range only', () => {
    const { editor, uploads } = setupMulti()
    editor.handleIntent({ ...intent('insertFromPaste', transfer([png()], {})), range: caret([1, 0], 2) })
    expect(uploads).toHaveLength(1)
    expect((editor.state.doc as Doc).children.map((b) => b.type)).toEqual(['paragraph', 'paragraph', 'image', 'paragraph'])
    // The selection collapsed to that one place, as for any targeted paste.
    expect(editor.state.selection!.ranges).toHaveLength(1)
  })

  it('an image-file paste targeted at the main range goes to every range', () => {
    const { editor } = setupMulti()
    const main = mainRange(editor.state.selection!)
    editor.handleIntent({ ...intent('insertFromPaste', transfer([png()], {})), range: main })
    expect(images(editor.state.doc as Doc)).toHaveLength(2)
  })
})

describe('blob URL lifetime', () => {
  /** The clipboard flavours of the node-selected image at `path` in `editor`. */
  function copyImage(editor: ReturnType<typeof setup>['editor'], path: number[]): DataTransfer {
    const select = editor.createTransaction()
    select.setSelection(nodeSelection(editor.state.doc, editor.registry, path))
    editor.dispatch(select)
    const { json, html, text } = serializeForClipboard(editor, toRange(mainRange(editor.state.selection!)), path)
    const end = editor.createTransaction()
    end.setSelection(sel([0, 0], 2))
    editor.dispatch(end)
    return transfer([], { [FRAGMENT_MIME]: json, 'text/html': html, 'text/plain': text })
  }

  const paste = (editor: ReturnType<typeof setup>['editor'], dt: DataTransfer) => editor.handleIntent(intent('insertFromPaste', dt))
  const json = (editor: ReturnType<typeof setup>['editor']) => JSON.stringify(editor.getJSON())

  it('a preview is revoked once its upload succeeded and every copy shows the uploaded URL', async () => {
    const { editor, uploads } = setup()
    editor.storage.image.upload([png()])
    paste(editor, copyImage(editor, [1]))
    expect(images(editor.state.doc as Doc)).toHaveLength(2)
    expect(revoked).toEqual([])
    uploads[0]!.resolve('https://x/a.png')
    await editor.storage.image.whenIdle()
    expect(revoked).toEqual(['blob:test/1'])
    editor.destroy()
    expect(revoked).toEqual(['blob:test/1'])
  })

  it('a preview is revoked once its upload failed and the images were removed', async () => {
    const { editor, uploads } = setup()
    editor.storage.image.upload([png()])
    uploads[0]!.reject(new Error('boom'))
    await editor.storage.image.whenIdle()
    expect(revoked).toEqual(['blob:test/1'])
  })

  it('a preview history can still bring back is revoked only when history lets go of it', async () => {
    const { editor, uploads } = setup()
    editor.storage.image.upload([png()])
    // The user's own src change: undoing it brings back the preview, so it must stay alive.
    expect(editor.commands.setNodeData([1], { src: 'https://x/other.png' })).toBe(true)
    uploads[0]!.resolve('https://x/a.png')
    await editor.storage.image.whenIdle()
    expect(revoked).toEqual([])
    clearHistory(editor)
    expect(revoked).toEqual(['blob:test/1'])
  })

  it('a copy pasted after the upload succeeded gets the uploaded URL', async () => {
    const { editor, uploads } = setup()
    editor.storage.image.upload([png()])
    const dt = copyImage(editor, [1])
    uploads[0]!.resolve('https://x/a.png')
    await editor.storage.image.whenIdle()
    paste(editor, dt)
    expect(images(editor.state.doc as Doc).map((i) => i.data.src)).toEqual(['https://x/a.png', 'https://x/a.png'])
  })

  it('a copy pasted after the upload failed inserts no image', async () => {
    const { editor, uploads } = setup()
    editor.storage.image.upload([png()])
    const dt = copyImage(editor, [1])
    uploads[0]!.reject(new Error('boom'))
    await editor.storage.image.whenIdle()
    paste(editor, dt)
    expect(images(editor.state.doc as Doc)).toHaveLength(0)
    expect(json(editor)).not.toContain('blob:')
    expect(text(editor.state.doc as Doc)).toBe('ab')
  })

  it.each([FRAGMENT_MIME, 'text/html'])('a pending copy pasted into another editor (%s) inserts no image', (flavour) => {
    const a = setup()
    a.editor.storage.image.upload([png()])
    const dt = copyImage(a.editor, [1])
    const b = setup()
    paste(b.editor, transfer([], { [flavour]: dt.getData(flavour), 'text/plain': dt.getData('text/plain') }))
    expect(images(b.editor.state.doc as Doc)).toHaveLength(0)
    expect(json(b.editor)).not.toContain('blob:')
  })

  it('a blob src an image in the doc already shows is kept when pasted', () => {
    const editor = createTestEditor({
      plugins: [paragraph, image],
      doc: doc(p(txt('ab')), el('image', { src: 'blob:http://app/1', alt: '' })),
      selection: sel([0, 0], 0),
    })
    paste(editor, copyImage(editor, [1]))
    expect(images(editor.state.doc as Doc).map((i) => i.data.src)).toEqual(['blob:http://app/1', 'blob:http://app/1'])
  })

  it('a pending preview src set with setNodeData is tracked: a failure after its removal clears history', async () => {
    const { editor, uploads } = setup()
    const tr = editor.createTransaction()
    tr.insertNode([1], el('image', { src: 'https://x/b.png', alt: 'b' }))
    editor.dispatch(tr)
    editor.storage.image.upload([png()])
    const blob = images(editor.state.doc as Doc)[0]!.data.src
    const other = images(editor.state.doc as Doc).find((i) => i.data.alt === 'b')!
    const at = () => (editor.state.doc as Doc).children.findIndex((n) => n.id === other.id)
    expect(editor.commands.setNodeData([at()], { src: blob })).toBe(true)
    expect(editor.storage.image.isPending(other.id)).toBe(true)
    const remove = editor.createTransaction()
    remove.meta.origin = 'command'
    remove.removeNode([at()])
    editor.dispatch(remove)
    uploads[0]!.reject(new Error('boom'))
    await editor.storage.image.whenIdle()
    while (editor.commands.undo()) expect(json(editor)).not.toContain('blob:')
    expect(revoked).toEqual([blob])
  })

  it('a pending preview src set with setNodeData is tracked: a success after its removal rewrites history', async () => {
    const { editor, uploads } = setup()
    const tr = editor.createTransaction()
    tr.insertNode([1], el('image', { src: 'https://x/b.png', alt: 'b' }))
    editor.dispatch(tr)
    editor.storage.image.upload([png()])
    const blob = images(editor.state.doc as Doc)[0]!.data.src
    const other = images(editor.state.doc as Doc).find((i) => i.data.alt === 'b')!
    const at = () => (editor.state.doc as Doc).children.findIndex((n) => n.id === other.id)
    expect(editor.commands.setNodeData([at()], { src: blob })).toBe(true)
    const remove = editor.createTransaction()
    remove.meta.origin = 'command'
    remove.removeNode([at()])
    editor.dispatch(remove)
    uploads[0]!.resolve('https://x/a.png')
    await editor.storage.image.whenIdle()
    expect(editor.commands.undo()).toBe(true)
    expect(images(editor.state.doc as Doc).find((i) => i.id === other.id)!.data.src).toBe('https://x/a.png')
    expect(revoked).toEqual([blob])
  })
})
