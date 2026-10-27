import { corePlugin } from './core-plugin'
import { historyPlugin } from './history'
import { normalizeKeyName, type Platform } from './keymap'
import { coerceDoc } from './load'
import { deepEqualJson, getNode, isElement, textEntries } from './model/node'
import { comparePoint } from './model/path'
import type { Data, Doc, ElementNode, Json, Selection } from './model/types'
import { normalize } from './normalize'
import { Registry } from './plugin/registry'
import type { AnyPlugin, Command, CommandsOf, InputIntent, PluginContext } from './plugin/types'
import type { EditorState } from './state'
import { Transaction } from './transaction/transaction'

export interface EditorOptions<P extends readonly AnyPlugin[] = readonly AnyPlugin[]> {
  plugins: P
  content?: Doc | string
  selection?: Selection
  /** Default true: prepends the history plugin. */
  history?: boolean
  /** Throws on rejected transactions instead of dropping them. */
  dev?: boolean
  platform?: Platform
}

export type EditorEventName = 'transaction' | 'update' | 'selectionUpdate'
export interface EditorEvent {
  editor: Editor
  tr: Transaction
}

/** Placeholder; the DOM view arrives in Task 18. */
export interface EditorView {
  destroy(): void
}

/** Built-in plugins followed by the user's plugins. */
export type EditorPlugins<P extends readonly AnyPlugin[]> = [typeof corePlugin, typeof historyPlugin, ...P]

/** Command factories turned into callables that run the command and return whether it applied. */
export type BoundCommands<C> = {
  [K in keyof C]: C[K] extends (...args: infer A) => Command ? (...args: A) => boolean : never
}

export type EditorCommands<P extends readonly AnyPlugin[]> = BoundCommands<CommandsOf<EditorPlugins<P>>>

interface Committed {
  tr: Transaction
  selectionChanged: boolean
}

const MAX_APPEND_ROUNDS = 10
const HTML_UNAVAILABLE = 'HTML import/export is not available yet'
const VIEW_UNAVAILABLE = 'View is not available yet'

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other'
  const nav = navigator as { platform?: string; userAgent?: string }
  return /Mac/.test(nav.platform ?? '') || /Mac/.test(nav.userAgent ?? '') ? 'mac' : 'other'
}

function selectionEquals(a: Selection | null, b: Selection | null): boolean {
  if (a === null || b === null) return a === b
  return deepEqualJson(a as unknown as Json, b as unknown as Json)
}

function firstTextSelection(d: Doc): Selection | null {
  for (const [, path] of textEntries(d)) return { anchor: { path, offset: 0 }, focus: { path, offset: 0 } }
  return null
}

export class Editor<const P extends readonly AnyPlugin[] = AnyPlugin[]> {
  readonly registry: Registry
  readonly commands: EditorCommands<P>
  readonly view: EditorView | null = null

  private _state: EditorState
  private readonly dev: boolean
  private readonly platform: Platform
  private readonly pluginOptions = new Map<string, Record<string, unknown>>()
  private readonly contexts = new Map<string, PluginContext<any, any>>()
  private readonly commandFactories = new Map<string, (...args: unknown[]) => Command>()
  private readonly keymaps: { plugin: AnyPlugin; bindings: Map<string, () => boolean> }[] = []
  private readonly listeners = new Map<EditorEventName, Set<(e: EditorEvent) => void>>()
  private destroyed = false
  /** True while `dispatch` runs the pipeline (before events are emitted). */
  private computing = false

