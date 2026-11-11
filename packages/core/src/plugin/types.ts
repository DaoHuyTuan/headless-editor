import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Data, DeepReadonly, ElementNode, Node, Path, Range, SelectionRange } from '../model/types'
import type { Transaction } from '../transaction/transaction'
import type { EditorState } from '../state'
import type { Editor } from '../editor'
import type { Fragment } from '../transaction/fragment'
import type { EditorView } from '../view/view'
import type { Decoration } from '../view/decorations'

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
  attrs?: Record<string, string | number | undefined>
  style?: Record<string, string>
}

export interface ParseRule {
  tag?: string
  style?: string
  priority?: number
  getData?: (el: HTMLElement, styleValue?: string) => Data | false
}

/** What `transformPasted` gets besides the fragment. */
export interface PasteInfo {
  /**
   * Where the fragment will be inserted: a drop's drop point, or the one range of a multi-range paste
   * this call is for. Null for the selection (one range): read `info.at ?? mainRange(state.selection)`.
   */
  at: SelectionRange | null
}

export interface InputIntent {
  inputType: string
  data: string | null
  range: SelectionRange | null
  dataTransfer?: DataTransfer | null
}

/**
 * A rule run after the core inserts text from an `insertText` intent (not composition, not paste).
 * `match` is tested against the text of the caret's block from the start of its text run (an inline
 * atom ends a run; inline elements such as links do not) to the caret, anchored there: only a match
 * that ends at the caret counts, with or without a trailing `$` (the leftmost such match).
 * `range` covers the matched text. Returning true applies the changes made on `tr`, dispatched as
 * their own history step (so one undo reverts the rule and keeps the typed text), and stops the
 * remaining rules; returning false discards `tr`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface InputRule<Ctx = PluginContext<any, any, any, any>> {
  match: RegExp
  handler: (ctx: Ctx, match: RegExpMatchArray, range: Range, tr: Transaction) => boolean
}

/**
 * A command: edits `tr` (dispatched for it by the caller) and returns whether it applied. Edit `tr`
 * only: a command that dispatches on its own (`editor.dispatch`) makes `tr` stale, so the caller's
 * dispatch of `tr` is dropped as outdated, and `can()` would dispatch for real.
 */
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

export interface PluginContext<O, S, C extends CommandMap = NoOptions, T = unknown> {
  editor: Editor
  name: string
  readonly options: O
  getState(): S
  /**
   * This plugin's own storage (`editor.storage[name]`), typed from its `storage` factory.
   * `undefined` until that factory has run: inside the factory itself, while the initial content is
   * normalized, and when `commands` is called during construction (the functions it returns run later
   * and see it). Set when `keymap` is called and from `onCreate` on.
   */
  readonly storage: T
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
  /**
   * Content expression, e.g. `'paragraph block*'` or `'listItem+'`: node and group names, sequence
   * by spaces, `|`, parentheses and `* + ? {n} {n,} {n,m}`. `'inline'` means `inline*` and `'text'`
   * means `text*` with `marks: ''`. Omitted on a non-atom node: `inline*` (a textblock), so a block
   * holding blocks must declare it (`'block+'`).
   */
  content?: string
  /**
   * Groups this node belongs to, usable in content expressions. Default: `block` for a block,
   * `inline` for an inline node. A node that sets it is only in the groups it lists (`[]`: none).
   */
  group?: string | string[]
  /** Marks allowed in this node's inline content: `'_'` all (default), `''` none, or space-separated mark names. */
  marks?: string
  /** Edits do not cross this node's boundary: no join, no range delete merging it with a neighbour (table cells). */
  isolating?: boolean
}

/**
 * `render(data, { options })` gets the plugin's current options. When they change
 * (`setPluginOptions`), the view re-renders the text that carries this mark.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface MarkSpec<D = Data, O = any> {
  render: (data: D, ctx: { options: O }) => MarkDOM
}

export type DOMEventName = 'keydown' | 'beforeinput' | 'input'

/** What a node view gets: the current node, whether it is node-selected, and ways to read and change it. */
export interface NodeViewProps<D = Data, O = unknown, T = unknown, S = unknown> {
  /** The current model node. */
  node: DeepReadonly<ElementNode> & { readonly data: DeepReadonly<D> }
  /** Whether the node is node-selected. */
  selected: boolean
  editor: Editor
  /** The node plugin's current options. */
  options: O
  /** The node plugin's storage (`editor.storage[type]`). */
  storage: T
  /**
   * The node plugin's current state, read when accessed (a getter on the props object). A change of
   * plugin state alone does not call `update`; a view that must re-render on it subscribes itself
   * (in React, `usePluginState`).
   */
  readonly state: S
  /** The node's path in the current doc (looked up by id), or null when it is no longer in the doc. */
  getPos(): Path | null
  /**
   * Merges `partial` into the node's data in a fresh tr (origin `command`) and dispatches it.
   * False when the node is gone or the change was rejected.
   */
  updateData(partial: Partial<D>): boolean
  /**
   * For a non-atom node: the element the core renders the node's children into (`<div data-penline-content
   * contenteditable="true">`, a `<span>` for an inline node). Created with the view and the same in
   * every update. The view places it inside its own DOM, never under a `contenteditable="false"`
   * element (see `NodeViewFactory`), and never changes it; the core owns it.
   * Undefined for atoms.
   */
  contentDOM?: HTMLElement
}

