import { z } from 'zod'
import {
  createId,
  definePlugin,
  findPathById,
  getNode,
  isElement,
  isNodeSelection,
  rewriteHistoryData,
  type Command,
  type Data,
  type Editor,
  type PluginContext,
  type Selection,
} from '@hte/core'
import { safeSrc } from './src-policy'

export { safeSrc } from './src-policy'

export interface ImageOptions {
  /** Uploads `file` and resolves with its permanent URL (must pass `safeSrc`). Required for uploads. */
  upload: (file: File) => Promise<string>
  onUploadError: ((error: unknown, file: File) => void) | undefined
}

export interface ImageState {
  /** Ids of the image nodes whose upload has not finished. */
  pending: ReadonlySet<string>
}

/** Meta of the trs that start / end an upload (keyed `imageUpload`). */
export interface ImageUploadMeta {
  start?: string
  end?: string
}

export interface ImageStorage {
  /**
   * Inserts each image file (`type` starting with `image/`; others are skipped) at the selection
   * with a `blob:` preview, as one undo step per file, then uploads it with `options.upload`: on
   * success `src` becomes the uploaded URL outside history (history's stored copies are rewritten
   * too); on failure the image is removed outside history and `onUploadError` is called.
   * Throws when `options.upload` is not set or `URL.createObjectURL` is unavailable.
   */
  upload(files: File[]): void
  /** Whether any upload is pending. */
  isUploading(): boolean
  /** Whether the image node `id` is waiting for its upload. */
  isPending(id: string): boolean
  /** Resolves once no upload is pending (immediately when none is), or when the editor is destroyed. */
  whenIdle(): Promise<void>
}

type Ctx = PluginContext<ImageOptions, ImageState>

/** Per-editor bookkeeping that is not document state. */
interface Runtime {
  destroyed: boolean
  /** Every blob URL created for a preview; revoked on destroy (history may still hold them until then). */
  blobs: Set<string>
  /** `whenIdle` resolvers still waiting. */
  waiters: Set<() => void>
}

const runtimes = new WeakMap<Editor, Runtime>()

function runtimeOf(editor: Editor): Runtime {
  let rt = runtimes.get(editor)
  if (!rt) runtimes.set(editor, (rt = { destroyed: false, blobs: new Set(), waiters: new Set() }))
  return rt
}

const isImageFile = (file: File): boolean => typeof file.type === 'string' && file.type.startsWith('image/')

function pendingOf(ctx: Ctx): ReadonlySet<string> {
  return ctx.getState()?.pending ?? new Set()
}

function dispatchMeta(editor: Editor, meta: ImageUploadMeta): void {
  const tr = editor.createTransaction()
  tr.meta.origin = 'plugin'
  tr.meta.addToHistory = false
  tr.setMeta('imageUpload', meta)
  editor.dispatch(tr)
}

function onUploaded(ctx: Ctx, id: string, blob: string, url: string): void {
  const editor = ctx.editor
  const path = findPathById(editor.state.doc, id)
  if (path) {
    // Only replace our own preview: a src the user set meanwhile wins.
    const node = getNode(editor.state.doc, path)
    if (!isElement(node) || node.data.src !== blob) return
    const tr = editor.createTransaction()
    tr.meta.origin = 'plugin'
    tr.meta.addToHistory = false
    tr.setNodeData(path, { src: url })
    if (tr.rejected === null) editor.dispatch(tr)
  } else {
    // Deleted or undone: patch history's stored copies so redo / undo restores the uploaded URL.
    // Limitation: this merge is unconditional, so a src the user set before removing the image is
    // overwritten in history too.
    rewriteHistoryData(editor, id, { src: url })
  }
}

function onFailed(ctx: Ctx, id: string, file: File, error: unknown): void {
  const editor = ctx.editor
  const path = findPathById(editor.state.doc, id)
  if (path) {
    const tr = editor.createTransaction()
    tr.meta.origin = 'plugin'
    tr.meta.addToHistory = false
    tr.removeNode(path)
    editor.dispatch(tr)
  }
  ctx.options.onUploadError?.(error, file)
}

