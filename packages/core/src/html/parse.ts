import { createId } from '../model/id'
import { deepEqualJson, isText } from '../model/node'
import type { Data, ElementNode, Mark, Node, TextNode } from '../model/types'
import type { Registry } from '../plugin/registry'
import type { AnyPlugin, ParseRule } from '../plugin/types'
import type { Fragment } from '../transaction/fragment'

/** Priority of a parse rule that declares none. */
const DEFAULT_RULE_PRIORITY = 50

/** Unregistered tags that still start a block (they become default blocks, or are unwrapped). */
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer',
  'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
])
/** Elements whose content is never parsed. */
/** Skipped with their content: document metadata, scripts, embedded content and form controls. */
const SKIP_TAGS = new Set([
  'head', 'link', 'meta', 'noscript', 'script', 'style', 'template', 'title',
  'iframe', 'object', 'embed', 'svg', 'select', 'textarea', 'button',
])

/**
 * Nesting depth past which an element's content is read as flat text (with the marks from above):
 * pasted HTML can nest arbitrarily deep, and parsing recurses per level.
 */
const MAX_DEPTH = 256

const BOUNDARY = { kind: 'boundary' } as const
const BREAK = { kind: 'break' } as const
/** A parsed node, or a marker: `boundary` ends the current inline run, `break` (`<br>`) also forces a block. */
type Item = Node | typeof BOUNDARY | typeof BREAK

interface Rule {
  rule: ParseRule
  plugin: AnyPlugin
}

function isNode(item: Item): item is Node {
  return item !== BOUNDARY && item !== BREAK
}

function sortedRules(registry: Registry, pick: (p: AnyPlugin) => boolean): Rule[] {
  const rules: Rule[] = []
  // registry.plugins is already sorted by plugin priority; the sort below is stable.
  for (const plugin of registry.plugins) {
    if (!pick(plugin)) continue
    for (const rule of plugin.spec.parseHTML ?? []) rules.push({ rule, plugin })
  }
  return rules.sort(
    (a, b) => (b.rule.priority ?? DEFAULT_RULE_PRIORITY) - (a.rule.priority ?? DEFAULT_RULE_PRIORITY),
  )
}

/** The rule's data for `el`, or null when the rule does not match. */
function matchRule(rule: ParseRule, el: HTMLElement): Data | null {
  if (!rule.tag && !rule.style) return null
  if (rule.tag && rule.tag.toLowerCase() !== el.tagName.toLowerCase()) return null
  let styleValue: string | undefined
  if (rule.style) {
    styleValue = el.style?.getPropertyValue(rule.style).trim()
    if (!styleValue) return null
  }
  const data = rule.getData ? rule.getData(el, styleValue) : {}
  return data === false ? null : (data ?? {})
}

function withMark(marks: Mark[], mark: Mark, registry: Registry): Mark[] {
  return [...marks.filter((m) => m.type !== mark.type), mark].sort(
    (a, b) => registry.markRank(a.type) - registry.markRank(b.type),
  )
}

function sameMarks(a: Mark[], b: Mark[]): boolean {
  return a.length === b.length && a.every((m, i) => m.type === b[i]!.type && deepEqualJson(m.data, b[i]!.data))
}

class Parser {
  private readonly nodeRules: Rule[]
  private readonly markRules: Rule[]

  /** Texts read inside `<pre>`: their whitespace is kept as is (no collapsing, no trimming). */
  readonly preTexts = new WeakSet<TextNode>()

  constructor(private readonly registry: Registry) {
    this.nodeRules = sortedRules(registry, (p) => !!p.spec.node)
    this.markRules = sortedRules(registry, (p) => !!p.spec.mark)
  }

  /** Parses the children of `parent` into items (`depth`: how deep `parent` is). */
  children(parent: globalThis.Node, marks: Mark[], pre: boolean, depth = 0): Item[] {
    const out: Item[] = []
    if (depth >= MAX_DEPTH) {
      this.flatText(parent, marks, pre, out)
      return out
    }
    for (const child of Array.from(parent.childNodes)) this.node(child, marks, pre, out, depth + 1)
    return out
  }