export interface NodeViewInstance<D = Data, O = unknown, T = unknown, S = unknown> {
  /** Called when the node's data, its `selected` state or the plugin's options change. */
  update(props: NodeViewProps<D, O, T, S>): void
  /** Called once, when the node leaves the doc or the view is destroyed. */
  destroy(): void
}

/**
 * Renders a node into `container` (created by the renderer: `<div>` for a block, `<span>` for an
 * inline node; `contenteditable="false"` for an atom). Called once per element id; the container is
 * never rebuilt for a data change. Elements inside it (outside `contentDOM`) marked
 * `data-editor-ignore` are fully left to the view (events, mutations, focus and selection); the
 * attribute has no effect anywhere else in the root. A non-atom node's view gets `props.contentDOM` and places it in its DOM (synchronously or
 * later, e.g. on a React commit). The elements on the path from the container down to `contentDOM`
 * must stay editable (no `contenteditable` attribute): a `contenteditable="false"` ancestor would make
 * `contentDOM` a separate editing host that the caret, selection extension and select-all do not
 * cross (the editor warns). Only the view's elements beside that path (headers, labels) are marked
 * `contenteditable="false"`, and its controls `data-editor-ignore`. Inside `contentDOM`, events,
 * mutations, selection and composition are the editor's as in any block; outside it the atom rules
 * apply (`stopEvent`, `ignoreMutation`).
 */
