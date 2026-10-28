import { corePlugin } from './core-plugin'
import { historyPlugin } from './history'
import { normalizeKeyName, type Platform } from './keymap'
import { parseHTML } from './html/parse'
import { serializeHTML } from './html/serialize'
import { coerceDoc } from './load'
import { firstEditableCaret, isEditablePoint, isOpaqueAt } from './model/editable'
import { deepEqualJson, getNode, isElement } from './model/node'
import { comparePoint } from './model/path'
import type { Data, Doc, ElementNode, Json, Selection } from './model/types'
import { normalize } from './normalize'
import { Registry } from './plugin/registry'
import type {
  AnyPlugin,
  BoundCommands,
  Command,
  CommandsOf,
  DOMEventName,
  InputIntent,
  NodeViewFactory,
  PluginContext,
  StorageOf,
} from './plugin/types'
import type { EditorState } from './state'
import type { Fragment } from './transaction/fragment'
import { isMarkActive } from './transaction/marks'
import { Transaction } from './transaction/transaction'
import { EditorView } from './view/view'

export interface EditorOptions<P extends readonly AnyPlugin[] = readonly AnyPlugin[]> {
  plugins: P
  content?: Doc | string
  selection?: Selection
  /** Default true: prepends the history plugin. */
  history?: boolean
  /** Throws on rejected transactions instead of dropping them. */
  dev?: boolean
  platform?: Platform
  /**
   * Node views keyed by node type: the renderer mounts each into a container it creates (see
   * `NodeViewFactory`). Atom types only in M2; a non-atom type throws.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nodeViews?: Record<string, NodeViewFactory<any, any>>
}

export type EditorEventName = 'transaction' | 'update' | 'selectionUpdate'
/** Payload of the `'options'` event, emitted by `setPluginOptions`. */
export interface OptionsEvent {
  editor: Editor
  plugin: string
}
export interface EditorEvent {
  editor: Editor
  tr: Transaction
}

/** Built-in plugins followed by the user's plugins. */
export type EditorPlugins<P extends readonly AnyPlugin[]> = [typeof corePlugin, typeof historyPlugin, ...P]

export type { BoundCommands } from './plugin/types'

type AnyCommandFactory = (...args: unknown[]) => Command

export type EditorCommands<P extends readonly AnyPlugin[]> = BoundCommands<CommandsOf<EditorPlugins<P>>>

/** `editor.storage`: each plugin's storage keyed by plugin name (plugins without storage are absent). */
export type EditorStorage<P extends readonly AnyPlugin[]> = StorageOf<EditorPlugins<P>>

interface Committed {
  tr: Transaction
  selectionChanged: boolean
}

const MAX_APPEND_ROUNDS = 10

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other'
  const nav = navigator as { platform?: string; userAgent?: string }
  return /Mac/.test(nav.platform ?? '') || /Mac/.test(nav.userAgent ?? '') ? 'mac' : 'other'
}

function selectionEquals(a: Selection | null, b: Selection | null): boolean {
  if (a === null || b === null) return a === b
  return deepEqualJson(a as unknown as Json, b as unknown as Json)
}

export class Editor<const P extends readonly AnyPlugin[] = AnyPlugin[]> {
  readonly registry: Registry
  readonly commands: EditorCommands<P>
  readonly storage: EditorStorage<P>
  private _view: EditorView | null = null

  private _state: EditorState
  private readonly dev: boolean
  private readonly platform: Platform
  private readonly pluginOptions = new Map<string, Record<string, unknown>>()
  private readonly contexts = new Map<string, PluginContext<any, any, any>>()
  private readonly commandFactories = new Map<string, AnyCommandFactory>()
  private readonly keymaps: { plugin: AnyPlugin; bindings: Map<string, () => boolean> }[] = []
  private readonly listeners = new Map<EditorEventName | 'options', Set<(e: any) => void>>()
  private readonly nodeViews = new Map<string, NodeViewFactory<any, any>>()
  private destroyed = false
  /** Set while `destroy()` runs its hooks, so a re-entrant call returns at once. */
  private destroying = false
  /** True while `dispatch` runs the pipeline (before events are emitted). */
  private computing = false