  constructor(options: EditorOptions<P>) {
    this.dev = options.dev ?? false
    this.platform = options.platform ?? detectPlatform()
    const plugins: AnyPlugin[] = [corePlugin, ...(options.history === false ? [] : [historyPlugin]), ...options.plugins]
    this.registry = new Registry(plugins)

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
      const factories = plugin.spec.commands?.(ctx) ?? {}
      for (const [name, factory] of Object.entries(factories)) {
        if (!this.commandFactories.has(name)) this.commandFactories.set(name, factory as (...args: unknown[]) => Command)
      }
      const keymap = plugin.spec.keymap?.(ctx)
      if (keymap) {
        const bindings = new Map<string, () => boolean>()
        for (const [key, fn] of Object.entries(keymap)) bindings.set(normalizeKeyName(key, this.platform), fn)
        this.keymaps.push({ plugin, bindings })
      }
    }
    this.commands = this.bindCommands(true)
  }

  get state(): EditorState {
    return this._state
  }

  createTransaction(): Transaction {
    return new Transaction(this._state, this.registry)
  }

  can(): EditorCommands<P> {
    return this.bindCommands(false)
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

  on(event: EditorEventName, fn: (e: EditorEvent) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) this.listeners.set(event, (set = new Set()))
    set.add(fn)
    return () => {
      set.delete(fn)
    }
  }

  getJSON(): Doc {
    return this._state.doc
  }

  getHTML(): string {
    throw new Error(HTML_UNAVAILABLE)
  }

  /** Replaces the document; the caret goes to the start of the first text. Not added to history. */
  setContent(content: Doc | string): void {
    const tr = this.contentTransaction(content)
    this.dispatch(tr)
  }

  /** Marks: not yet supported (Task 10). Elements: the block containing the selection start. */
  isActive(type: string, data?: Partial<Data>): boolean {
    if (this.registry.mark(type)) return false
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

  setPluginOptions(name: string, partial: Record<string, unknown>): void {
    this.requirePlugin(name)
    this.pluginOptions.set(name, { ...this.pluginOptions.get(name), ...partial })
  }

  mount(_el: HTMLElement): void {
    throw new Error(VIEW_UNAVAILABLE)
  }

  unmount(): void {
    throw new Error(VIEW_UNAVAILABLE)
  }

  destroy(): void {
    this.destroyed = true
    this.listeners.clear()
  }

  // --- internals ---

  private requirePlugin(name: string): void {
    if (!this.pluginOptions.has(name)) throw new Error(`Unknown plugin "${name}"`)
  }

  private getContext(plugin: AnyPlugin): PluginContext<any, any> {
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
      }
      this.contexts.set(plugin.name, ctx)
    }
    return ctx
  }

  private readonly contextFn = (plugin: AnyPlugin) => this.getContext(plugin)

  /** A normalized tr that replaces the whole document with `content`. */
  private contentTransaction(content: Doc | string, selection?: Selection): Transaction {
    if (typeof content === 'string') throw new Error(HTML_UNAVAILABLE)
    const doc = coerceDoc(content, this.registry)
    const tr = this.createTransaction()
    tr.meta.origin = 'load'
    tr.meta.addToHistory = false
    tr.setSelection(null)
    for (let i = tr.doc.children.length - 1; i >= 0; i--) tr.removeNode([i])
    doc.children.forEach((node, i) => tr.insertNode([i], node))
    if (selection) tr.setSelection(selection)
    normalize(tr, this.contextFn)
    if (!tr.selection) tr.setSelection(firstTextSelection(tr.doc))
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
      if (spec) pluginStates.set(plugin.name, spec.apply(tr, prev.pluginStates.get(plugin.name)))
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

  private bindCommands(dispatch: boolean): EditorCommands<P> {
    const out: Record<string, (...args: unknown[]) => boolean> = {}
    for (const [name, factory] of this.commandFactories) {
      out[name] = (...args: unknown[]) => {
        const tr = this.createTransaction()
        tr.meta.origin = 'command'
        const ok = factory(...args)({ tr, state: this._state, editor: this as unknown as Editor })
        if (ok && dispatch && (tr.ops.length > 0 || tr.storedMarks !== this._state.storedMarks)) this.dispatch(tr)
        return ok
      }
    }
    return out as EditorCommands<P>
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
