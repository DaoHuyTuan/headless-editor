/**
 * Image block (`@penline/image`); React view in `@penline/image/react`. The plugin name is `image`.
 *
 * Stable `data-*` attributes (view): `data-penline-image` on the root `<figure>`, `data-selected` when
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
  comparePath,
  mergeAttrs,
  nodeEntries,
  rewriteHistoryData,
  single,
  clearHistory,
  comparePoint,
  getNode,
  isNodeSelection,
  mainRange,
  toRange,
  type Command,
  type Data,
  type DeepReadonly,
  type Doc,
  type Node,
  type Operation,
  type Path,
  type Editor,
  type HTMLAttributes,
  type PluginContext,
  type SelectionRange,
  type Transaction,
} from '@penline/core'
import { isBlobSrc, safeSrc } from './src-policy'

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
  start?: string | readonly string[]
  end?: string | readonly string[]
}

export interface ImageStorage {
  /**
   * Inserts each image file (`type` starting with `image/`; others are skipped) at the selection
   * with a `blob:` preview, as one undo step per file, then uploads it with `options.upload`: with
   * several ranges the file is uploaded once and every range gets a preview (a copy with its own id,
   * all pending and settled together). On
   * success `src` becomes the uploaded URL outside history, on the image and on every copy of it
   * still showing the preview (history's stored copies are rewritten too); on failure the image and
   * its copies are removed outside history (or, when one is no longer in the doc, history is cleared
   * so undo / redo cannot restore the dead preview) and `onUploadError` is called.
   *
   * A copy of a pending preview (a paste, or a `src` set to the preview's URL with `setNodeData`) is
   * pending too and settles with it.
   *
   * Blob URL lifetime: a preview's blob URL is revoked as soon as its upload has settled (succeeded
   * or failed) and neither the doc nor the undo / redo history holds it any more. On success every
   * copy in the doc and in history is rewritten to the uploaded URL, and on failure every copy is
   * removed and the history entries that could bring one back are dropped or cleared, so it is
   * usually revoked right when the upload settles. A history entry can still hold it after that (an
   * undoable `src` change the user made while it was pending): it is then revoked once history lets
   * go of that entry (it is checked after every transaction). Whatever is left is revoked on destroy.
   *
   * Pasting a `blob:` image (see `transformPasted`): a pending preview of this editor is kept, one
   * this editor already uploaded becomes the uploaded URL, and one whose upload failed is dropped. A
   * `blob:` src this editor does not own (a copy from another editor or page, whose owner revokes
   * it) is kept only when an image in the doc already shows it, and dropped otherwise: the image is
   * left out of the pasted content, so no dead preview is inserted.
   *
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
  /** Every blob URL created for a preview and not revoked yet (see `ImageStorage.upload`). */
  blobs: Set<string>
  /** `whenIdle` resolvers still waiting. */
  waiters: Set<() => void>
  /**
   * Per pending preview blob, the ids of every image element that has shown it: the uploaded node
   * and its copies (a copy / paste gives a fresh id). Lets settling reach copies that are only in
   * history (e.g. a pasted copy that was deleted or undone).
   */
  holders: Map<string, Set<string>>
  /** Per settled preview blob, the uploaded URL, or null when the upload failed (for later pastes of a copy). */
  settled: Map<string, string | null>
  /** Settled preview blobs not revoked yet: the doc or history may still hold them. */
  lingering: Set<string>
}

const runtimes = new WeakMap<Editor, Runtime>()

function runtimeOf(editor: Editor): Runtime {
  let rt = runtimes.get(editor)
  if (!rt)
    runtimes.set(
      editor,
      (rt = { destroyed: false, blobs: new Set(), waiters: new Set(), holders: new Map(), settled: new Map(), lingering: new Set() }),
    )
  return rt
}

const isImageFile = (file: File): boolean => typeof file.type === 'string' && file.type.startsWith('image/')

function pendingOf(ctx: Ctx): ReadonlySet<string> {
  return ctx.getState()?.pending ?? new Set()
}

/** Ids of the `type` elements in `doc` whose `src` is in `srcs`. */
function showing(doc: DeepReadonly<Doc>, type: string, srcs: { has(src: string): boolean }): string[] {
  const ids: string[] = []
  for (const [node] of nodeEntries(doc))
    if (isElement(node) && node.type === type && typeof node.data.src === 'string' && srcs.has(node.data.src)) ids.push(node.id)
  return ids
}