  private text(raw: string, marks: Mark[], pre: boolean, out: Item[]): void {
    const text = pre ? raw : raw.replace(/[ \t\n\r\f]+/g, ' ')
    if (!text) return
    const node: TextNode = { text, marks }
    if (pre) this.preTexts.add(node)
    out.push(node)
  }

  /** The texts below `parent`, in order, without recursion (past `MAX_DEPTH`); skipped tags stay skipped. */
  private flatText(parent: globalThis.Node, marks: Mark[], pre: boolean, out: Item[]): void {
    const stack: globalThis.Node[] = Array.from(parent.childNodes).reverse()
    while (stack.length > 0) {
      const n = stack.pop()!
      if (n.nodeType === 3) this.text(n.nodeValue ?? '', marks, pre, out)
      else if (n.nodeType === 1 && !SKIP_TAGS.has((n as Element).tagName.toLowerCase()))
        for (let i = n.childNodes.length - 1; i >= 0; i--) stack.push(n.childNodes[i]!)
    }
  }

  /** `marks` plus the mark of every mark plugin whose rule matches `el` (tag or style). */
  private marksOf(el: HTMLElement, marks: Mark[]): Mark[] {
    let out = marks
    const matched = new Set<string>()
    for (const { rule, plugin } of this.markRules) {
      if (matched.has(plugin.name)) continue
      const data = matchRule(rule, el)
      if (!data) continue
      matched.add(plugin.name)
      out = withMark(out, { type: plugin.name, data }, this.registry)
    }
    return out
  }

  private node(dom: globalThis.Node, marks: Mark[], pre: boolean, out: Item[], depth: number): void {
    if (dom.nodeType === 3) {
      this.text(dom.nodeValue ?? '', marks, pre, out)
      return
    }
    if (dom.nodeType !== 1) return
    const el = dom as HTMLElement
    const tag = el.tagName.toLowerCase()
    if (SKIP_TAGS.has(tag)) return
    if (tag === 'br') {
      out.push(BREAK)
      return
    }
    const innerPre = pre || tag === 'pre'

    for (const { rule, plugin } of this.nodeRules) {
      const data = matchRule(rule, el)
      if (data) {
        // Mark styles on the element itself (`<p style="font-weight: bold">`) apply to its content.
        out.push(...this.element(plugin, data, el, this.marksOf(el, marks), innerPre, depth))
        return
      }
    }

    const items = this.children(el, this.marksOf(el, marks), innerPre, depth)
    if (!BLOCK_TAGS.has(tag)) {
      out.push(...items) // unknown inline tag: unwrapped
      return
    }
    // Unknown block tag: its inline runs become default blocks; nested blocks are kept as they are.
    // Whitespace-only content (outside `<pre>`) counts as no content: an empty block.
    out.push(BOUNDARY)
    if (items.every((i) => isNode(i) && isText(i) && !this.preTexts.has(i) && i.text.trim() === '')) out.push(BREAK)
    else out.push(...items)
    out.push(BOUNDARY)
  }

  private element(plugin: AnyPlugin, data: Data, el: HTMLElement, marks: Mark[], pre: boolean, depth: number): Item[] {
    const spec = plugin.spec.node!
    const node: ElementNode = { id: createId(), type: plugin.name, data }
    if (spec.kind === 'inline') {
      // Whitespace collapses across its texts too; its edges stay (they separate it from the text around).
      if (!spec.atom) node.children = collapseRun(inlineOnly(this.children(el, marks, pre, depth)), this.preTexts, false)
      return [node]
    }
    if (spec.atom) return [BOUNDARY, node, BOUNDARY]
    const items = this.children(el, marks, pre, depth)
    const hasBlocks = items.some((i) => isNode(i) && this.isBlock(i))
    // A block that may hold blocks: no `content` (for now) or a container expression such as `block+`.
    if ((spec.content === undefined || !this.registry.isTextblock(plugin.name)) && hasBlocks) {
      node.children = this.blockify(items)
      return [BOUNDARY, node, BOUNDARY]
    }
    // Inline content: nested blocks split this block into several of the same type.
    const blocks = this.blockify(items, plugin.name, data)
    if (blocks.length === 0) blocks.push({ ...node, children: [{ text: '', marks: [] }] })
    return [BOUNDARY, ...blocks, BOUNDARY]
  }

