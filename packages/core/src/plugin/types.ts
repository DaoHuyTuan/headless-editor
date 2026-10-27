import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Data, ElementNode, Node, Path, Selection } from '../model/types'
import type { Transaction } from '../transaction/transaction'
import type { EditorState } from '../state'
import type { Editor } from '../editor'
import type { Fragment } from '../transaction/fragment'

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

export interface PluginContext<O, S> {
  editor: Editor
  name: string
  readonly options: O
  getState(): S
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CommandFactory = (...args: any[]) => Command
export type CommandMap = Record<string, CommandFactory>

/** Options type used when a plugin declares none. */
export type NoOptions = Record<never, never>

export interface NodeSpec {
  kind: 'block' | 'inline'
  atom?: boolean
  default?: boolean
  content?: 'inline' | 'text'
}

export interface MarkSpec<D = Data> {
  render: (data: D) => MarkDOM
}

export type DOMEventName = 'keydown' | 'beforeinput' | 'input'

export interface PluginSpec<
  Name extends string = string,
  D = Data,
  O = NoOptions,
  C extends CommandMap = NoOptions,
  S = undefined,
> {
  name: Name
  /** Default 100; higher runs first. */
  priority?: number
  node?: NodeSpec
  mark?: MarkSpec<D>
  data?: StandardSchemaV1<unknown, D>
  options?: O
  commands?: (ctx: PluginContext<O, S>) => C
  keymap?: (ctx: PluginContext<O, S>) => Record<string, () => boolean>
  onBeforeInput?: (intent: InputIntent, ctx: PluginContext<O, S>) => boolean
  handleDOMEvents?: Partial<Record<DOMEventName, (event: Event, ctx: PluginContext<O, S>) => boolean>>
  filterTransaction?: (tr: Transaction, state: EditorState) => boolean
  appendTransaction?: (trs: Transaction[], oldState: EditorState, newState: EditorState) => Transaction | null
  normalize?: (entry: [Node, Path], tr: Transaction, ctx: PluginContext<O, S>) => void
  parseHTML?: ParseRule[]
  renderHTML?: (node: ElementNode, ctx: { options: O }) => DOMOutputSpec
  transformPasted?: (fragment: Fragment, ctx: PluginContext<O, S>) => Fragment
  onInvalidData?: (raw: unknown) => Data | null
  /** `apply` gets the final (normalized) tr; `ctx.getState()` still returns `prev` there. */
  state?: { init: () => S; apply: (tr: Transaction, prev: S, ctx: PluginContext<O, S>) => S }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPluginSpec = PluginSpec<string, any, any, any, any>

/** Accepts either a plugin or a spec and yields the spec. */
type SpecOf<T> = T extends { readonly spec: infer S } ? S : T

/** Extracts a type argument from a spec. `{ options?: X }` infers `X` (optional props add no `undefined`). */
export type OptionsOf<T> = SpecOf<T> extends PluginSpec<string, infer _D, infer O, infer _C, infer _S> ? O : NoOptions
export type DataOf<T> = SpecOf<T> extends PluginSpec<string, infer D, infer _O, infer _C, infer _S> ? D : Data
export type StateOf<T> = SpecOf<T> extends PluginSpec<string, infer _D, infer _O, infer _C, infer S> ? S : undefined
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

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never

/** All commands contributed by a list of plugins, merged into one object type. */
export type CommandsOf<P extends readonly AnyPlugin[]> = UnionToIntersection<
  { [K in keyof P]: CommandsOfPlugin<P[K]> }[number]
>

export interface Plugin<Spec extends AnyPluginSpec = AnyPluginSpec> {
  readonly name: Spec['name']
  readonly spec: Spec
  /** Returns a new plugin whose options are shallow-merged with `options`. */
  configure(options: Partial<OptionsOf<Spec>>): Plugin<Spec>
  /** Returns a new plugin whose spec is shallow-merged with `overrides`. */
  extend<E extends Partial<Omit<AnyPluginSpec, 'name'>>>(overrides: E): Plugin<Spec & E>
}

export type AnyPlugin = Plugin<AnyPluginSpec>
