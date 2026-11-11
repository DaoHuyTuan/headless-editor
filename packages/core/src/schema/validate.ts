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
