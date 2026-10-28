import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Data, DeepReadonly, ElementNode, Node, Path, Selection } from '../model/types'
import type { Transaction } from '../transaction/transaction'
import type { EditorState } from '../state'
import type { Editor } from '../editor'
import type { Fragment } from '../transaction/fragment'
import type { EditorView } from '../view/view'

/** `0` marks the content hole. */
export type DOMOutputSpec =
  | string
  | 0
  | [
      tag: string,
      attrs?: Record<string, string | number | undefined> | DOMOutputSpec,
      ...children: DOMOutputSpec[],
    ]

export interface MarkDOM {
  tag: string
  attrs?: Record<string, string>
  style?: Record<string, string>
}

export interface ParseRule {
  tag?: string
  style?: string
  priority?: number
  getData?: (el: HTMLElement, styleValue?: string) => Data | false
}

export interface InputIntent {
  inputType: string
  data: string | null
  range: Selection | null
  dataTransfer?: DataTransfer | null
}

export type Command = (props: { tr: Transaction; state: EditorState; editor: Editor }) => boolean

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CommandFactory = (...args: any[]) => Command
export type CommandMap = Record<string, CommandFactory>

/** Options type used when a plugin declares none. */
export type NoOptions = Record<never, never>

/** Command factories turned into callables that run the command and return whether it applied. */
export type BoundCommands<C> = {
  [K in keyof C]: C[K] extends (...args: infer A) => Command ? (...args: A) => boolean : never
}

export interface PluginContext<O, S, C extends CommandMap = NoOptions> {
  editor: Editor
  name: string
  readonly options: O
  getState(): S
  /**
   * This plugin's own commands, bound like `editor.commands` (fresh tr with origin `command`,
   * dispatched when it applies). Always this plugin's factories, even when a higher-priority
   * plugin registered a command with the same name.
   */
  readonly commands: BoundCommands<C>
}

export interface NodeSpec {
  kind: 'block' | 'inline'
  atom?: boolean
  default?: boolean
  content?: 'inline' | 'text'
}

/**
 * Marks render from their data only: `render(data)` must not read plugin options, and mark plugins
 * have no invalidation, so an options change never re-renders existing marked text.
 */
export interface MarkSpec<D = Data> {
  render: (data: D) => MarkDOM
}

export type DOMEventName = 'keydown' | 'beforeinput' | 'input'

/** What a node view gets: the current node, whether it is node-selected, and ways to read and change it. */
export interface NodeViewProps<D = Data, O = unknown> {
  /** The current model node. */
  node: DeepReadonly<ElementNode> & { readonly data: DeepReadonly<D> }
  /** Whether the node is node-selected. */
  selected: boolean
  editor: Editor
  /** The node plugin's current options. */
  options: O
  /** The node's path in the current doc (looked up by id), or null when it is no longer in the doc. */
  getPos(): Path | null
  /**
   * Merges `partial` into the node's data in a fresh tr (origin `command`) and dispatches it.
   * False when the node is gone or the change was rejected.
   */
  updateData(partial: Partial<D>): boolean
}

export interface NodeViewInstance<D = Data, O = unknown> {
  /** Called when the node's data, its `selected` state or the plugin's options change. */
  update(props: NodeViewProps<D, O>): void
  /** Called once, when the node leaves the doc or the view is destroyed. */
  destroy(): void
}

/**
 * Renders a node into `container` (created by the renderer: `<div>` for a block, `<span>` for an
 * inline node, `contenteditable="false"`). Called once per element id; the container is never rebuilt
 * for a data change. Elements inside it marked `data-editor-ignore` are fully left to the view.
 */
export type NodeViewFactory<D = Data, O = unknown> = (
  container: HTMLElement,
  props: NodeViewProps<D, O>,
) => NodeViewInstance<D, O>

export interface PluginSpec<
  Name extends string = string,
  D = Data,
  O = NoOptions,
  C extends CommandMap = NoOptions,
  S = undefined,
  T = undefined,