/** `node` and every node inside it. */
function* selfAndDescendants(node: Node): Generator<Node> {
  yield node
  if (isElement(node)) for (const [n] of nodeEntries(node)) yield n as Node
}

/** Whether one of `ops` gives an element a pending preview's src (an insert, or a `set_node_data`). */
function copiesPending(rt: Runtime, ops: readonly Operation[]): boolean {
  if (rt.holders.size === 0) return false
  const pending = (data: Data) => typeof data.src === 'string' && rt.holders.has(data.src)
  return ops.some(
    (op) =>
      (op.type === 'set_node_data' && pending(op.data)) ||
      (op.type === 'insert_node' && [...selfAndDescendants(op.node)].some((n) => isElement(n) && pending(n.data))),
  )
}

/**
 * Records the image elements `ops` gave a pending preview's src (copies of an uploading image): the
 * inserted ones (also when the same tr removed them again), and the ones now showing it in `doc`.
 */
function trackCopies(ctx: Ctx, rt: Runtime, ops: readonly Operation[], doc: DeepReadonly<Doc>): void {
  if (!copiesPending(rt, ops)) return
  for (const blob of rt.holders.keys()) {
    const holders = rt.holders.get(blob)!
    for (const op of ops)
      if (op.type === 'insert_node')
        for (const n of selfAndDescendants(op.node)) if (isElement(n) && n.type === ctx.name && n.data.src === blob) holders.add(n.id)
    for (const id of showing(doc, ctx.name, new Set([blob]))) holders.add(id)
  }
}

/** Every string in `value` (walked deeply) that is in `wanted`. */
function heldStrings(value: unknown, wanted: ReadonlySet<string>, out: Set<string>, seen = new Set<object>()): void {
  if (typeof value === 'string') {
    if (wanted.has(value)) out.add(value)
    return
  }
  if (typeof value !== 'object' || value === null || seen.has(value) || out.size === wanted.size) return
  seen.add(value)
  for (const v of value instanceof Map || value instanceof Set ? value.values() : Object.values(value)) heldStrings(v, wanted, out, seen)
}

/**
 * Revokes each settled preview blob that neither the doc nor the history state holds any more. The
 * history state is searched as plain data (whatever its shape), so a stored op that could bring the
 * preview back keeps it alive.
 */
function sweep(editor: Editor, rt: Runtime): void {
  if (rt.lingering.size === 0 || rt.destroyed) return
  const held = new Set<string>()
  heldStrings(editor.state.doc, rt.lingering, held)
  heldStrings(editor.getPluginState('history'), rt.lingering, held)
  for (const blob of [...rt.lingering]) {
    if (held.has(blob)) continue
    rt.lingering.delete(blob)
    rt.blobs.delete(blob)
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(blob)
  }
}

/** What a pasted image's `src` becomes (see `ImageStorage.upload`): itself, the uploaded URL, or null to drop the image. */
function pastedSrc(ctx: Ctx, rt: Runtime, src: string): string | null {
  if (!isBlobSrc(src) || rt.holders.has(src)) return src
  const uploaded = rt.settled.get(src)
  if (uploaded !== undefined) return uploaded
  return showing(ctx.editor.state.doc, ctx.name, new Set([src])).length > 0 ? src : null
}

/** `nodes` with every pasted image's src mapped by `pastedSrc` (images it drops left out); the same array when nothing changed. */
function mapPasted(ctx: Ctx, rt: Runtime, nodes: readonly Node[]): Node[] {
  let changed = false
  const out: Node[] = []
  for (const node of nodes) {
    let next: Node | null = node
    if (isElement(node) && node.type === ctx.name && typeof node.data.src === 'string') {
      const src = pastedSrc(ctx, rt, node.data.src)
      next = src === null ? null : src === node.data.src ? node : { ...node, data: { ...node.data, src } }
    } else if (isElement(node) && node.children) {
      const children = mapPasted(ctx, rt, node.children)
      if (children !== node.children) next = { ...node, children }
    }
    if (next !== node) changed = true
    if (next) out.push(next)
  }
  return changed ? out : (nodes as Node[])
}

/** Whether `a` and `b` cover the same span. */
function sameSpan(a: SelectionRange, b: SelectionRange): boolean {
  const x = toRange(a)
  const y = toRange(b)
  return comparePoint(x.start, y.start) === 0 && comparePoint(x.end, y.end) === 0
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
  console.error('@penline/image:', error)
}

