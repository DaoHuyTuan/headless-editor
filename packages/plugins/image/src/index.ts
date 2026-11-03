/**
 * Image block (`@hte/image`); React view in `@hte/image/react`. The plugin name is `image`.
 *
 * Stable `data-*` attributes (view): `data-hte-image` on the root `<figure>`, `data-selected` when
 * node-selected, `data-uploading` while its upload is pending. HTML output is a plain `<img>` (no
 * `data-*`); `options.HTMLAttributes` is merged first, so `src`, `alt` and `width` always win.
 *
 * Parts (`parts` / `classNames` keys, `classNames.root` too): `img`, `altInput`, `resizeHandle`.
 * Parts and hooks are @experimental. See docs/plugin-authoring.md.
 */
import { z } from 'zod'
import {
  createId,
  definePlugin,
  findPathById,
  isElement,
  isNodeSelection,
  mergeAttrs,
  nodeEntries,
  rewriteHistoryData,
  clearHistory,
  type Command,
  type Data,
  type Node,
  type Operation,
  type Path,
  type Editor,
  type HTMLAttributes,
  type PluginContext,
  type Selection,
} from '@hte/core'
import { safeSrc } from './src-policy'

export { safeSrc } from './src-policy'

/** The `data` of an image node. */
export interface ImageData {
  src: string
  alt: string
  width?: number
}

export interface ImageOptions {
  /** Uploads `file` and resolves with its permanent URL (must pass `safeSrc`). Required for uploads. */
  upload: (file: File) => Promise<string>
  onUploadError: ((error: unknown, file: File) => void) | undefined
  /** Extra attributes merged into the `<img>`. */
  HTMLAttributes: HTMLAttributes
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
   * success `src` becomes the uploaded URL outside history, on the image and on every copy of it
   * still showing the preview (history's stored copies are rewritten too); on failure the image and
   * its copies are removed outside history (or, when one is no longer in the doc, history is cleared
   * so undo / redo cannot restore the dead preview) and `onUploadError` is called.
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
  /**
   * Per pending preview blob, the ids of every image element that has shown it: the uploaded node
   * and its copies (a copy / paste gives a fresh id). Lets settling reach copies that are only in
   * history (e.g. a pasted copy that was deleted or undone).
   */
  holders: Map<string, Set<string>>
}

const runtimes = new WeakMap<Editor, Runtime>()

function runtimeOf(editor: Editor): Runtime {
  let rt = runtimes.get(editor)
  if (!rt) runtimes.set(editor, (rt = { destroyed: false, blobs: new Set(), waiters: new Set(), holders: new Map() }))
  return rt
}

const isImageFile = (file: File): boolean => typeof file.type === 'string' && file.type.startsWith('image/')

function pendingOf(ctx: Ctx): ReadonlySet<string> {
  return ctx.getState()?.pending ?? new Set()
}

/** Records the image elements `tr` inserted that show a pending preview (copies of an uploading image). */
function trackCopies(ctx: Ctx, rt: Runtime, ops: readonly Operation[]): void {
  if (rt.holders.size === 0) return
  const note = (node: Node) => {
    if (!isElement(node) || node.type !== ctx.name) return
    const src = node.data.src
    if (typeof src === 'string') rt.holders.get(src)?.add(node.id)
  }
  for (const op of ops) {
    if (op.type !== 'insert_node') continue
    note(op.node)
    if (isElement(op.node)) for (const [n] of nodeEntries(op.node)) note(n)
  }
}

function dispatchMeta(editor: Editor, meta: ImageUploadMeta): void {
  const tr = editor.createTransaction()
  tr.meta.origin = 'plugin'
  tr.meta.addToHistory = false
  tr.setMeta('imageUpload', meta)
  editor.dispatch(tr)
}

function onUploaded(ctx: Ctx, ids: ReadonlySet<string>, blob: string, url: string): void {
  const editor = ctx.editor
  // Every image still showing our preview: the uploaded node and any copy of it (a copy / paste
  // gives it a fresh id). A src the user set meanwhile wins, since only `src === blob` is replaced.
  const tr = editor.createTransaction()
  tr.meta.origin = 'plugin'
  tr.meta.addToHistory = false
  for (const [node, path] of nodeEntries(editor.state.doc)) {
    if (isElement(node) && node.type === ctx.name && node.data.src === blob) tr.setNodeData(path, { src: url })
  }
  // One data-only tr: history rewrites its stored copies of these elements as well.
  if (tr.docChanged && tr.rejected === null) editor.dispatch(tr)
  for (const id of ids) {
    if (findPathById(editor.state.doc, id)) continue
    // Deleted or undone: patch history's stored copies so redo / undo restores the uploaded URL.
    // Limitation: this merge is unconditional, so a src the user set before removing the image is
    // overwritten in history too.
    rewriteHistoryData(editor, id, { src: url })
  }
}

/**
 * Errors thrown by the editor or app code while settling an upload (a throwing listener, a throwing
 * `onUploadError`) are reported with `console.error`, never left as unhandled rejections and never
 * turned into an upload failure.
 */
function report(error: unknown): void {
  console.error('@hte/image:', error)
}

function onFailed(ctx: Ctx, ids: ReadonlySet<string>, blob: string, file: File, error: unknown): void {
  const editor = ctx.editor
  try {
    // One deleted or undone (checked before the removal below, which takes every id out of the doc):
    // history still holds the blob preview, which will never be uploaded, so undo / redo must not
    // bring it back. Otherwise every stored copy is in the doc, and the removal below maps history
    // through itself: the steps that inserted a preview can't be rebased over its removal and are
    // dropped (with every entry below them), while later unrelated steps stay undoable.
    const missing = [...ids].some((id) => !findPathById(editor.state.doc, id))
    // The preview and every copy of it: removed outside history (deepest / last first, so the
    // earlier paths stay valid).
    const paths: Path[] = []
    for (const [node, path] of nodeEntries(editor.state.doc))
      if (isElement(node) && node.type === ctx.name && node.data.src === blob) paths.push(path)
    if (paths.length > 0) {
      const tr = editor.createTransaction()
      tr.meta.origin = 'plugin'
      tr.meta.addToHistory = false
      for (const path of paths.reverse()) tr.removeNode(path)
      editor.dispatch(tr)
    }
    if (missing) clearHistory(editor)
  } catch (e) {
    report(e)
  }
  try {
    ctx.options.onUploadError?.(error, file)
  } catch (e) {
    report(e)
  }
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
    const holders = new Set([id])
    rt.holders.set(blob, holders)

    let request: Promise<string>
    try {
      request = Promise.resolve(upload(file))
    } catch (error) {
      request = Promise.reject(error)
    }
    void request
      .then(
        (url) => {
          if (rt.destroyed) return
          rt.holders.delete(blob)
          if (typeof url !== 'string' || safeSrc(url) === null)
            onFailed(
              ctx,
              holders,
              blob,
              file,
              new Error(`@hte/image: upload resolved with an unsafe or invalid URL: ${String(url)}`),
            )
          else onUploaded(ctx, holders, blob, url)
        },
        (error: unknown) => {
          rt.holders.delete(blob)
          if (!rt.destroyed) onFailed(ctx, holders, blob, file, error)
        },
      )
      // A throw while applying a successful upload is reported, not treated as an upload failure.
      .catch(report)
      .finally(() => {
        if (!rt.destroyed) dispatchMeta(editor, { end: id })
      })
      .catch(report)
  }
}