> {
  name: Name
  /** Default 100; higher runs first. */
  priority?: number
  node?: NodeSpec
  mark?: MarkSpec<D>
  data?: StandardSchemaV1<unknown, D>
  options?: O
  /** Gets a context without `C` (its own commands) to avoid circular inference. */
  commands?: (ctx: PluginContext<O, S>) => C
  keymap?: (ctx: PluginContext<O, S, C>) => Record<string, () => boolean>
  onBeforeInput?: (intent: InputIntent, ctx: PluginContext<O, S, C>) => boolean
  handleDOMEvents?: Partial<Record<DOMEventName, (event: Event, ctx: PluginContext<O, S, C>) => boolean>>
  filterTransaction?: (tr: Transaction, state: EditorState) => boolean
  appendTransaction?: (trs: Transaction[], oldState: EditorState, newState: EditorState) => Transaction | null
  normalize?: (entry: [Node, Path], tr: Transaction, ctx: PluginContext<O, S, C>) => void
  parseHTML?: ParseRule[]
  renderHTML?: (node: ElementNode, ctx: { options: O }) => DOMOutputSpec
  transformPasted?: (fragment: Fragment, ctx: PluginContext<O, S, C>) => Fragment
  /**
   * For an event inside a node view of this plugin's type: true makes the editor ignore it (no
   * handling, no `preventDefault`). Events inside `data-editor-ignore` are ignored without asking.
   */
  stopEvent?: (event: Event, node: ElementNode, ctx: PluginContext<O, S, C>) => boolean
  /**
   * For a DOM mutation inside a node view of this plugin's type: false has it reverted (the node
   * view is rebuilt). Without this hook such mutations are ignored; inside `data-editor-ignore` they
   * always are.
   */
  ignoreMutation?: (record: MutationRecord, node: ElementNode, ctx: PluginContext<O, S, C>) => boolean
  onInvalidData?: (raw: unknown) => Data | null
  /** `apply` gets the final (normalized) tr; `ctx.getState()` still returns `prev` there. */
  state?: { init: () => S; apply: (tr: Transaction, prev: S, ctx: PluginContext<O, S, C>) => S }
  /**
   * Creates the plugin's storage (`editor.storage[name]`), once per editor, after every plugin's
   * commands are bound (so `ctx.commands` is usable).
   */
  storage?: (ctx: PluginContext<O, S, C>) => T
  /** Called by `editor.destroy()`, in reverse priority order (lowest priority first). */
  destroy?: (ctx: PluginContext<O, S, C>) => void
  /*
   * Lifecycle hooks (spec §5.11). Each runs by priority with the same cached context as the other
   * hooks. A throwing hook does not stop the others: errors are collected and the first is rethrown
   * once all ran.
   */
  /** Called once at the end of the editor constructor, after every plugin's storage exists (no DOM). */
  onCreate?: (ctx: PluginContext<O, S, C>) => void
  /**
   * Called each time a view is attached to a DOM root, at the end of the view constructor. A returned
   * function is called when that view is destroyed (`unmount`, `mount(other)`, `destroy`); cleanups
   * run in reverse order. When an `onMount` throws, the view is torn down (cleanups included) and
   * `mount` rethrows.
   */
  onMount?: (ctx: PluginContext<O, S, C>, view: EditorView) => void | (() => void)
  /**
   * Called after a committed tr that changed the doc, right after the editor's `update` event
   * (`editor.on` listeners run first). Outside the pipeline: dispatching from here is a nested dispatch.
   */
  onUpdate?: (ctx: PluginContext<O, S, C>, e: { tr: Transaction }) => void
  /** Like `onUpdate`, for a committed tr that changed the selection (after `selectionUpdate`). */
  onSelectionUpdate?: (ctx: PluginContext<O, S, C>, e: { tr: Transaction }) => void
  /** Focus entered the view root from outside it. */
  onFocus?: (ctx: PluginContext<O, S, C>, e: FocusEvent) => void
  /** Focus left the view root. A focus move between elements inside the root is not a blur. */
  onBlur?: (ctx: PluginContext<O, S, C>, e: FocusEvent) => void
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPluginSpec = PluginSpec<string, any, any, any, any, any>

/** Accepts either a plugin or a spec and yields the spec. */
type SpecOf<T> = T extends { readonly spec: infer S } ? S : T

/** Extracts a type argument from a spec. `{ options?: X }` infers `X` (optional props add no `undefined`). */
export type OptionsOf<T> =
  SpecOf<T> extends PluginSpec<string, infer _D, infer O, infer _C, infer _S, infer _T> ? O : NoOptions
export type DataOf<T> = SpecOf<T> extends PluginSpec<string, infer D, infer _O, infer _C, infer _S, infer _T> ? D : Data
export type StateOf<T> =
  SpecOf<T> extends PluginSpec<string, infer _D, infer _O, infer _C, infer S, infer _T> ? S : undefined
type IsAny<T> = 0 extends 1 & T ? true : false

/** Commands of a plugin (or spec). A plugin typed `any`/`AnyPlugin` contributes none instead of collapsing to `any`. */
export type CommandsOfPlugin<T> =
  IsAny<T> extends true
    ? NoOptions
    : SpecOf<T> extends { commands?: (ctx: never) => infer C }
      ? IsAny<C> extends true
        ? NoOptions
        : C
      : NoOptions

/**
 * Storage of a plugin (or spec): what its `storage` factory returns, `undefined` when it has none.
 * A plugin typed `any`/`AnyPlugin` yields `undefined` instead of `any`.
 */
export type StorageOfPlugin<T> =
  IsAny<T> extends true
    ? undefined
    : SpecOf<T> extends { storage?: (ctx: never) => infer X }
      ? IsAny<X> extends true
        ? undefined
        : X
      : undefined

type StorageEntry<T> = [StorageOfPlugin<T>] extends [undefined]
  ? NoOptions
  : SpecOf<T> extends { name: infer N extends string }
    ? { [K in N]: StorageOfPlugin<T> }
    : NoOptions

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never

/** All commands contributed by a list of plugins, merged into one object type. */
export type CommandsOf<P extends readonly AnyPlugin[]> = UnionToIntersection<
  { [K in keyof P]: CommandsOfPlugin<P[K]> }[number]
>

/** Storage of every plugin in a list that declares one, keyed by plugin name. */
export type StorageOf<P extends readonly AnyPlugin[]> = UnionToIntersection<{ [K in keyof P]: StorageEntry<P[K]> }[number]>

export interface Plugin<Spec extends AnyPluginSpec = AnyPluginSpec> {
  readonly name: Spec['name']
  readonly spec: Spec
  /** Returns a new plugin whose options are shallow-merged with `options`. */
  configure(options: Partial<OptionsOf<Spec>>): Plugin<Spec>
  /** Returns a new plugin whose spec is shallow-merged with `overrides`. */
  extend<E extends Partial<Omit<AnyPluginSpec, 'name'>>>(overrides: E): Plugin<Spec & E>
}

export type AnyPlugin = Plugin<AnyPluginSpec>
