import type { StandardSchemaV1 } from '@standard-schema/spec'
import { createId } from '../model/id'
import type { Data, ElementNode, Node } from '../model/types'
import { type ContentExpr, parseContentExpr } from '../schema/content-expr'
import { compileContent, type ContentMatch, type SchemaLookup } from '../schema/content-match'
import type { AnyPlugin, MarkSpec, NodeSpec } from './types'

const DOC_CONTENT = 'block+'

/** The expression a node's `content` stands for: aliases expanded, omitted meaning inline content. */
export function contentSource(spec: NodeSpec): string {
  const content = spec.content ?? 'inline'
  return content === 'inline' ? 'inline*' : content === 'text' ? 'text*' : content
}

export function exprNames(expr: ContentExpr, out: string[] = []): string[] {
  if (expr.kind === 'name') out.push(expr.name)
  else if (expr.kind === 'repeat') exprNames(expr.expr, out)
  else for (const item of expr.items) exprNames(item, out)
  return out
}

/** Every type an edge of the automaton from `start` can consume. */
function reachableTypes(start: ContentMatch): Set<string> {
  const types = new Set<string>()
  const seen = new Set<ContentMatch>([start])
  const queue = [start]
  while (queue.length) {
    for (const e of queue.pop()!.edges) {
      types.add(e.type)
      if (!seen.has(e.next)) {
        seen.add(e.next)
        queue.push(e.next)
      }
    }
  }
  return types
}

export const DEFAULT_PRIORITY = 100

export type ValidateResult = { ok: true; data: Data } | { ok: false; message: string }
export type RegisteredNode = NodeSpec & { plugin: AnyPlugin }
export type RegisteredMark = MarkSpec<any> & { plugin: AnyPlugin } // eslint-disable-line @typescript-eslint/no-explicit-any