export type NodeViewFactory<D = Data, O = unknown, T = unknown, S = unknown> = (
  container: HTMLElement,
  props: NodeViewProps<D, O, T, S>,
) => NodeViewInstance<D, O, T, S>

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
  mark?: MarkSpec<D, O>
  data?: StandardSchemaV1<unknown, D>
  options?: O
  /** Gets a context without `C` (its own commands) or `T` (`ctx.storage` is `unknown`) to avoid circular inference. */
  commands?: (ctx: PluginContext<O, S>) => C
  keymap?: (ctx: PluginContext<O, S, C, T>) => Record<string, () => boolean>
  onBeforeInput?: (intent: InputIntent, ctx: PluginContext<O, S, C, T>) => boolean
  /** Input rules, run in plugin priority order, then in array order (see `InputRule`). */
  inputRules?: InputRule<PluginContext<O, S, C, T>>[]
  handleDOMEvents?: Partial<Record<DOMEventName, (event: Event, ctx: PluginContext<O, S, C, T>) => boolean>>
  filterTransaction?: (tr: Transaction, state: EditorState) => boolean
  appendTransaction?: (trs: Transaction[], oldState: EditorState, newState: EditorState) => Transaction | null
  /**
   * Fixes one entry of a changed doc (edits go on `tr`). Also runs on the content the constructor
   * loads, before any command is bound: `ctx.commands` is empty and `ctx.storage` undefined there, so
   * edit through `tr` only.
   */
  normalize?: (entry: [Node, Path], tr: Transaction, ctx: PluginContext<O, S, C, T>) => void
  parseHTML?: ParseRule[]
  renderHTML?: (node: ElementNode, ctx: { options: O }) => DOMOutputSpec
  /**
   * The plain text of an element of this plugin's node type, where content becomes plain text: the
   * `text/plain` clipboard flavor, an inline atom normalized into a text-only (`content: 'text'`)
   * block, plugins converting content to text (e.g. the code block's paste and `setCodeBlock`).
   * Without it an element's text is its children's text, so a childless atom has none (and is dropped
   * from a text-only block). Meant for inline atoms (e.g. a mention: `@label`).
   */
  renderText?: (node: DeepReadonly<ElementNode>, ctx: { options: O }) => string
  /**
   * Rewrites a pasted or dropped fragment before it is inserted. `info.at` is where it will be
   * inserted (the drop point of a drop); null means at the selection, so a hook deciding by position
   * reads `info.at ?? mainRange(state.selection)`. A paste at several ranges runs the hook once per
   * range, with `info.at` set to that range, so each range can get its own fragment.
   */
  transformPasted?: (fragment: Fragment, ctx: PluginContext<O, S, C, T>, info: PasteInfo) => Fragment
  /**
   * For an event inside a node view of this plugin's type (outside its `contentDOM`, whose events
   * are editor content): true makes the editor ignore it (no
   * handling, no `preventDefault`). Events inside `data-editor-ignore` are ignored without asking.
   *
   * For a focusable control (an input, a textarea, a button), mark the element `data-editor-ignore`
   * instead of using this hook: that also leaves its mutations, focus and selection to it, which
   * `stopEvent` does not (the editor would still take the selection back from it).
   */
  stopEvent?: (event: Event, node: ElementNode, ctx: PluginContext<O, S, C, T>) => boolean
  /**
   * For a DOM mutation inside a node view of this plugin's type (outside its `contentDOM`, whose
   * mutations are reverted from the model like any content; moving `contentDOM` itself is ignored): false has it reverted (the node
   * view is rebuilt). Without this hook such mutations are ignored; inside `data-editor-ignore` they
   * always are.
   *
   * Return false only for changes the view did not make itself. A rebuilt view that renders
   * asynchronously (e.g. a React portal commit) mutates its new container after the rebuild; if the
   * hook returns false for those mutations too, each one rebuilds the view again, which renders
   * again: an endless loop. Recognize the view's own rendering (return true for it).
   */
  ignoreMutation?: (record: MutationRecord, node: ElementNode, ctx: PluginContext<O, S, C, T>) => boolean
  /**
   * Non-persisted highlights and widgets drawn by the view (e.g. syntax highlighting), computed for
   * the new state on every view update. They are never part of the doc, `getJSON()` or `getHTML()`.
   */
  decorations?: (state: EditorState, ctx: PluginContext<O, S, C, T>) => Decoration[]
  /**
   * Repairs data that failed validation while loading or sanitizing content. The result is
   * validated again; null, still-invalid data or a throw drops the node (with a warning).
   */
  onInvalidData?: (raw: unknown) => Data | null
  /** `apply` gets the final (normalized) tr; `ctx.getState()` still returns `prev` there. */
  state?: { init: () => S; apply: (tr: Transaction, prev: S, ctx: PluginContext<O, S, C, T>) => S }
  /**
   * Creates the plugin's storage (`editor.storage[name]`, `ctx.storage` in the other hooks), once
   * per editor, by priority, after every plugin's commands are bound (so `ctx.commands` is usable).
   * Its own `ctx.storage` is still `undefined` here (typed so, which also keeps `T` inferable), and
   * `editor.storage` is not built yet: read other plugins' storage from `onCreate` instead.
   * `T` is inferred from the return type. When this factory takes `ctx`, declare it before any hook
   * whose `ctx` parameter is used: TypeScript types those hooks in order, and one typed first would
   * fix `T` to `undefined` (a compile error on the factory). A factory without parameters may go anywhere.
   */
  storage?: (ctx: PluginContext<O, S, C, undefined>) => T
  /** Called by `editor.destroy()`, in reverse priority order (lowest priority first). */
  destroy?: (ctx: PluginContext<O, S, C, T>) => void
  /*
   * Lifecycle hooks (spec §5.11). Each runs by priority with the same cached context as the other
   * hooks. A throwing hook does not stop the others: errors are collected and the first is rethrown
   * once all ran.
   */
  /**
   * Called once at the end of the editor constructor, after every plugin's storage exists (no DOM).
   * When one throws, the constructor destroys the editor (every `destroy` hook runs) before rethrowing.
   * Keep it side-effect-free: an app may build an editor it never mounts or keeps (the React
   * adapter builds one per mount, but a render React discards before committing can still build one).
   */
  onCreate?: (ctx: PluginContext<O, S, C, T>) => void
  /**
   * Called each time a view is attached to a DOM root, at the end of the view constructor. A returned
   * function is called when that view is destroyed (`unmount`, `mount(other)`, `destroy`); cleanups
   * run in reverse order. When an `onMount` throws, the view is torn down (cleanups included) and
   * `mount` rethrows. `editor.view` is still null here: use the `view` argument.
   */
  onMount?: (ctx: PluginContext<O, S, C, T>, view: EditorView) => void | (() => void)
  /**
   * Called after a committed tr that changed the doc, right after the editor's `update` event
   * (`editor.on` listeners run first). Outside the pipeline: dispatching from here is a nested dispatch.
   */
  onUpdate?: (ctx: PluginContext<O, S, C, T>, e: { tr: Transaction }) => void
  /** Like `onUpdate`, for a committed tr that changed the selection (after `selectionUpdate`). */
  onSelectionUpdate?: (ctx: PluginContext<O, S, C, T>, e: { tr: Transaction }) => void
  /**
   * Focus entered the view root from outside it. Mounting on a root that already has focus fires
   * none (in `onMount`, check whether `view.root` contains `document.activeElement`).
   */
  onFocus?: (ctx: PluginContext<O, S, C, T>, e: FocusEvent) => void
  /**
   * Focus left the view root. A focus move between elements inside the root is not a blur, and
   * unmounting a focused view fires none.
   */
  onBlur?: (ctx: PluginContext<O, S, C, T>, e: FocusEvent) => void
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

