import { getNode, isText, textEntries } from '../model/node'
import { comparePath, comparePoint } from '../model/path'
import type { DeepReadonly, Doc, Path, Point } from '../model/types'

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
 * Groups decorations by the text they fall in (keyed by `pathKey`). Decorations whose points are not
 * in a text of `doc` are dropped; an inline decoration spanning texts is split at their boundaries.
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
    let { from, to } = deco
    if (textLengthAt(doc, from.path) === null || textLengthAt(doc, to.path) === null) continue
    if (comparePoint(from, to) > 0) [from, to] = [to, from]
    const range = { start: from, end: to }
    for (const [text, path] of textEntries(doc as Doc, range)) {
      const start = comparePath(path, from.path) === 0 ? clamp(from.offset, text.text.length) : 0
      const end = comparePath(path, to.path) === 0 ? clamp(to.offset, text.text.length) : text.text.length
      if (end > start) entry(path).inline.push({ from: start, to: end, attrs: deco.attrs })
    }
  }
  for (const e of out.values()) e.widgets.sort((a, b) => a.offset - b.offset)
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
  const widgets = decos?.widgets ?? []
  const parts: LeafPart[] = []
  const widgetsAt = (offset: number): void => {
    for (const w of widgets) if (w.offset === offset) parts.push({ kind: 'widget', key: w.key, render: w.render })
  }
  if (empty) {
    widgetsAt(0)
    parts.push(empty)
    return parts
  }
  const cuts = new Set<number>([0, text.length])
  for (const d of inline) cuts.add(d.from).add(d.to)
  for (const w of widgets) cuts.add(w.offset)
  const sorted = [...cuts].sort((a, b) => a - b)
  sorted.forEach((at, i) => {
    widgetsAt(at)
    const next = sorted[i + 1]
    if (next === undefined) return
    const covering = inline.filter((d) => d.from <= at && d.to >= next).map((d) => d.attrs)
    const segment = text.slice(at, next)
    parts.push(covering.length > 0 ? { kind: 'text', text: segment, attrs: mergeDecoAttrs(covering) } : { kind: 'text', text: segment })
  })
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