  constructor(options: EditorOptions<P>) {
    this.dev = options.dev ?? false
    this.platform = options.platform ?? detectPlatform()
    const plugins: AnyPlugin[] = [corePlugin, ...(options.history === false ? [] : [historyPlugin]), ...options.plugins]
    this.registry = new Registry(plugins)
    for (const [type, factory] of Object.entries(options.nodeViews ?? {})) {
      const registered = this.registry.node(type)
      if (!registered) throw new Error(`Unknown node type "${type}" in nodeViews`)
      if (!registered.atom) throw new Error('Non-atom node views arrive in M3')
      this.nodeViews.set(type, factory)
    }

    const pluginStates = new Map<string, unknown>()
    for (const plugin of this.registry.plugins) {
      this.pluginOptions.set(plugin.name, { ...(plugin.spec.options ?? {}) })
      if (plugin.spec.state) pluginStates.set(plugin.name, plugin.spec.state.init())
    }

    this._state = { doc: { type: 'doc', children: [] }, selection: null, storedMarks: null, pluginStates }
    const tr = this.contentTransaction(options.content ?? { type: 'doc', children: [] }, options.selection)
    this._state = { ...this._state, doc: tr.doc, selection: tr.selection }

    // Commands and keymaps are collected once; higher-priority plugins win name clashes.
    for (const plugin of this.registry.plugins) {
      const ctx = this.getContext(plugin)
      const factories = Object.entries((plugin.spec.commands?.(ctx) ?? {}) as Record<string, AnyCommandFactory>)
      for (const [name, factory] of factories) {
        if (!this.commandFactories.has(name)) this.commandFactories.set(name, factory)
      }
      // The plugin's own commands, bound to its own factories (not the editor-wide clash winner).
      Object.assign(ctx.commands, this.bindCommands(factories, true))
      const keymap = plugin.spec.keymap?.(ctx)
      if (keymap) {
        const bindings = new Map<string, () => boolean>()
        for (const [key, fn] of Object.entries(keymap)) bindings.set(normalizeKeyName(key, this.platform), fn)
        this.keymaps.push({ plugin, bindings })
      }
    }
    this.commands = this.bindCommands(this.commandFactories, true) as EditorCommands<P>

    // Storage is created once all commands are bound, so factories may use ctx.commands.
    const storage: Record<string, unknown> = {}
    for (const plugin of this.registry.plugins) {
      if (plugin.spec.storage) storage[plugin.name] = plugin.spec.storage(this.getContext(plugin))
    }
    this.storage = storage as EditorStorage<P>
  }

  /** The mounted DOM view, or null when not mounted. */
  get view(): EditorView | null {
    return this._view
  }

  get state(): EditorState {
    return this._state
  }

  createTransaction(): Transaction {
    return new Transaction(this._state, this.registry)
  }

  can(): EditorCommands<P> {
    return this.bindCommands(this.commandFactories, false) as EditorCommands<P>
  }

  /**
   * Runs the pipeline for `tr` and every appendTransaction round, committing state as it goes,
   * then emits events for each committed tr in order (listeners see the final state).
   * Dispatching from a listener is a normal nested dispatch; dispatching while the pipeline is
   * computing (filter/append/state.apply/normalize hooks) throws in dev and is dropped otherwise.
   */
  dispatch(tr: Transaction): void {
    if (this.destroyed) return
    if (this.computing) {
      if (this.dev) throw new Error('Cannot dispatch during transaction processing')
      return
    }
    const committed: Committed[] = []
    this.computing = true
    try {
      const before = this._state
      const first = this.applyTransaction(tr)
      if (!first) return
      committed.push(first)
      let pending = [tr]
      let roundBefore = before
      for (let round = 0; round < MAX_APPEND_ROUNDS && pending.length > 0; round++) {
        const appended: Transaction[] = []
        const roundStart = this._state
        for (const plugin of this.registry.plugins) {
          const append = plugin.spec.appendTransaction
          if (!append) continue
          const next = append(pending, roundBefore, this._state)
          if (!next) continue
          if (next.meta.origin === undefined) next.meta.origin = 'plugin'
          const done = this.applyTransaction(next)
          if (done) {
            committed.push(done)
            appended.push(next)
          }
        }
        pending = appended
        roundBefore = roundStart
      }
    } finally {
      this.computing = false
    }
    for (const { tr: t, selectionChanged } of committed) {
      this.emit('transaction', t)
      if (t.docChanged) this.emit('update', t)
      if (selectionChanged) this.emit('selectionUpdate', t)
    }
  }

  runKeymap(keyName: string): boolean {
    const key = normalizeKeyName(keyName, this.platform)
    for (const { bindings } of this.keymaps) {
      const fn = bindings.get(key)
      if (fn && fn()) return true
    }
    return false
  }

  /** Asks each plugin's `onBeforeInput` by priority; the core plugin (priority 0) supplies the defaults. */
  handleIntent(intent: InputIntent): boolean {
    for (const plugin of this.registry.plugins) {
      const handler = plugin.spec.onBeforeInput
      if (handler && handler(intent, this.getContext(plugin))) return true
    }
    return false
  }

  /** Asks each plugin's `handleDOMEvents[type]` by priority; true when one of them handled `event`. */
  handleDOMEvent(type: DOMEventName, event: Event): boolean {
    for (const plugin of this.registry.plugins) {
      const handler = plugin.spec.handleDOMEvents?.[type]
      if (handler && handler(event, this.getContext(plugin))) return true
    }
    return false
  }

