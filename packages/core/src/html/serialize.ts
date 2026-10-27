import { deepEqualJson, isText } from '../model/node'
import type { Doc, Json, Mark, Node } from '../model/types'
import type { Registry } from '../plugin/registry'
import type { DOMOutputSpec, MarkDOM } from '../plugin/types'

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
])

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;')
}

function attrsToString(attrs: Record<string, string | number | undefined>): string {
  let out = ''
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined) continue
    out += ` ${name}="${escapeAttr(String(value))}"`
  }
  return out
}

function isAttrs(value: unknown): value is Record<string, string | number | undefined> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Renders a DOMOutputSpec; the content hole `0` is replaced by `content`. */
function renderSpec(spec: DOMOutputSpec, content: string): string {
  if (spec === 0) return content
  if (typeof spec === 'string') return escapeText(spec)
  const [tag, maybeAttrs, ...rest] = spec
  let attrs = ''
  let children: DOMOutputSpec[] = rest
  if (isAttrs(maybeAttrs)) attrs = attrsToString(maybeAttrs)
  else if (maybeAttrs !== undefined) children = [maybeAttrs, ...rest]
  if (VOID_TAGS.has(tag.toLowerCase())) return `<${tag}${attrs}>`
  return `<${tag}${attrs}>${children.map((c) => renderSpec(c, content)).join('')}</${tag}>`
}

function kebab(prop: string): string {
  return prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}

function openMark(dom: MarkDOM): string {
  const attrs: Record<string, string> = { ...dom.attrs }
  if (dom.style) {
    const style = Object.entries(dom.style)
      .map(([k, v]) => `${kebab(k)}: ${v};`)
      .join(' ')
    if (style) attrs.style = style
  }
  return `<${dom.tag}${attrsToString(attrs)}>`
}

function sameMark(a: Mark, b: Mark): boolean {
  return a.type === b.type && deepEqualJson(a.data as Json, b.data as Json)
}

/**
 * Serializes a document to an HTML string without touching the DOM (works headless / in SSR).
 * Elements render through their plugin's `renderHTML(node, { options })`; elements of registered
 * types without `renderHTML` are unwrapped (only their children are output); unknown types are
 * skipped. Marks nest in rank order (lowest rank outermost) via `mark.render`; adjacent texts
 * sharing outer marks share their wrappers. Unknown marks are ignored. Text is HTML-escaped.
 */
export function serializeHTML(doc: Doc, registry: Registry, pluginOptions: (name: string) => unknown): string {
  const renderNodes = (nodes: Node[]): string => {
    let out = ''
    // Open mark wrappers: the mark and its closing tag.
    const open: { mark: Mark; close: string }[] = []
    const closeTo = (depth: number) => {
      while (open.length > depth) out += open.pop()!.close
    }
    for (const node of nodes) {
      if (!isText(node)) {
        closeTo(0)
        out += renderElement(node)
        continue
      }
      const marks = node.marks
        .filter((m) => registry.mark(m.type))
        .sort((a, b) => registry.markRank(a.type) - registry.markRank(b.type))
      let keep = 0
      while (keep < open.length && keep < marks.length && sameMark(open[keep]!.mark, marks[keep]!)) keep++
      closeTo(keep)
      for (const mark of marks.slice(keep)) {
        const dom = registry.mark(mark.type)!.render(mark.data)
        out += openMark(dom)
        open.push({ mark, close: `</${dom.tag}>` })
      }
      out += escapeText(node.text)
    }
    closeTo(0)
    return out
  }

  const renderElement = (node: Exclude<Node, { text: string }>): string => {
    const registered = registry.node(node.type)
    if (!registered) return ''
    const content = renderNodes(node.children ?? [])
    const render = registered.plugin.spec.renderHTML
    if (!render) return content
    return renderSpec(render(node, { options: pluginOptions(registered.plugin.name) }), content)
  }

  return doc.children.map(renderElement).join('')
}
