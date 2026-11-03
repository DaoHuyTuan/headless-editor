import type { DeepReadonly, ElementNode, Node, TextNode } from '../model/types'
import type { Registry } from '../plugin/registry'
import type { AnyPlugin } from '../plugin/types'

/** A plugin's options as `renderText` gets them; by default its configured options. */
export type OptionsLookup = (plugin: AnyPlugin) => unknown

const configured: OptionsLookup = (plugin) => plugin.spec.options ?? {}

/**
 * The plain text of `node`: a text's own text; an element's `renderText` (its plugin's hook, given
 * `options(plugin)`), else its children's text joined. So a childless element without `renderText`
 * (an atom whose plugin declares none, an unknown type) has none.
 */
export function nodeText(node: Node | DeepReadonly<Node>, registry: Registry, options: OptionsLookup = configured): string {
  if (typeof (node as TextNode).text === 'string') return (node as TextNode).text
  const el = node as DeepReadonly<ElementNode>
  const plugin = registry.node(el.type)?.plugin
  const render = plugin?.spec.renderText
  if (plugin && render) return render(el, { options: options(plugin) })
  return (el.children ?? []).map((c) => nodeText(c, registry, options)).join('')
}
