import { getNode, isText } from '../model/node'
import { checkAttrName } from '../plugin/attrs'
import { comparePath, comparePoint } from '../model/path'
import type { DeepReadonly, Doc, Node, Path, Point, TextNode } from '../model/types'

/** Attributes of an inline decoration's spans; `class` values of overlapping decorations are joined. */
export type DecorationAttrs = { class?: string; [k: string]: string | undefined }

/** Styles the text between `from` and `to` (it may span several texts); never part of the model. */
export interface InlineDecoration {
  type: 'inline'
  from: Point
  to: Point
  attrs: DecorationAttrs
}

/**
 * A non-editable element shown at `at` (a point in a text), keyed by `key`: while a widget with the
 * same key is decorated, its element is reused (`render` runs once). Never part of the model.
 *
 * Placement: the widget is rendered inside the text's leaf, inside its mark wrappers, between the
 * text segments at `at.offset` (so it inherits the text's mark styling). It gets
 * `contenteditable="false"` and `data-hte-widget`; its text never counts as model text, a DOM
 * position inside it maps to the point before it, and DOM mutations inside it are ignored.
 */
export interface WidgetDecoration {
  type: 'widget'
  at: Point
  key: string
  render: (doc: Document) => HTMLElement
}

export type Decoration = InlineDecoration | WidgetDecoration

/** Marks a rendered widget element: its content is not model text and its mutations are ignored. */
export const WIDGET_ATTR = 'data-hte-widget'
/** Marks the span of an inline decoration segment. */
export const DECO_ATTR = 'data-hte-deco'

/** The decorations that fall in one text, with offsets local to it. */
export interface LeafDecorations {
  inline: { from: number; to: number; attrs: DecorationAttrs }[]
  widgets: { offset: number; key: string; render: (doc: Document) => HTMLElement }[]
}

/** A piece of a decorated leaf's content, in order. */
export type LeafPart =
  | { kind: 'text'; text: string; attrs?: Record<string, string> }
  | { kind: 'widget'; key: string; render: (doc: Document) => HTMLElement }
  | { kind: 'break' }

export function pathKey(path: Path): string {
  return path.join(',')
}

function textLengthAt(doc: DeepReadonly<Doc>, path: Path): number | null {
  try {
    const node = getNode(doc as Doc, path)
    return isText(node) ? node.text.length : null
  } catch {
    return null
  }
}

function clamp(n: number, max: number): number {
  return Math.min(Math.max(0, n), max)
}

/**
 * The first attribute name of `attrs` that is not a valid HTML attribute name, or null. Checked
 * before rendering, so a bad decoration is dropped instead of failing the render midway.
 */
function invalidAttrName(attrs: DecorationAttrs): string | null {
  for (const name of Object.keys(attrs)) {
    try {
      checkAttrName(name)
    } catch {
      return name
    }
  }
  return null
}

/**
 * Groups decorations by the text they fall in (keyed by `pathKey`). Decorations whose points are not
 * in a text of `doc` are dropped; an inline decoration spanning texts is split at their boundaries.
 * An inline decoration with an invalid attribute name is dropped with a `console.warn`.
 */
export function groupDecorations(doc: DeepReadonly<Doc>, decorations: readonly Decoration[]): Map<string, LeafDecorations> {
  const out = new Map<string, LeafDecorations>()
  const entry = (path: Path): LeafDecorations => {
    const key = pathKey(path)
    let e = out.get(key)
    if (!e) out.set(key, (e = { inline: [], widgets: [] }))
    return e
  }
  for (const deco of decorations) {
    if (deco.type === 'widget') {
      const length = textLengthAt(doc, deco.at.path)
      if (length === null) continue
      entry(deco.at.path).widgets.push({ offset: clamp(deco.at.offset, length), key: deco.key, render: deco.render })
      continue
    }
    const bad = invalidAttrName(deco.attrs)
    if (bad !== null) {
      console.warn(`[hte] Dropped an inline decoration with an invalid attribute name "${bad}"`)
      continue
    }
    let { from, to } = deco
    const fromLength = textLengthAt(doc, from.path)
    if (fromLength === null) continue
    if (comparePath(from.path, to.path) === 0) {
      // Within one text (the common case): no walk.
      const start = clamp(Math.min(from.offset, to.offset), fromLength)
      const end = clamp(Math.max(from.offset, to.offset), fromLength)
      if (end > start) entry(from.path).inline.push({ from: start, to: end, attrs: deco.attrs })
      continue
    }
    if (textLengthAt(doc, to.path) === null) continue
    if (comparePoint(from, to) > 0) [from, to] = [to, from]
    for (const [text, path] of textsBetween(doc, from.path, to.path)) {
      const start = comparePath(path, from.path) === 0 ? clamp(from.offset, text.text.length) : 0
      const end = comparePath(path, to.path) === 0 ? clamp(to.offset, text.text.length) : text.text.length
      if (end > start) entry(path).inline.push({ from: start, to: end, attrs: deco.attrs })
    }
  }
  for (const e of out.values()) {
    // Stable: widgets at the same offset keep their decoration order.
    if (e.widgets.length > 1) e.widgets.sort((a, b) => a.offset - b.offset)
  }
  return out
}

