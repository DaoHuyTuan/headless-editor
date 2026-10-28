// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FRAGMENT_MIME, nodeSelection, serializeForClipboard, toRange, type Doc, type ElementNode, type InputIntent } from '@hte/core'
import { createTestEditor, doc, el, sel, txt } from '@hte/core/testing'
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
    editor.handleIntent({ ...intent('insertFromDrop', transfer([png()], {})), range: sel([0, 0], 0) })
    expect((editor.state.doc as Doc).children[0]!.type).toBe('image')
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

  it('serializes an unsafe stored src without the src attribute', () => {
    const editor = createTestEditor({
      plugins: [paragraph, image],
      doc: doc(el('image', { src: 'javascript:alert(1)', alt: 'x', width: 5 })),
    })
    expect(editor.getHTML()).toBe('<img alt="x" width="5">')
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
  const { json, html, text } = serializeForClipboard(editor, toRange(selected), path)
  const end = editor.createTransaction()
  end.setSelection(sel([0, 0], 2))
  editor.dispatch(end)
  editor.handleIntent(intent('insertFromPaste', transfer([], { [FRAGMENT_MIME]: json, 'text/html': html, 'text/plain': text })))
}

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