/** Whether `node` is an element holding only empty texts. */
function isEmptyBlock(node: Node | undefined): boolean {
  return !!node && isElement(node) && (node.children ?? []).every((c) => !isElement(c) && c.text === '')
}

/**
 * `added`: ids of the blocks the preview's insert created around it (the empty block a caret at the
 * end of the last block goes to); removed with the preview while they are still empty.
 */
function onFailed(ctx: Ctx, ids: ReadonlySet<string>, blob: string, file: File, error: unknown, added: readonly string[]): void {
  const editor = ctx.editor
  try {
    // One deleted, undone, or given another src (checked before the removal below, which takes every
    // id out of the doc): history still holds the blob preview, which will never be uploaded, so
    // undo / redo must not bring it back. Otherwise every stored copy is in the doc, and the removal
    // below maps history through itself: the steps that inserted a preview can't be rebased over its
    // removal and are dropped (with every entry below them), while later unrelated steps stay undoable.
    const missing = [...ids].some((id) => {
      const path = findPathById(editor.state.doc, id)
      const node = path && getNode(editor.state.doc, path)
      return !node || !isElement(node) || node.data.src !== blob
    })
    // The preview and every copy of it, and the empty blocks its insert added: removed outside
    // history (deepest / last first, so the earlier paths stay valid). The doc keeps one block.
    const paths: Path[] = []
    for (const [node, path] of nodeEntries(editor.state.doc))
      if (isElement(node) && node.type === ctx.name && node.data.src === blob) paths.push(path)
    if (paths.length > 0) {
      for (const id of added) {
        const path = findPathById(editor.state.doc, id)
        if (path && isEmptyBlock(getNode(editor.state.doc, path) as Node)) paths.push(path)
      }
      paths.sort((a, b) => comparePath(b, a))
      const tr = editor.createTransaction()
      tr.meta.origin = 'plugin'
      tr.meta.addToHistory = false
      const sel = tr.selection
      const inside = (p: Path) => paths.some((r) => r.every((v, k) => p[k] === v))
      for (const path of paths) if (tr.doc.children.length > 1) tr.removeNode(path)
      // A caret in a removed empty block goes to the end of the text before it (texts before the
      // first removed path keep their paths).
      if (sel && tr.selection === null) {
        let end: { path: Path; offset: number } | null = null
        for (const [node, path] of nodeEntries(editor.state.doc))
          if (!isElement(node) && !inside(path) && comparePath(path, paths[paths.length - 1]!) < 0) end = { path, offset: node.text.length }
        if (end) tr.setSelection(single({ anchor: end, focus: end }))
      }
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
function uploadFiles(ctx: Ctx, files: readonly File[], at?: SelectionRange | null): void {
  const images = files.filter(isImageFile)
  if (images.length === 0) return
  const rt = runtimeOf(ctx.editor)
  if (rt.destroyed) return
  const upload = ctx.options.upload
  if (typeof upload !== 'function') throw new Error('@penline/image: options.upload is required to upload images')
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function')
    throw new Error('@penline/image: URL.createObjectURL is not available, so image previews cannot be created')

  for (const [i, file] of images.entries()) {
    const editor = ctx.editor
    const id = createId()
    const blob = URL.createObjectURL(file)
    const tr = editor.createTransaction()
    tr.meta.origin = 'command'
    if (i === 0 && at) tr.setSelection(single(at))
    tr.insertBlockNode({ id, type: ctx.name, data: { src: blob, alt: '' } })
    // Every preview the insert made (with several ranges the copies got fresh ids), pending in the
    // same state that first shows them.
    const started = showing(tr.doc, ctx.name, new Set([blob]))
    tr.setMeta('imageUpload', { start: started } satisfies ImageUploadMeta)
    // Empty blocks the insert created (for the caret after the preview), to remove with it on failure.
    const added = tr.ops.flatMap((op) =>
      op.type === 'insert_node' && isElement(op.node) && op.node.type !== ctx.name && isEmptyBlock(op.node) ? [op.node.id] : [],
    )
    if (tr.rejected === null && tr.docChanged) editor.dispatch(tr)
    // Every preview this file made, as committed (a follow-up tr may have changed them): all of them
    // are tracked as holders of this upload.
    const holders = new Set(showing(editor.state.doc, ctx.name, new Set([blob])))
    const unstarted = [...holders].filter((h) => !started.includes(h))
    // Not inserted (no selection, rejected or filtered out): nothing to upload into.
    if (holders.size === 0) {
      const stale = started.filter((h) => pendingOf(ctx).has(h))
      if (stale.length > 0) dispatchMeta(editor, { end: stale })
      URL.revokeObjectURL(blob)
      continue
    }
    rt.blobs.add(blob)
    rt.holders.set(blob, holders)
    if (unstarted.length > 0) dispatchMeta(editor, { start: unstarted })

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
          const ok = typeof url === 'string' && safeSrc(url) !== null
          rt.settled.set(blob, ok ? url : null)
          rt.lingering.add(blob)
          if (!ok)
            onFailed(
              ctx,
              holders,
              blob,
              file,
              new Error(`@penline/image: upload resolved with an unsafe or invalid URL: ${String(url)}`),
              added,
            )
          else onUploaded(ctx, holders, blob, url)
        },
        (error: unknown) => {
          rt.holders.delete(blob)
          if (rt.destroyed) return
          rt.settled.set(blob, null)
          rt.lingering.add(blob)
          onFailed(ctx, holders, blob, file, error, added)
        },
      )
      // A throw while applying a successful upload is reported, not treated as an upload failure.
      .catch(report)
      .finally(() => {
        if (rt.destroyed) return
        dispatchMeta(editor, { end: [...new Set([...holders, ...started])] })
        // Usually revoked right here: the settle rewrote or removed every copy (see `ImageStorage.upload`).
        sweep(editor, rt)
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
    // Pending: the ids an `imageUpload` meta starts, until one ends them, plus every copy a tr makes
    // of a pending preview (a paste, or `setNodeData` with its src), which its upload's end covers.
    // `ctx` typed structurally: a contextually typed one would stop `storage` from inferring.
    apply: (tr: Transaction, prev: ImageState, ctx: { editor: Editor; name: string }): ImageState => {
      const meta = tr.meta.imageUpload as ImageUploadMeta | undefined
      const rt = runtimeOf(ctx.editor)
      const copies = copiesPending(rt, tr.ops) ? showing(tr.doc, ctx.name, rt.holders).filter((id) => !prev.pending.has(id)) : []
      if ((typeof meta !== 'object' || meta === null) && copies.length === 0) return prev
      const pending = new Set([...prev.pending, ...copies])
      if (typeof meta === 'object' && meta !== null) {
        for (const id of typeof meta.start === 'string' ? [meta.start] : (meta.start ?? [])) pending.add(id)
        for (const id of typeof meta.end === 'string' ? [meta.end] : (meta.end ?? [])) pending.delete(id)
      }
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
        // Only a plain positive safe integer becomes `width` (what the schema accepts); anything else
        // (units, exponents, zero, beyond `Number.MAX_SAFE_INTEGER`) is ignored and the image kept.
        const width = el.getAttribute('width')?.trim()
        const n = width && /^\d+$/.test(width) ? Number(width) : 0
        if (Number.isSafeInteger(n) && n > 0) data.width = n
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
    ctx.editor.on('transaction', ({ tr }) => {
      trackCopies(ctx, rt, tr.ops, ctx.editor.state.doc)
      sweep(ctx.editor, rt)
    })
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
    const sel = ctx.editor.state.selection
    // A drop goes to its drop point, even while a node is selected (it never replaces that node). A
    // paste targeted at a range that is not the main one goes only there (the selection collapses
    // to it), like the core's targeted paste; otherwise a paste goes to every range.
    if (intent.inputType === 'insertFromDrop' && intent.range) uploadFiles(ctx, files, intent.range)
    else if (sel && intent.range && sel.ranges.length > 1 && !isNodeSelection(sel) && !sameSpan(intent.range, mainRange(sel)))
      uploadFiles(ctx, files, intent.range)
    else ctx.storage.upload(files)
    return true
  },
  // A pasted / dropped `blob:` image keeps its src only while it is live (see `ImageStorage.upload`).
  transformPasted: (fragment, ctx) => mapPasted(ctx, runtimeOf(ctx.editor), fragment),
  destroy: (ctx) => {
    const rt = runtimeOf(ctx.editor)
    rt.destroyed = true
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function')
      for (const blob of rt.blobs) URL.revokeObjectURL(blob)
    rt.blobs.clear()
    for (const done of [...rt.waiters]) done()
  },
})