/**
 * The texts from the text at `from` to the text at `to` (both included, `from` before `to`), in
 * document order. Only the nodes between the two paths are visited.
 */
function textsBetween(doc: DeepReadonly<Doc>, from: Path, to: Path): [TextNode, Path][] {
  const out: [TextNode, Path][] = []
  const visit = (children: readonly Node[], prefix: Path, lo: Path | null, hi: Path | null): void => {
    const depth = prefix.length
    const first = lo ? lo[depth]! : 0
    const last = hi ? hi[depth]! : children.length - 1
    for (let i = first; i <= last && i < children.length; i++) {
      const child = children[i]!
      const path = [...prefix, i]
      if (isText(child)) out.push([child, path])
      else visit(child.children ?? [], path, lo && i === first ? lo : null, hi && i === last ? hi : null)
    }
  }
  visit((doc as Doc).children, [], from, to)
  return out
}

/** A string that changes whenever the leaf's decorations would render differently (attrs, ranges, widget keys). */
export function decorationSignature(decos: LeafDecorations | undefined): string {
  if (!decos || (decos.inline.length === 0 && decos.widgets.length === 0)) return ''
  return JSON.stringify([decos.inline.map((d) => [d.from, d.to, d.attrs]), decos.widgets.map((w) => [w.offset, w.key])])
}

function mergeDecoAttrs(list: DecorationAttrs[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const attrs of list) {
    for (const [name, value] of Object.entries(attrs)) {
      if (value === undefined) continue
      out[name] = name === 'class' && out.class ? `${out.class} ${value}` : value
    }
  }
  return out
}

/**
 * The parts of a leaf's content inside its mark wrappers: the text split at decoration boundaries
 * (covered segments carry the merged attrs of their decorations) with widgets at their offsets.
 * An empty text shows its widgets, then `empty` (the break or the zero-width placeholder).
 */
export function leafParts(text: string, decos: LeafDecorations | undefined, empty: LeafPart | null): LeafPart[] {
  const inline = decos?.inline ?? []
  // Sorted by offset (see `groupDecorations`): consumed by a pointer as the sweep advances.
  const widgets = decos?.widgets ?? []
  const parts: LeafPart[] = []
  let w = 0
  const widgetsUpTo = (offset: number): void => {
    for (; w < widgets.length && widgets[w]!.offset <= offset; w++) {
      const widget = widgets[w]!
      parts.push({ kind: 'widget', key: widget.key, render: widget.render })
    }
  }
  if (empty) {
    widgetsUpTo(0)
    parts.push(empty)
    return parts
  }
  if (inline.length === 0 && widgets.length === 0) return [{ kind: 'text', text }]
  const cuts = new Set<number>([0, text.length])
  for (const d of inline) cuts.add(d.from).add(d.to)
  for (const widget of widgets) cuts.add(widget.offset)
  const sorted = [...cuts].sort((a, b) => a - b)
  // Sweep the cuts with the set of decorations covering the current segment (indexes, so the
  // merged attrs follow decoration order).
  const byStart = inline.map((_, i) => i).sort((a, b) => inline[a]!.from - inline[b]!.from)
  let s = 0
  let active: number[] = []
  for (let i = 0; i < sorted.length; i++) {
    const at = sorted[i]!
    widgetsUpTo(at)
    const next = sorted[i + 1]
    if (next === undefined) break
    let changed = false
    if (active.some((d) => inline[d]!.to <= at)) {
      active = active.filter((d) => inline[d]!.to > at)
      changed = true
    }
    for (; s < byStart.length && inline[byStart[s]!]!.from <= at; s++) {
      if (inline[byStart[s]!]!.to > at) active.push(byStart[s]!)
      changed = true
    }
    if (changed && active.length > 1) active.sort((a, b) => a - b)
    const segment = text.slice(at, next)
    parts.push(
      active.length > 0
        ? { kind: 'text', text: segment, attrs: mergeDecoAttrs(active.map((d) => inline[d]!.attrs)) }
        : { kind: 'text', text: segment },
    )
  }
  return parts
}

/** The closest widget element that is or contains `node`, below `root`, or null. */
export function widgetAround(root: globalThis.Node, node: globalThis.Node | null): Element | null {
  let cur: globalThis.Node | null = node
  while (cur && cur !== root) {
    if (cur.nodeType === 1 && (cur as Element).hasAttribute(WIDGET_ATTR)) return cur as Element
    cur = cur.parentNode
  }
  return null
}

/** The DOM texts inside `el`, in order, skipping widget content (it is not model text). */
export function textsOutsideWidgets(el: globalThis.Node): Text[] {
  const out: Text[] = []
  const walk = (n: globalThis.Node): void => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) out.push(c as Text)
      else if (c.nodeType === 1 && !(c as Element).hasAttribute(WIDGET_ATTR)) walk(c)
    }
  }
  walk(el)
  return out
}
