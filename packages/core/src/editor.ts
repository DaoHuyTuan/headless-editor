import { corePlugin } from './core-plugin'
import { historyPlugin } from './history'
import { normalizeKeyName, type Platform } from './keymap'
import { parseHTML } from './html/parse'
import { serializeHTML } from './html/serialize'
import { runInputRules } from './input-rules'
import { coerceDoc } from './load'
import { firstEditableCaret, isEditableRange, rehomeRanges } from './model/editable'
import { deepEqualJson, getNode, isElement } from './model/node'
import { comparePoint } from './model/path'
import { mainRange, selectionEquals } from './model/selection'
import type { Data, Doc, ElementNode, Point, Selection, SelectionRange } from './model/types'
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
import type { Decoration } from './view/decorations'
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
   * `NodeViewFactory`). A non-atom type's view also gets a `contentDOM` holding its children.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nodeViews?: Record<string, NodeViewFactory<any, any, any, any>>
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

/**
 * `navigator.platform` names the OS whose keyboard conventions the user has; the user agent is
 * only a fallback, since it is spoofed more often (Playwright's "Desktop Safari" device sends a Mac
 * user agent from a Windows host, whose keyboard sends Ctrl).
 */
function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other'
  const nav = navigator as { platform?: string; userAgent?: string }
  if (nav.platform) return /Mac|iPhone|iPad|iPod/.test(nav.platform) ? 'mac' : 'other'
  return /Mac/.test(nav.userAgent ?? '') ? 'mac' : 'other'
}

/** Rethrows the first collected error, if any. */
/** Trs `contentTransaction` already normalized: the pipeline doesn't normalize them again. */
const normalizedContent = new WeakSet<Transaction>()

function throwFirst(errors: unknown[]): void {
  if (errors.length > 0) throw errors[0]
}

export class Editor<const P extends readonly AnyPlugin[] = AnyPlugin[]> {
  readonly registry: Registry
  readonly commands: EditorCommands<P>
  readonly storage: EditorStorage<P>
  private _view: EditorView | null = null