/** Inserts the preview of each image file and starts its upload. `at` (first file only) overrides the selection. */
function uploadFiles(ctx: Ctx, files: readonly File[], at?: Selection | null): void {
  const images = files.filter(isImageFile)
  if (images.length === 0) return
  const rt = runtimeOf(ctx.editor)
  if (rt.destroyed) return
  const upload = ctx.options.upload
  if (typeof upload !== 'function') throw new Error('@hte/image: options.upload is required to upload images')
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function')
    throw new Error('@hte/image: URL.createObjectURL is not available, so image previews cannot be created')

  for (const [i, file] of images.entries()) {
    const editor = ctx.editor
    const id = createId()
    const blob = URL.createObjectURL(file)
    const tr = editor.createTransaction()
    tr.meta.origin = 'command'
    tr.setMeta('imageUpload', { start: id } satisfies ImageUploadMeta)
    if (i === 0 && at) tr.setSelection(at)
    tr.insertBlockNode({ id, type: ctx.name, data: { src: blob, alt: '' } })
    if (tr.rejected === null && tr.docChanged) editor.dispatch(tr)
    // Not inserted (no selection, rejected or filtered out): nothing to upload into.
    if (!findPathById(editor.state.doc, id)) {
      URL.revokeObjectURL(blob)
      continue
    }
    rt.blobs.add(blob)

    let request: Promise<string>
    try {
      request = Promise.resolve(upload(file))
    } catch (error) {
      request = Promise.reject(error)
    }
    void request
      .then((url) => {
        if (rt.destroyed) return
        if (typeof url !== 'string' || safeSrc(url) === null)
          throw new Error(`@hte/image: upload resolved with an unsafe or invalid URL: ${String(url)}`)
        onUploaded(ctx, id, blob, url)
      })
      .catch((error: unknown) => {
        if (!rt.destroyed) onFailed(ctx, id, file, error)
      })
      .finally(() => {
        if (!rt.destroyed) dispatchMeta(editor, { end: id })
      })
  }
}

function storageOf(ctx: Ctx): ImageStorage {
  return (ctx.editor.storage as Record<string, unknown>)[ctx.name] as ImageStorage
}

export const image = definePlugin({
  name: 'image',
  node: { kind: 'block', atom: true },
  data: z.object({
    src: z.string(),
    alt: z.string().default(''),
    width: z.number().int().positive().optional(),
  }),
  options: { upload: undefined as unknown as ImageOptions['upload'], onUploadError: undefined } as ImageOptions,
  state: {
    init: (): ImageState => ({ pending: new Set<string>() }),
    apply: (tr, prev: ImageState): ImageState => {
      const meta = tr.meta.imageUpload as ImageUploadMeta | undefined
      if (typeof meta !== 'object' || meta === null) return prev
      const pending = new Set(prev.pending)
      if (typeof meta.start === 'string') pending.add(meta.start)
      if (typeof meta.end === 'string') pending.delete(meta.end)
      return { pending }
    },
  },
  parseHTML: [
    {
      tag: 'img',
      getData: (el) => {
        const src = safeSrc(el.getAttribute('src') ?? '')
        if (!src) return false
        const data: Data = { src, alt: el.getAttribute('alt') ?? '' }
        const width = el.getAttribute('width')
        if (width && /^\d+$/.test(width.trim()) && Number(width) > 0) data.width = Number(width)
        return data
      },
    },
  ],
  renderHTML: (n) => {
    const { src, alt, width } = n.data
    return [
      'img',
      {
        src: typeof src === 'string' ? (safeSrc(src) ?? undefined) : undefined,
        alt: typeof alt === 'string' ? alt : '',
        width: typeof width === 'number' ? width : undefined,
      },
    ]
  },
  commands: (ctx) => ({
    insertImage:
      (src: string, alt = ''): Command =>
      ({ tr }) => {
        if (safeSrc(src) === null) return false
        tr.insertBlockNode({ id: createId(), type: ctx.name, data: { src, alt } })
        return tr.rejected === null && tr.docChanged
      },
  }),
  storage: (ctx): ImageStorage => {
    const rt = runtimeOf(ctx.editor)
    return {
      upload: (files) => uploadFiles(ctx, files),
      isUploading: () => pendingOf(ctx).size > 0,
      isPending: (id) => pendingOf(ctx).has(id),
      whenIdle: () =>
        new Promise<void>((resolve) => {
          if (rt.destroyed || pendingOf(ctx).size === 0) return resolve()
          const done = () => {
            off()
            rt.waiters.delete(done)
            resolve()
          }
          const off = ctx.editor.on('transaction', () => {
            if (pendingOf(ctx).size === 0) done()
          })
          rt.waiters.add(done)
        }),
    }
  },
  // Image files in a paste / drop are uploaded and the text / HTML flavours ignored (so a copied
  // picture is not inserted twice); without image files the core default inserts the content.
  onBeforeInput: (intent, ctx) => {
    if (intent.inputType !== 'insertFromPaste' && intent.inputType !== 'insertFromDrop') return false
    const files = Array.from(intent.dataTransfer?.files ?? [])
    if (!files.some(isImageFile)) return false
    if (intent.inputType === 'insertFromDrop' && intent.range && !isNodeSelection(ctx.editor.state.selection))
      uploadFiles(ctx, files, intent.range)
    else storageOf(ctx).upload(files)
    return true
  },
  destroy: (ctx) => {
    const rt = runtimeOf(ctx.editor)
    rt.destroyed = true
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function')
      for (const blob of rt.blobs) URL.revokeObjectURL(blob)
    rt.blobs.clear()
    for (const done of [...rt.waiters]) done()
  },
})
