import type { ContentExpr } from './content-expr'

export interface SchemaLookup {
  /** Types a name stands for: [name] for a node type or 'text', the members for a group; undefined if unknown. */
  expand(name: string): readonly string[] | undefined
  /** Whether the core may create this type on its own (data parses from {}, its own content can be filled). */
  autoCreatable(type: string): boolean
  /** The compiled match of a type's own content, for findWrapping. Null for textblocks and atoms. */
  contentOf(type: string): ContentMatch | null
}

export interface ContentEdge {
  type: string
  next: ContentMatch
}

/** One state of the deterministic automaton compiled from a content expression. */
export class ContentMatch {
  readonly edges: ContentEdge[] = []

  /** @internal built by `compileContent` */
  constructor(
    readonly validEnd: boolean,
    private readonly lookup: SchemaLookup,
  ) {}

  matchType(type: string): ContentMatch | null {
    for (const e of this.edges) if (e.type === type) return e.next
    return null
  }

  /** Matches node types in order; an unknown type (not in `known`) takes this state's first edge. */
  matchTypes(types: readonly string[], known: (type: string) => boolean): ContentMatch | null {
    let state: ContentMatch | null = this
    for (const t of types) {
      if (!state) return null
      state = known(t) ? state.matchType(t) : (state.edges[0]?.next ?? null)
    }
    return state
  }

  /**
   * Types to insert before `after` so the content matches (and ends validly when `toEnd`).
   * Only auto-creatable types are inserted. Shortest answer; null if impossible.
   */
  fillBefore(after: readonly string[], toEnd: boolean, known: (t: string) => boolean): string[] | null {
    const seen = new Set<ContentMatch>([this])
    let level: { state: ContentMatch; path: string[] }[] = [{ state: this, path: [] }]
    while (level.length) {
      const nextLevel: typeof level = []
      for (const { state, path } of level) {
        const end = state.matchTypes(after, known)
        if (end && (!toEnd || end.validEnd)) return path
        for (const e of state.edges) {
          if (seen.has(e.next) || !this.lookup.autoCreatable(e.type)) continue
          seen.add(e.next)
          nextLevel.push({ state: e.next, path: [...path, e.type] })
        }
      }
      level = nextLevel
    }
    return null
  }

  /**
   * Wrapper types, outermost first, so `type` fits here (`['listItem']` for a paragraph at the
   * start of `listItem+`). `[]` when `type` already fits directly; null if no wrapping exists.
   */
  findWrapping(type: string): string[] | null {
    if (this.matchType(type)) return []
    const visited = new Set<string>()
    let level: { chain: string[]; state: ContentMatch }[] = [{ chain: [], state: this }]
    while (level.length) {
      const nextLevel: typeof level = []
      for (const { chain, state } of level) {
        for (const e of state.edges) {
          if (visited.has(e.type) || !this.lookup.autoCreatable(e.type)) continue
          const inner = this.lookup.contentOf(e.type)
          // The wrapper must leave its parent completable, and its own content must be
          // completable once `type` is placed: results are valid without later repair.
          if (!inner || !completable(e.next)) continue
          visited.add(e.type)
          const next = [...chain, e.type]
          const placed = inner.matchType(type)
          if (placed && completable(placed)) return next
          nextLevel.push({ chain: next, state: inner })
        }
      }
      level = nextLevel
    }
    return null
  }

  /** First auto-creatable edge type, or null. */
  get defaultType(): string | null {
    for (const e of this.edges) if (this.lookup.autoCreatable(e.type)) return e.type
    return null
  }
}

// ---- NFA ----

interface NfaNode {
  /** Epsilon targets. */
  eps: NfaNode[]
  /** Typed transitions in expression order. */
  out: { type: string; to: NfaNode }[]
}

const newNode = (): NfaNode => ({ eps: [], out: [] })

/** Adds the NFA for `expr` between `from` and a fresh end node, which it returns. */
function build(expr: ContentExpr, from: NfaNode, lookup: SchemaLookup): NfaNode {
  switch (expr.kind) {
    case 'name': {
      const types = lookup.expand(expr.name)
      if (!types) throw new Error(`Unknown name "${expr.name}" in content expression`)
      const to = newNode()
      for (const type of types) from.out.push({ type, to })
      return to
    }
    case 'seq': {
      let cur = from
      for (const item of expr.items) cur = build(item, cur, lookup)
      return cur
    }
    case 'choice': {
      const end = newNode()
      for (const item of expr.items) {
        const start = newNode()
        from.eps.push(start)
        build(item, start, lookup).eps.push(end)
      }
      return end
    }
    case 'repeat': {
      let cur = from
      for (let i = 0; i < expr.min; i++) cur = build(expr.expr, cur, lookup)
      if (expr.max === Infinity) {
        // cur --eps--> loop; loop -expr-> back to loop; loop --eps--> end
        const loop = newNode()
        cur.eps.push(loop)
        build(expr.expr, loop, lookup).eps.push(loop)
        const end = newNode()
        loop.eps.push(end)
        return end
      }
      const end = newNode()
      cur.eps.push(end)
      for (let i = expr.min; i < expr.max; i++) {
        cur = build(expr.expr, cur, lookup)
        cur.eps.push(end)
      }
      return end
    }
  }
}

/** Compiles a content expression into a deterministic automaton (subset construction). */
export function compileContent(expr: ContentExpr, lookup: SchemaLookup): ContentMatch {
  const start = newNode()
  const accept = build(expr, start, lookup)

  const ids = new Map<NfaNode, number>()
  const idOf = (n: NfaNode): number => {
    let id = ids.get(n)
    if (id === undefined) ids.set(n, (id = ids.size))
    return id
  }
  /** Epsilon closure in discovery order, which follows expression order. */
  const closure = (seeds: NfaNode[]): NfaNode[] => {
    const seen = new Set<NfaNode>()
    const order: NfaNode[] = []
    const visit = (n: NfaNode): void => {
      if (seen.has(n)) return
      seen.add(n)
      order.push(n)
      for (const e of n.eps) visit(e)
    }
    for (const s of seeds) visit(s)
    return order
  }

  const states = new Map<string, ContentMatch>()
  const stateFor = (nodes: NfaNode[]): ContentMatch => {
    const key = nodes
      .map(idOf)
      .sort((a, b) => a - b)
      .join(',')
    let m = states.get(key)
    if (m) return m
    m = new ContentMatch(nodes.includes(accept), lookup)
    states.set(key, m)
    // Group targets by type, types in order of first appearance.
    const byType = new Map<string, NfaNode[]>()
    for (const n of nodes)
      for (const { type, to } of n.out) {
        const list = byType.get(type)
        if (list) list.push(to)
        else byType.set(type, [to])
      }
    for (const [type, targets] of byType) m.edges.push({ type, next: stateFor(closure(targets)) })
    return m
  }
  return stateFor(closure([start]))
}

/** Whether a state can be filled to a valid end using only auto-creatable types. */
const completable = (state: ContentMatch): boolean => state.fillBefore([], true, () => true) !== null
