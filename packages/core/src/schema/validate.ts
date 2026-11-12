import { createId } from '../model/id'
import { isText } from '../model/node'
import type { DeepReadonly, Doc, ElementNode, Node } from '../model/types'
import type { Registry } from '../plugin/registry'
import type { ContentMatch } from './content-match'

/**
 * The state after `node` in content at `state`, or null when it does not fit. An unknown element
 * is a wildcard (rule 7): it takes the state's first edge, or, at a state with no edge left, is
 * passed over without consuming anything, so a doc with a missing plugin is never repaired around it.
 */
export function matchChild(state: ContentMatch, node: DeepReadonly<Node>, registry: Registry): ContentMatch | null {
  if (isText(node)) return state.matchType('text')
  if (registry.node(node.type)) return state.matchType(node.type)
  return state.edges[0]?.next ?? state
}

/** The types to wrap an inline run in at `state`, outermost first, ending with a textblock; null if none. */
export function inlineWrapping(state: ContentMatch, registry: Registry): string[] | null {
  const type = state.defaultType
  if (type && registry.isTextblock(type)) return [type]
  const wrappers = state.findWrapping(registry.defaultBlock)
  return wrappers ? [...wrappers, registry.defaultBlock] : null
}

/** A new element chain of `types` (outermost first, fresh ids, data `{}`) whose innermost element holds `children`. */
export function wrapChain(types: readonly string[], children: Node[]): ElementNode {
  let node: ElementNode | null = null
  for (let k = types.length - 1; k >= 0; k--) {
    node = { id: createId(), type: types[k]!, data: {}, children: node ? [node] : children }
  }
  return node!
}

/**
 * Whether `doc` is valid against the schema of `registry`: the children of the doc and of every
 * known non-atom element match its content expression to a valid end, and texts carry only the
 * marks their parent allows. Unknown types and atoms are opaque (their subtrees are not checked).
 */
export function isValidDoc(doc: DeepReadonly<Doc>, registry: Registry): boolean {
  return validContent('doc', doc.children as readonly DeepReadonly<Node>[], registry)
}

function validContent(owner: string, children: readonly DeepReadonly<Node>[], registry: Registry): boolean {
  let state: ContentMatch | null = registry.contentMatch(owner)!
  for (const child of children) {
    state = matchChild(state, child, registry)
    if (!state) return false
    if (isText(child)) {
      if (child.marks.some((m) => !registry.allowsMark(owner, m.type))) return false
    } else if (!validElement(child as DeepReadonly<ElementNode>, registry)) return false
  }
  return state.validEnd
}

function validElement(node: DeepReadonly<ElementNode>, registry: Registry): boolean {
  const spec = registry.node(node.type)
  if (!spec || spec.atom) return true
  return validContent(node.type, (node.children ?? []) as readonly DeepReadonly<Node>[], registry)
}

/**
 * Whether `nodes` are valid content for `owner` (an element type, or `'doc'`) up to a valid end.
 * Unknown types fit (rule 7, `matchChild`); an unknown or atom owner holds nothing.
 */
export function fits(registry: Registry, owner: string, nodes: readonly DeepReadonly<Node>[]): boolean {
  let state = registry.contentMatch(owner) ?? null
  for (const node of nodes) {
    if (!state) return false
    state = matchChild(state, node, registry)
  }
  return !!state && state.validEnd
}

/** Whether some direct text of `nodes` has a mark `owner` does not allow. */
export function bannedMarks(registry: Registry, owner: string, nodes: readonly DeepReadonly<Node>[]): boolean {
  return nodes.some((n) => isText(n) && n.marks.some((m) => !registry.allowsMark(owner, m.type)))
}

/** Whether a direct text of `nodes` holds a `\n`, which only text-only content keeps (rule 11). */
export function hasNewline(nodes: readonly DeepReadonly<Node>[]): boolean {
  return nodes.some((n) => isText(n) && n.text.includes('\n'))
}