export const image = definePlugin({
  name: 'image',
  node: { kind: 'block', atom: true },
  data: z.object({
    // The src policy is part of the schema: unsafe srcs never reach stored data (loads / pastes drop
    // the node with a warning, `setNodeData` / `updateData` are rejected).
    src: z.string().refine((src) => safeSrc(src) !== null, 'Unsafe image src'),
    alt: z.string().default(''),
    width: z.number().int().positive().optional(),
  }),
  options: { upload: undefined as unknown as ImageOptions['upload'], onUploadError: undefined, HTMLAttributes: {} } as ImageOptions,
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
  renderHTML: (n, { options }) => {
    const { src, alt, width } = n.data
    return [
      'img',
      // Data-driven attributes last: HTMLAttributes can never override (or bypass the policy of) src.
      mergeAttrs(options.HTMLAttributes, {
        src: typeof src === 'string' ? (safeSrc(src) ?? undefined) : undefined,
        alt: typeof alt === 'string' ? alt : '',
        width: typeof width === 'number' ? width : undefined,
      }),
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
    ctx.editor.on('transaction', ({ tr }) => trackCopies(ctx, rt, tr.ops))
    return {
      upload: (files) => uploadFiles(ctx, files),
      isUploading: () => !rt.destroyed && pendingOf(ctx).size > 0,
      isPending: (id) => !rt.destroyed && pendingOf(ctx).has(id),
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
    // Without an upload function there is nowhere to put the files: let the default insert the rest.
    if (!files.some(isImageFile) || typeof ctx.options.upload !== 'function') return false
    if (intent.inputType === 'insertFromDrop' && intent.range && !isNodeSelection(ctx.editor.state.selection))
      uploadFiles(ctx, files, intent.range)
    else ctx.storage.upload(files)
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