type AsCommands<C> = C extends CommandMap ? C : NoOptions

/** The parent spec with its type arguments resolved (what `extend` overrides are typed against). */
type ResolvedSpec<Spec> = PluginSpec<
  string,
  DataOf<Spec>,
  OptionsOf<Spec>,
  AsCommands<CommandsOfPlugin<Spec>>,
  StateOf<Spec>,
  StorageOfPlugin<Spec>
>

/**
 * What `extend` accepts: any spec member but `name`. Hooks are typed with the parent's type
 * arguments (so their parameters are inferred); `data`, `commands`, `state` and `storage` may
 * change type, and the extended plugin's `D`, `C`, `S`, `T` follow them. Other hooks of the same
 * override still see the parent's types.
 */
export type PluginOverrides<Spec> = Partial<
  Omit<ResolvedSpec<Spec>, 'name' | 'data' | 'mark' | 'commands' | 'state' | 'storage'>
> & {
  /* eslint-disable @typescript-eslint/no-explicit-any -- these overrides may change `D` / `S` */
  data?: StandardSchemaV1<unknown, any>
  mark?: MarkSpec<any, OptionsOf<Spec>>
  commands?: (ctx: PluginContext<OptionsOf<Spec>, StateOf<Spec>>) => CommandMap
  state?: { init: () => unknown; apply: (tr: Transaction, prev: any, ctx: any) => unknown }
  /* eslint-enable @typescript-eslint/no-explicit-any */
  storage?: (ctx: PluginContext<OptionsOf<Spec>, StateOf<Spec>, AsCommands<CommandsOfPlugin<Spec>>, undefined>) => unknown
}

/** The spec of `parent.extend(overrides)`: the parent's type arguments, replaced where `E` redefines them. */
export type ExtendedSpec<Spec extends AnyPluginSpec, E> = PluginSpec<
  Spec['name'],
  E extends { data: StandardSchemaV1<unknown, infer D> } ? D : DataOf<Spec>,
  OptionsOf<Spec>,
  E extends { commands: (ctx: never) => infer C extends CommandMap } ? C : AsCommands<CommandsOfPlugin<Spec>>,
  E extends { state: { init: () => infer S } } ? S : StateOf<Spec>,
  E extends { storage: (ctx: never) => infer T } ? T : StorageOfPlugin<Spec>
>

export interface Plugin<Spec extends AnyPluginSpec = AnyPluginSpec> {
  readonly name: Spec['name']
  readonly spec: Spec
  /** Returns a new plugin whose options are shallow-merged with `options`. */
  configure(options: Partial<OptionsOf<Spec>>): Plugin<Spec>
  /**
   * Returns a new plugin whose spec is shallow-merged with the overrides `fn(parent)` returns.
   * `parent` is this plugin's spec, so an override can wrap the original hook
   * (`renderHTML: (n, c) => wrap(parent.renderHTML!(n, c))`, `keymap: (ctx) => ({ ...parent.keymap?.(ctx), … })`).
   * Extending an extended plugin passes the previous extend's merged spec as `parent`.
   */
  extend<E extends PluginOverrides<Spec>>(fn: (parent: Spec) => E): Plugin<ExtendedSpec<Spec, E>>
  /** Returns a new plugin whose spec is shallow-merged with `overrides`. */
  extend<E extends PluginOverrides<Spec>>(overrides: E): Plugin<ExtendedSpec<Spec, E>>
}

/** The props of a node view for the node plugin `P`: its data, options, storage and state types. */
export type NodeViewPropsOf<P> = NodeViewProps<DataOf<P>, OptionsOf<P>, StorageOfPlugin<P>, StateOf<P>>

export type AnyPlugin = Plugin<AnyPluginSpec>