  private _state: EditorState
  /** The `dev` option (default false): bugs throw instead of being dropped, and dev-only warnings are on. */
  readonly dev: boolean
  private readonly platform: Platform
  private readonly pluginOptions = new Map<string, Record<string, unknown>>()
  private readonly contexts = new Map<string, PluginContext<any, any, any, any>>()
  private readonly commandFactories = new Map<string, AnyCommandFactory>()
  private readonly keymaps: { plugin: AnyPlugin; bindings: Map<string, () => boolean> }[] = []
  private readonly listeners = new Map<EditorEventName | 'options', Set<(e: any) => void>>()
  private readonly nodeViews = new Map<string, NodeViewFactory<any, any, any, any>>()
  /** `editor.storage`, filled as each plugin's storage factory returns (read by `ctx.storage`). */
  private readonly storages: Record<string, unknown> = {}
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
    }
    this.commands = this.bindCommands(this.commandFactories, true) as EditorCommands<P>

    // Storage is created once all commands are bound, so factories may use ctx.commands.
    for (const plugin of this.registry.plugins) {
      if (plugin.spec.storage) this.storages[plugin.name] = plugin.spec.storage(this.getContext(plugin))
    }
    this.storage = this.storages as EditorStorage<P>

    // Keymaps are collected last, so a keymap factory may read ctx.storage eagerly.
    for (const plugin of this.registry.plugins) {
      const keymap = plugin.spec.keymap?.(this.getContext(plugin))
      if (keymap) {
        const bindings = new Map<string, () => boolean>()
        for (const [key, fn] of Object.entries(keymap)) bindings.set(normalizeKeyName(key, this.platform), fn)
        this.keymaps.push({ plugin, bindings })
      }
    }

    const createErrors = this.runHooks((plugin, ctx) => plugin.spec.onCreate?.(ctx))
    if (createErrors.length > 0) {
      // The caller never gets this editor: destroy it now, so what the hooks set up is released.
      // Destroy errors are dropped; the onCreate error is the one to report.
      try {
        this.destroy()
      } catch {
        // ignored
      }
      throwFirst(createErrors)
    }
  }

  /** The mounted DOM view, or null when not mounted. */
  get view(): EditorView | null {
    return this._view
  }

  get state(): EditorState {
    return this._state
  }

  createTransaction(): Transaction {
    return new Transaction(this._state, this.registry, { dev: this.dev })
  }

  /**
   * Commands that answer whether they would apply (rejected trs and `filterTransaction` vetoes
   * included) without dispatching. Not covered: while the pipeline is computing or after `destroy()`
   * a real dispatch is dropped, yet `can()` still answers as if it would apply.
   */
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
      // How history treats the appended trs: an undo/redo root → 'history'; a recorded root → 'record'
      // (both join the root's entry); a root kept out of history → appended trs stay out too.
      const appendedTo =
        tr.meta.origin === 'history' ? 'history' : tr.docChanged && tr.meta.addToHistory !== false ? 'record' : null
      const outside = appendedTo === null && tr.meta.addToHistory === false
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
          if (appendedTo) next.meta.appendedTo = appendedTo
          else if (outside) next.meta.addToHistory = false
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
    // Listener and lifecycle hook errors are collected over the whole loop, so one throw stops neither
    // the other listeners and hooks nor the events of later trs; the first is rethrown at the end.
    const errors: unknown[] = []
    for (const { tr: t, selectionChanged } of committed) {
      errors.push(...this.emit('transaction', t))
      if (t.docChanged) {
        errors.push(...this.emit('update', t))
        errors.push(...this.runHooks((plugin, ctx) => plugin.spec.onUpdate?.(ctx, { tr: t })))
      }
      if (selectionChanged) {
        errors.push(...this.emit('selectionUpdate', t))
        errors.push(...this.runHooks((plugin, ctx) => plugin.spec.onSelectionUpdate?.(ctx, { tr: t })))
      }
    }
    throwFirst(errors)
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

  /**
   * Runs the plugins' input rules against the text before the caret (called by the core after it
   * inserted text from an `insertText` intent). True when a rule fired.
   */
  runInputRules(): boolean {
    return runInputRules(this, this.contextFn)
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

  /**
   * Called by the view at the end of its constructor: runs every plugin's `onMount` by priority.
   * Returns the cleanups the hooks returned (in call order) and the errors they threw; the view
   * decides what to do with both.
   */
  handleMount(view: EditorView): { cleanups: (() => void)[]; errors: unknown[] } {
    const cleanups: (() => void)[] = []
    const errors = this.runHooks((plugin, ctx) => {
      const cleanup = plugin.spec.onMount?.(ctx, view)
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    })
    return { cleanups, errors }
  }

  /** Called by the view when focus enters its root: runs every plugin's `onFocus` by priority. */
  handleFocus(event: FocusEvent): void {
    throwFirst(this.runHooks((plugin, ctx) => plugin.spec.onFocus?.(ctx, event)))
  }

  /** Called by the view when focus leaves its root: runs every plugin's `onBlur` by priority. */
  handleBlur(event: FocusEvent): void {
    throwFirst(this.runHooks((plugin, ctx) => plugin.spec.onBlur?.(ctx, event)))
  }

  /**
   * Every plugin's `decorations` for `state`, by priority (what the view draws on its next render).
   * A hook that throws is reported with `console.error` and contributes nothing: the view still renders.
   */
  getDecorations(state: EditorState): Decoration[] {
    const out: Decoration[] = []
    for (const plugin of this.registry.plugins) {
      const hook = plugin.spec.decorations
      if (!hook) continue
      try {
        out.push(...hook(state, this.getContext(plugin)))
      } catch (error) {
        console.error(`[hte] The decorations hook of "${plugin.name}" threw; its decorations are skipped:`, error)
      }
    }
    return out
  }

  /**
   * Runs each plugin's `transformPasted` on `fragment`, by priority, with `at`: where the fragment
   * will be inserted (a drop's drop point, or one range of a multi-range paste, which calls this once
   * per range); omitted or null, at the selection (read `at ?? mainRange(state.selection)`).
   *
   * A transform that throws is skipped (the fragment goes on as it was before it) and its error is
   * reported with `console.error`: by then the browser's paste is already prevented, so a throw must
   * not lose the paste. The other transforms still run.
   */
  transformPasted(fragment: Fragment, at: SelectionRange | null = null): Fragment {
    const info = { at }
    for (const plugin of this.registry.plugins) {
      const transform = plugin.spec.transformPasted
      if (!transform) continue
      try {
        fragment = transform(fragment, this.getContext(plugin), info)
      } catch (error) {
        console.error(`@hte/core: transformPasted of plugin "${plugin.name}" threw; it was skipped`, error)
      }
    }
    return fragment
  }

  /**
   * Subscribes to an editor event; returns the unsubscribe function. Events of a dispatch run after
   * its state is committed. A listener may dispatch (a nested dispatch, committed at once): later
   * listeners and hooks of the outer tr then see `editor.state` already past it, so read what the
   * outer tr changed from `e.tr`, not by comparing with `editor.state`. A throwing listener does not
   * stop the others; its error is rethrown once the dispatch's events all ran.
   */
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

  /**
   * True only when every selection range has it (spec §5.4). Marks: `isMarkActive`. Elements: per
   * range, the block containing the range's start. `data` entries must deep-equal the node's; an
   * `undefined` entry is ignored, like a missing key.
   */
  isActive(type: string, data?: Partial<Data>): boolean {
    if (this.registry.mark(type)) return isMarkActive(this._state, type, data, this.registry)
    const sel = this._state.selection
    if (!sel) return false
    return sel.ranges.every((range) => {
      const start = comparePoint(range.anchor, range.focus) <= 0 ? range.anchor : range.focus
      const block = this.blockAt(start.path)
      if (!block || block.type !== type) return false
      if (!data) return true
      return Object.entries(data).every(([k, v]) => v === undefined || (k in block.data && deepEqualJson(block.data[k]!, v)))
    })
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

  /**
   * Viewport coordinates of `point` in the mounted view (left, top, bottom), or null when unmounted,
   * not rendered, not placed in the root yet, or not laid out (see `EditorView.coordsAt`).
   */
  coordsAt(point: Point): { left: number; top: number; bottom: number } | null {
    return this._view?.coordsAt(point) ?? null
  }

  /** Removes the view's listeners (the rendered content stays). Idempotent. */
  unmount(): void {
    const view = this._view
    this._view = null
    view?.destroy()
  }

  /**
   * Unmounts, then runs every plugin's `destroy` hook in reverse priority order. A throwing hook
   * does not stop the others; once all ran, its error is rethrown, or with several, an
   * `AggregateError` of all of them (in run order, its message naming the first). Idempotent,
   * including when called again from a destroy hook (the nested call returns immediately).
   */
  destroy(): void {
    if (this.destroyed || this.destroying) return
    this.destroying = true
    const errors: unknown[] = []
    try {
      this.unmount()
    } catch (error) {
      errors.push(error)
    }
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
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      const first = errors[0] instanceof Error ? errors[0].message : String(errors[0])
      throw new AggregateError(errors, `${errors.length} destroy hooks failed; the first: ${first}`)
    }
  }

  // --- internals ---

  private requirePlugin(name: string): void {
    if (!this.pluginOptions.has(name)) throw new Error(`Unknown plugin "${name}"`)
  }

  /**
   * Cached per plugin. `commands` starts empty and is filled once the plugin's commands are collected;
   * `storage` is undefined until the plugin's storage factory returned.
   */
  private getContext(plugin: AnyPlugin): PluginContext<any, any, any, any> {
    let ctx = this.contexts.get(plugin.name)
    if (!ctx) {
      const options = this.pluginOptions
      const storages = this.storages
      const editor = this as unknown as Editor
      ctx = {
        editor,
        name: plugin.name,
        get options() {
          return options.get(plugin.name)
        },
        getState: () => this._state.pluginStates.get(plugin.name),
        get storage() {
          return storages[plugin.name]
        },
        commands: {},
      }
      this.contexts.set(plugin.name, ctx)
    }
    return ctx
  }

  private readonly contextFn = (plugin: AnyPlugin) => this.getContext(plugin)

  /**
   * Calls `fn` for each plugin by priority, collecting what it throws instead of stopping. Stops
   * (without error) once the editor is destroyed, e.g. by an earlier hook.
   */
  private runHooks(fn: (plugin: AnyPlugin, ctx: PluginContext<any, any, any, any>) => void): unknown[] {
    const errors: unknown[] = []
    for (const plugin of this.registry.plugins) {
      if (this.destroyed || this.destroying) break
      try {
        fn(plugin, this.getContext(plugin))
      } catch (error) {
        errors.push(error)
      }
    }
    return errors
  }

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
    // A missing selection, or a single range that does not resolve to editable text, starts at the
    // first editable text. With several ranges, each bad range moves to its nearest editable point
    // (`rehomeRanges`); the first editable text only when none is left.
    const sel = tr.selection
    if (sel && sel.ranges.length > 1) {
      const next = rehomeRanges(tr.doc, this.registry, sel) ?? firstEditableCaret(tr.doc, this.registry)
      if (next !== sel) tr.setSelection(next)
    } else if (!sel || !isEditableRange(tr.doc, this.registry, mainRange(sel))) {
      tr.setSelection(firstEditableCaret(tr.doc, this.registry))
    }
    normalizedContent.add(tr)
    return tr
  }

  /** Steps 1–4 of the dispatch pipeline (events are emitted by `dispatch`). Null when dropped. */
  private applyTransaction(tr: Transaction): Committed | null {
    if (tr.rejected) {
      if (this.dev) throw new Error(tr.rejected)
      return null
    }
    if (tr.before !== this._state) {
      const message = 'Transaction was created from an outdated state'
      if (this.dev) throw new Error(message)
      // Dropped: a stale tr would overwrite the changes made since it was created.
      console.warn(`@hte/core: ${message}; it was dropped`)
      return null
    }
    if (!this.passesFilters(tr)) return null
    if (tr.docChanged && !normalizedContent.has(tr)) normalize(tr, this.contextFn)
    // Several ranges: each one not at an editable point moves to its nearest one (dropped only when
    // there is none). Applied as an op so stored marks are kept. A single range is left as it was.
    const sel = tr.selection
    if (sel && sel.ranges.length > 1) {
      const next = rehomeRanges(tr.doc, this.registry, sel)
      if (next && next !== sel) tr.apply({ type: 'set_selection', selection: next, prevSelection: sel })
    }

    const prev = this._state
    const pluginStates = new Map(prev.pluginStates)
    for (const plugin of this.registry.plugins) {
      const spec = plugin.spec.state
      if (spec) pluginStates.set(plugin.name, spec.apply(tr, prev.pluginStates.get(plugin.name), this.getContext(plugin)))
    }
    this._state = { doc: tr.doc, selection: tr.selection, storedMarks: tr.storedMarks, pluginStates }
    return { tr, selectionChanged: !selectionEquals(prev.selection, tr.selection) }
  }

  /** Runs every plugin's `filterTransaction` in plugin order; false on the first veto. */
  private passesFilters(tr: Transaction): boolean {
    for (const plugin of this.registry.plugins) {
      if (plugin.spec.filterTransaction && !plugin.spec.filterTransaction(tr, this._state)) return false
    }
    return true
  }

  /** Calls every listener of `event`; returns what they threw (a throw does not skip the others). */
  private emit(event: EditorEventName, tr: Transaction): unknown[] {
    const set = this.listeners.get(event)
    if (!set) return []
    const e: EditorEvent = { editor: this as unknown as Editor, tr }
    const errors: unknown[] = []
    for (const fn of [...set]) {
      try {
        fn(e)
      } catch (error) {
        errors.push(error)
      }
    }
    return errors
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
        const changes = tr.ops.length > 0 || tr.storedMarks !== this._state.storedMarks
        // can(): answers what the command would do, filters included, without dispatching (no
        // appendTransaction, normalize, state apply or events).
        if (!dispatch) return ok && (!changes || (tr.rejected === null && this.passesFilters(tr)))
        if (ok && changes) {
          const before = this._state
          this.dispatch(tr)
          // Dropped by the pipeline (a `filterTransaction` veto, or a dispatch that is not allowed
          // now): the command did not apply.
          if (this._state === before) return false
        }
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