  /** The node view factory registered for the node `type` (`EditorOptions.nodeViews`), if any. */
  nodeViewFactory(type: string): NodeViewFactory | undefined {
    return this.nodeViews.get(type)
  }

  /** Asks the `stopEvent` hook of `node`'s plugin whether the editor must ignore `event` (inside its node view). */
  handleStopEvent(event: Event, node: ElementNode): boolean {
    const plugin = this.registry.node(node.type)?.plugin
    const hook = plugin?.spec.stopEvent
    return !!plugin && !!hook && hook(event, node, this.getContext(plugin))
  }

  /**
   * Whether a DOM mutation inside `node`'s node view is ignored: the `ignoreMutation` hook of its
   * plugin decides; without one it is.
   */
  handleIgnoreMutation(record: MutationRecord, node: ElementNode): boolean {
    const plugin = this.registry.node(node.type)?.plugin
    const hook = plugin?.spec.ignoreMutation
    return !plugin || !hook || hook(record, node, this.getContext(plugin))
  }

  /** Runs each plugin's `transformPasted` on `fragment`, by priority. */
  transformPasted(fragment: Fragment): Fragment {
    for (const plugin of this.registry.plugins) {
      const transform = plugin.spec.transformPasted
      if (transform) fragment = transform(fragment, this.getContext(plugin))
    }
    return fragment
  }