function isPlainObject(value: unknown): value is Data {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function assertSyncSchema(schema: StandardSchemaV1, pluginName: string): void {
  let result: unknown
  try {
    result = schema['~standard'].validate({})
  } catch {
    return // a sync validator that throws on `{}` is still sync
  }
  if (isThenable(result)) {
    // Swallow the probe's rejection so it never surfaces as unhandled.
    result.then(undefined, () => {})
    throw new Error(`Async validators are not supported (plugin "${pluginName}")`)
  }
}

export class Registry {
  /** Sorted by priority desc; ties keep registration order. */
  readonly plugins: AnyPlugin[]
  readonly defaultBlock: string
  private readonly byName = new Map<string, AnyPlugin>()
  private readonly nodes = new Map<string, RegisteredNode>()
  private readonly marks = new Map<string, RegisteredMark>()
  private readonly markRanks = new Map<string, number>()
  /** Group name -> member types, in priority order with the default block first ('text' leads `inline`). */
  private readonly groups = new Map<string, string[]>()
  /** Compiled content of every non-atom node. */
  private readonly matches = new Map<string, ContentMatch>()
  /** Types the content of a non-atom node can hold anywhere. */
  private readonly allowed = new Map<string, Set<string>>()
  private readonly textblocks = new Set<string>()
  /** `isTextOnly`, cached per type. */
  private readonly textOnlyTypes = new Map<string, boolean>()
  private readonly docMatch: ContentMatch
  /**
   * Auto-creatable types, each with the order it became creatable in: its content can always be
   * filled with lower-ranked types only, which keeps `createAndFill` from looping through cycles.
   */
  private creatable = new Map<string, number>()
  /** While filling a node, only types ranked below this may be auto-created (see `createAndFill`). */
  private rankLimit = Infinity

  constructor(plugins: AnyPlugin[]) {
    for (const plugin of plugins) {
      if (this.byName.has(plugin.name)) throw new Error(`Duplicate plugin "${plugin.name}"`)
      this.byName.set(plugin.name, plugin)
      const { spec } = plugin
      if (spec.data) assertSyncSchema(spec.data, plugin.name)
      if (spec.node) this.nodes.set(plugin.name, { ...spec.node, plugin })
      if (spec.mark) {
        this.marks.set(plugin.name, { ...spec.mark, plugin })
        this.markRanks.set(plugin.name, this.markRanks.size)
      }
    }

    // Array.prototype.sort is stable, so ties keep registration order.
    this.plugins = [...plugins].sort(
      (a, b) => (b.spec.priority ?? DEFAULT_PRIORITY) - (a.spec.priority ?? DEFAULT_PRIORITY),
    )

    const defaultBlock = this.plugins.find((p) => p.spec.node?.kind === 'block' && p.spec.node.default)
    if (!defaultBlock) throw new Error('No default block plugin registered')
    this.defaultBlock = defaultBlock.name

    this.docMatch = this.compileSchema()
  }

  /** Builds the groups, compiles every content expression and finds the auto-creatable types. */
  private compileSchema(): ContentMatch {
    this.groups.set('block', [])
    this.groups.set('inline', ['text'])
    const ordered = [this.defaultBlock, ...this.plugins.map((p) => p.name).filter((n) => n !== this.defaultBlock)]
    for (const name of ordered) {
      const spec = this.nodes.get(name)
      if (!spec) continue
      const groups =
        spec.group === undefined
          ? [spec.kind]
          : typeof spec.group === 'string'
            ? spec.group.split(/\s+/).filter(Boolean)
            : spec.group
      for (const g of groups) {
        const members = this.groups.get(g)
        if (members) members.push(name)
        else this.groups.set(g, [name])
      }
    }

    const lookup: SchemaLookup = {
      expand: (name) => (name === 'text' || this.nodes.has(name) ? [name] : this.groups.get(name)),
      autoCreatable: (type) => (this.creatable.get(type) ?? Infinity) < this.rankLimit,
      contentOf: (type) => (this.textblocks.has(type) ? null : (this.matches.get(type) ?? null)),
    }
    const compile = (source: string, owner: string): ContentMatch => {
      let expr: ContentExpr
      try {
        expr = parseContentExpr(source)
      } catch (e) {
        throw new SyntaxError(`Invalid content for plugin "${owner}": ${(e as Error).message}`)
      }
      for (const name of exprNames(expr)) {
        if (!lookup.expand(name)) {
          throw new Error(`Invalid content for plugin "${owner}": unknown node or group "${name}" in "${source}"`)
        }
      }
      return compileContent(expr, lookup)
    }

    for (const [type, spec] of this.nodes) {
      if (spec.atom) continue
      const match = compile(contentSource(spec), type)
      const allowed = reachableTypes(match)
      this.matches.set(type, match)
      this.allowed.set(type, allowed)
      const inlineOnly = [...allowed].every((t) => t === 'text' || this.nodes.get(t)?.kind === 'inline')
      if (spec.kind === 'block' && inlineOnly) this.textblocks.add(type)
    }
    const docMatch = compile(DOC_CONTENT, 'doc')

    // Every non-atom node must have some finite content, whatever its data.
    this.growCreatable(() => true)
    for (const [type, spec] of this.nodes) {
      if (!spec.atom && !this.creatable.has(type)) {
        throw new Error(
          `Node "${type}" (plugin "${type}") cannot be created: no finite content matches "${contentSource(spec)}"`,
        )
      }
    }
    this.growCreatable((type) => this.parsesEmptyData(type))
    // The core creates default blocks with empty data (normalization, splits, paste); the insert
    // stores the schema's output for `{}`, so fields with a default get it. A required field without
    // one would make those inserts reject, so it is a setup error.
    const result = this.validateData(this.defaultBlock, {})
    if (!result.ok) {
      throw new Error(
        `The default block "${this.defaultBlock}" cannot be created with empty data (${result.message}). ` +
          'Give every field of its data schema a default, or make it optional.',
      )
    }
    if (docMatch.fillBefore([], true, () => true) === null) {
      throw new Error(
        `The doc content "${DOC_CONTENT}" cannot be created: no block parses from {} data with fillable content`,
      )
    }
    return docMatch
  }

  /**
   * Least fixpoint of the creatable types: a type joins once `admit` accepts it and its content can
   * be filled with types already in. Ranks record the order they joined in.
   */
  private growCreatable(admit: (type: string) => boolean): void {
    this.creatable = new Map([['text', 0]])
    let changed = true
    while (changed) {
      changed = false
      for (const type of this.nodes.keys()) {
        if (this.creatable.has(type) || !admit(type)) continue
        const match = this.matches.get(type)
        if (match && match.fillBefore([], true, () => true) === null) continue
        this.creatable.set(type, this.creatable.size)
        changed = true
      }
    }
  }

  private parsesEmptyData(type: string): boolean {
    try {
      return this.validateData(type, {}).ok
    } catch {
      return false // a validator that throws on `{}`
    }
  }

  node(type: string): RegisteredNode | undefined {
    return this.nodes.get(type)
  }

  mark(type: string): RegisteredMark | undefined {
    return this.marks.get(type)
  }

  /** Registration order among mark plugins; unknown marks sort last. */
  markRank(type: string): number {
    return this.markRanks.get(type) ?? Number.MAX_SAFE_INTEGER
  }

  /** Compiled match for an element type's content; the doc's (`block+`) for `'doc'`. Undefined for unknown types and atoms. */
  contentMatch(type: string): ContentMatch | undefined {
    return type === 'doc' ? this.docMatch : this.matches.get(type)
  }

  /** A known non-atom block whose content matches only inline content (text and inline nodes). */
  isTextblock(type: string): boolean {
    return this.textblocks.has(type)
  }

  /**
   * Whether the content expression of `type` names only `text` (`content: 'text'`, `'text*'`,
   * `'text+'`…): such content is plain text, where `\n` is a line break and no inline element goes.
   * Read from the expression, not the compiled match: with no inline plugin registered, `inline*`
   * reaches only text too. False for unknown types.
   */
  isTextOnly(type: string): boolean {
    const spec = this.nodes.get(type)
    if (!spec) return false
    let out = this.textOnlyTypes.get(type)
    if (out === undefined) {
      out = exprNames(parseContentExpr(contentSource(spec))).every((name) => name === 'text')
      this.textOnlyTypes.set(type, out)
    }
    return out
  }

  /**
   * Whether `mark` is allowed in the inline content of `type` (from `marks`: `'_'` all, `''` none,
   * or names; `content: 'text'` defaults to none, anything else to all). True for unknown types.
   */
  allowsMark(type: string, mark: string): boolean {
    const spec = this.nodes.get(type)
    if (!spec) return true
    const marks = spec.marks ?? (spec.content === 'text' ? '' : '_')
    return marks === '_' || marks.split(/\s+/).includes(mark)
  }

  /**
   * Whether `type`'s content allows inline element `inlineType`. True for an unknown `type`
   * (opaque); for an unknown `inlineType`, whether `type` holds any inline content. `'text'` asks
   * whether text is allowed. False for atoms.
   */
  allowsInline(type: string, inlineType: string): boolean {
    const allowed = this.allowed.get(type)
    if (!allowed) return !this.nodes.has(type)
    if (inlineType === 'text' || this.nodes.has(inlineType)) return allowed.has(inlineType)
    return [...allowed].some((t) => t === 'text' || this.nodes.get(t)?.kind === 'inline')
  }

  /** Whether edits must not cross `type`'s boundary (`isolating`). */
  isIsolating(type: string): boolean {
    return this.nodes.get(type)?.isolating === true
  }

  /**
   * A new node of `type` (fresh ids) with data parsed from `data ?? {}` and its required content
   * filled with auto-created nodes; an empty text when it then holds nothing but may hold text.
   * Null for unknown types, invalid data, or content that cannot be filled.
   */
  createAndFill(type: string, data?: Data): ElementNode | null {
    const spec = this.nodes.get(type)
    if (!spec) return null
    let parsed: ValidateResult
    try {
      parsed = this.validateData(type, data ?? {})
    } catch {
      return null
    }
    if (!parsed.ok) return null
    const node: ElementNode = { id: createId(), type, data: parsed.data }
    if (spec.atom) return node

    // Fill with types ranked below this one only (when it is auto-creatable), so a cycle such as
    // `a: 'b'`, `b: 'a | paragraph'` fills `b` with a paragraph instead of looping.
    const outer = this.rankLimit
    this.rankLimit = Math.min(outer, this.creatable.get(type) ?? Infinity)
    try {
      const fill = this.matches.get(type)!.fillBefore([], true, () => true)
      if (!fill) return null
      const children: Node[] = []
      for (const t of fill) {
        const child = t === 'text' ? { text: '', marks: [] } : this.createAndFill(t)
        if (!child) return null
        children.push(child)
      }
      if (children.length === 0 && this.allowed.get(type)!.has('text')) children.push({ text: '', marks: [] })
      node.children = children
      return node
    } finally {
      this.rankLimit = outer
    }
  }

  /** Validates `raw` against the type's data schema. `undefined` is treated as `{}`. */
  validateData(type: string, raw: unknown): ValidateResult {
    const input = raw === undefined ? {} : raw
    const schema = this.byName.get(type)?.spec.data
    if (!schema) {
      return isPlainObject(input)
        ? { ok: true, data: input }
        : { ok: false, message: `Data for "${type}" must be a plain object` }
    }
    const result = schema['~standard'].validate(input)
    if (isThenable(result)) {
      return { ok: false, message: `Async validators are not supported (plugin "${type}")` }
    }
    if (result.issues) {
      return { ok: false, message: result.issues.map((i) => i.message).join('; ') || 'Invalid data' }
    }
    if (!isPlainObject(result.value)) {
      return { ok: false, message: `Data for "${type}" must validate to a plain object` }
    }
    return { ok: true, data: result.value }
  }
}