  isBlock(node: Node): boolean {
    return !isText(node) && this.registry.node(node.type)?.kind !== 'inline'
  }

  /**
   * Groups items into blocks: inline runs become blocks of `type` (whitespace-only runs are
   * dropped unless a `<br>` forces the block), block items are kept, and `<br>` ends a block.
   */
  blockify(items: Item[], type = this.registry.defaultBlock, data: Data = {}): ElementNode[] {
    const blocks: ElementNode[] = []
    let run: Node[] = []
    let first = true
    const flush = (force: boolean) => {
      const children = collapseRun(run, this.preTexts, true)
      run = []
      if (!force && children.length === 0) return
      blocks.push({
        id: createId(),
        type,
        data: first ? data : structuredClone(data),
        children: children.length > 0 ? children : [{ text: '', marks: [] }],
      })
      first = false
    }
    for (const item of items) {
      if (!isNode(item)) flush(item === BREAK)
      else if (this.isBlock(item)) {
        flush(false)
        blocks.push(item as ElementNode)
      } else run.push(item)
    }
    flush(false)
    return blocks
  }
}

/** Inline nodes of `items`: markers are dropped and blocks are replaced by their (inline) children. */
function inlineOnly(items: Item[]): Node[] {
  const out: Node[] = []
  for (const item of items) {
    if (!isNode(item)) continue
    if (isText(item) || !item.children) out.push(item)
    else out.push(...inlineOnly(item.children))
  }
  return out
}

/**
 * Collapses whitespace across adjacent texts, merges texts with the same marks and drops empty
 * texts; with `trim`, also trims the run's leading and trailing whitespace. Texts in `pre` (read
 * inside `<pre>`) keep their whitespace, edges included.
 */
function collapseRun(run: Node[], pre: WeakSet<TextNode>, trim: boolean): Node[] {
  const out: Node[] = []
  for (const node of run) {
    if (!isText(node)) {
      out.push(node)
      continue
    }
    const prev = out[out.length - 1]
    const prevText = prev && isText(prev) ? prev : null
    let text = node.text
    const startsRun = trim && !prev
    if (!pre.has(node) && (startsRun || prevText?.text.endsWith(' ')) && text.startsWith(' ')) text = text.replace(/^ +/, '')
    if (!text) continue
    if (prevText && sameMarks(prevText.marks, node.marks)) {
      prevText.text += text
      if (pre.has(node)) pre.add(prevText)
    } else {
      const copy: TextNode = { text, marks: node.marks }
      if (pre.has(node)) pre.add(copy)
      out.push(copy)
    }
  }
  const last = out[out.length - 1]
  if (trim && last && isText(last) && !pre.has(last)) {
    last.text = last.text.replace(/ +$/, '')
    if (!last.text) out.pop()
  }
  return out
}

/**
 * Parses an HTML string into a block fragment using the plugins' `parseHTML` rules (needs a global
 * `DOMParser`). Element rules are tried by rule priority (default 50), then plugin priority; every
 * mark plugin whose rule matches the element (tag or style) adds its mark to the content, whether an
 * element rule matched or not (`<p style="font-weight: bold">`). Unknown inline tags are
 * unwrapped; unknown block tags become default blocks (an empty one for whitespace-only content),
 * or are unwrapped when they contain blocks. Inline content outside blocks (e.g. bare text) is
 * wrapped into default blocks. Whitespace runs collapse to one space, across adjacent texts too
 * (inline elements included); whitespace-only text between blocks is dropped and block content is
 * trimmed. Inside `<pre>` whitespace is kept as is, edges included. Past `MAX_DEPTH` levels of
 * nesting, content is read as flat text. M1 has no hard-break node, so `<br>` splits the block.
 * Load the result with `coerceDoc` + `normalize`, or paste it with `insertFragment`.
 */
export function parseHTML(html: string, registry: Registry): Fragment {
  if (typeof DOMParser === 'undefined') throw new Error('parseHTML requires a DOM (DOMParser)')
  const body = new DOMParser().parseFromString(html, 'text/html').body
  const parser = new Parser(registry)
  return parser.blockify(parser.children(body, [], false))
}