  on(event: 'options', fn: (e: OptionsEvent) => void): () => void
  on(event: EditorEventName, fn: (e: EditorEvent) => void): () => void
  on(event: EditorEventName | 'options', fn: (e: any) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) this.listeners.set(event, (set = new Set()))
    set.add(fn)
    return () => {
      set.delete(fn)
    }
  }

  /** A deep copy of the document: changing it never affects the editor. */
  getJSON(): Doc {
    return structuredClone(this._state.doc) as Doc
  }

  /** Serializes the document with the plugins' current options (no DOM needed). */
  getHTML(): string {
    return serializeHTML(this._state.doc, this.registry, (name) => this.pluginOptions.get(name))
  }

  /** Replaces the document; the caret goes to the start of the first editable text. Not added to history. */
  setContent(content: Doc | string): void {
    const tr = this.contentTransaction(content)
    this.dispatch(tr)
  }

  /** Marks: `isMarkActive` on the selection. Elements: the block containing the selection start. */
  isActive(type: string, data?: Partial<Data>): boolean {
    if (this.registry.mark(type)) return isMarkActive(this._state, type, data, this.registry)
    const sel = this._state.selection
    if (!sel) return false
    const start = comparePoint(sel.anchor, sel.focus) <= 0 ? sel.anchor : sel.focus
    const block = this.blockAt(start.path)
    if (!block || block.type !== type) return false
    if (!data) return true
    return Object.entries(data).every(([k, v]) => v !== undefined && k in block.data && deepEqualJson(block.data[k]!, v))
  }

  getPluginState<S = unknown>(name: string): S {
    this.requirePlugin(name)
    return this._state.pluginStates.get(name) as S
  }

  /** A frozen shallow copy of the plugin's current options (its defaults merged with every `setPluginOptions` call). */
  getPluginOptions<O = Record<string, unknown>>(name: string): O {
    this.requirePlugin(name)
    return Object.freeze({ ...this.pluginOptions.get(name) }) as O
  }

  setPluginOptions(name: string, partial: Record<string, unknown>): void {
    this.requirePlugin(name)
    this.pluginOptions.set(name, { ...this.pluginOptions.get(name), ...partial })
    const set = this.listeners.get('options')
    if (!set) return
    const e: OptionsEvent = { editor: this as unknown as Editor, plugin: name }
    for (const fn of [...set]) fn(e)
  }

  /** Renders into `el` and listens to it. No-op when already mounted on `el`; moves off any other element. */
  mount(el: HTMLElement): void {
    if (this.destroyed) throw new Error('Cannot mount a destroyed editor')
    if (this._view?.root === el) return
    this.unmount()
    this._view = new EditorView(this as unknown as Editor, el)
  }

  /** Removes the view's listeners (the rendered content stays). Idempotent. */
  unmount(): void {
    const view = this._view
    this._view = null
    view?.destroy()
  }

  /**
   * Unmounts, then runs every plugin's `destroy` hook in reverse priority order. A throwing hook
   * does not stop the others; the first error is rethrown once all ran. Idempotent, including when
   * called again from a destroy hook (the nested call returns immediately).
   */
  destroy(): void {
    if (this.destroyed || this.destroying) return
    this.destroying = true
    this.unmount()
    const errors: unknown[] = []
    for (const plugin of [...this.registry.plugins].reverse()) {
      const hook = plugin.spec.destroy
      if (!hook) continue
      try {
        hook(this.getContext(plugin))
      } catch (error) {
        errors.push(error)
      }
    }
    this.destroyed = true
    this.listeners.clear()
    if (errors.length > 0) throw errors[0]
  }

  // --- internals ---

  private requirePlugin(name: string): void {
    if (!this.pluginOptions.has(name)) throw new Error(`Unknown plugin "${name}"`)
  }

  /** Cached per plugin. `commands` starts empty and is filled once the plugin's commands are collected. */
  private getContext(plugin: AnyPlugin): PluginContext<any, any, any> {
    let ctx = this.contexts.get(plugin.name)
    if (!ctx) {
      const options = this.pluginOptions
      const editor = this as unknown as Editor
      ctx = {
        editor,
        name: plugin.name,
        get options() {
          return options.get(plugin.name)
        },
        getState: () => this._state.pluginStates.get(plugin.name),
        commands: {},
      }
      this.contexts.set(plugin.name, ctx)
    }
    return ctx
  }

  private readonly contextFn = (plugin: AnyPlugin) => this.getContext(plugin)

  /** A normalized tr that replaces the whole document with `content`. */
  private contentTransaction(content: Doc | string, selection?: Selection): Transaction {
    const raw = typeof content === 'string' ? { type: 'doc', children: parseHTML(content, this.registry) } : content
    const doc = coerceDoc(raw, this.registry)
    const tr = this.createTransaction()
    tr.meta.origin = 'load'
    tr.meta.addToHistory = false
    tr.setSelection(null)
    for (let i = tr.doc.children.length - 1; i >= 0; i--) tr.removeNode([i])
    doc.children.forEach((node, i) => tr.insertNode([i], node))
    if (selection) tr.setSelection(selection)
    normalize(tr, this.contextFn)
    // A missing selection, or one that does not resolve to editable text, starts at the first editable text.
    const sel = tr.selection
    const valid =
      sel &&
      isEditablePoint(tr.doc, this.registry, sel.anchor) &&
      isEditablePoint(tr.doc, this.registry, sel.focus) &&
      (!sel.node || isOpaqueAt(tr.doc, this.registry, sel.node))
    if (!valid) tr.setSelection(firstEditableCaret(tr.doc, this.registry))
    return tr
  }

  /** Steps 1–4 of the dispatch pipeline (events are emitted by `dispatch`). Null when dropped. */
  private applyTransaction(tr: Transaction): Committed | null {
    if (tr.rejected) {
      if (this.dev) throw new Error(tr.rejected)
      return null
    }
    if (tr.before !== this._state) {
      if (this.dev) throw new Error('Transaction was created from an outdated state')
      return null
    }
    for (const plugin of this.registry.plugins) {
      if (plugin.spec.filterTransaction && !plugin.spec.filterTransaction(tr, this._state)) return null
    }
    if (tr.docChanged) normalize(tr, this.contextFn)

    const prev = this._state
    const pluginStates = new Map(prev.pluginStates)
    for (const plugin of this.registry.plugins) {
      const spec = plugin.spec.state
      if (spec) pluginStates.set(plugin.name, spec.apply(tr, prev.pluginStates.get(plugin.name), this.getContext(plugin)))
    }
    this._state = { doc: tr.doc, selection: tr.selection, storedMarks: tr.storedMarks, pluginStates }
    return { tr, selectionChanged: !selectionEquals(prev.selection, tr.selection) }
  }

  private emit(event: EditorEventName, tr: Transaction): void {
    const set = this.listeners.get(event)
    if (!set) return
    const e: EditorEvent = { editor: this as unknown as Editor, tr }
    for (const fn of [...set]) fn(e)
  }

  private bindCommands(
    factories: Iterable<[string, AnyCommandFactory]>,
    dispatch: boolean,
  ): Record<string, (...args: unknown[]) => boolean> {
    const out: Record<string, (...args: unknown[]) => boolean> = {}
    for (const [name, factory] of factories) {
      out[name] = (...args: unknown[]) => {
        const tr = this.createTransaction()
        tr.meta.origin = 'command'
        const ok = factory(...args)({ tr, state: this._state, editor: this as unknown as Editor })
        if (ok && dispatch && (tr.ops.length > 0 || tr.storedMarks !== this._state.storedMarks)) this.dispatch(tr)
        return ok
      }
    }
    return out
  }

  /** The nearest block-level element on `path` (unknown element types count as blocks). */
  private blockAt(path: number[]): ElementNode | null {
    for (let depth = path.length - 1; depth >= 1; depth--) {
      const node = getNode(this._state.doc, path.slice(0, depth))
      if (isElement(node) && this.registry.node(node.type)?.kind !== 'inline') return node
    }
    return null
  }
}
