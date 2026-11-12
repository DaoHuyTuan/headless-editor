import type { Editor } from '../editor'
import { serializeHTML } from '../html/serialize'
import { parseHTML } from '../html/parse'
import { defaultBlock, dropCollector, isBlock, sanitizeFragment } from './sanitize'
import { nodeText } from './text'
import { mainRange, single } from '../model/selection'
import { cloneJson, getNode } from '../model/node'
import type { Data, DeepReadonly, Doc, ElementNode, Mark, Node, Path, Range, SelectionRange } from '../model/types'
import type { Registry } from '../plugin/registry'
import type { DropHandler } from '../load'
import type { Fragment } from '../transaction/fragment'
import { clampSlice, fragmentSlice, hasFragmentDepths, sliceAt, type Slice } from '../transaction/slice'
import { fits } from '../schema/validate'
import { marksAt, marksOfRange } from '../transaction/marks'

/**
 * The MIME type of the lossless JSON flavor: a `JSON.stringify`-ed `Slice` (`{ content, openStart,
 * openEnd }`), or the `Fragment` alone when the slice has a fragment's open depths (`fragmentSlice`),
 * as 0.1 and 0.2 wrote it.
 */
export const FRAGMENT_MIME = 'application/x-penline-fragment'

/**
 * The three clipboard flavors of the slice of `range` (`sliceAt`): `json` is the slice (see
 * `FRAGMENT_MIME`), `html` its content serialized as a doc (inline content is wrapped into a default
 * block first; blocks the root does not accept, such as list items, inside copies of their ancestors
 * up to the first one it does: two `<li>` go out inside their `<ul>`), `text` the text of each
 * textblock at every depth (inline elements included, through their `renderText` when they have one)
 * joined by `\n`. With `node` (the `node` of a node selection's range), the slice is that node alone.
 */
export function serializeForClipboard(
  editor: Editor,
  range: Range,
  node?: Path,
): { html: string; text: string; json: string } {
  const { registry } = editor
  const { slice, ancestor } = sliceAt(editor.state.doc, registry, range, node)
  const fragment = slice.content
  const textOf = (n: Node) => nodeText(n, registry, (plugin) => editor.getPluginOptions(plugin.name))
  const blocks = fragment.length > 0 && isBlock(fragment[0]!, registry)
  const doc: Doc = {
    type: 'doc',
    children: blocks
      ? wrapInAncestors(editor.state.doc, registry, fragment as ElementNode[], ancestor)
      : fragment.length > 0
        ? [defaultBlock(registry, fragment)]
        : [],
  }
  return {
    json: JSON.stringify(hasFragmentDepths(slice, registry) ? fragment : slice),
    html: serializeHTML(doc, registry, (name) => editor.getPluginOptions(name)),
    text: fragment.map(textOf).join(blocks ? '\n' : ''),
  }
}

/**
 * `blocks` (children of the node at `ancestor`) wrapped in copies of that node and its ancestors,
 * innermost first, until the doc accepts them (no wrapping when it already does).
 */
function wrapInAncestors(doc: DeepReadonly<Doc>, registry: Registry, blocks: ElementNode[], ancestor: Path): ElementNode[] {
  let out = blocks
  for (let path = ancestor; path.length > 0 && !fits(registry, 'doc', out); path = path.slice(0, -1)) {
    const node = getNode(doc, path) as DeepReadonly<ElementNode>
    out = [{ id: node.id, type: node.type, data: cloneJson(node.data as Data), children: out }]
  }
  return out
}

/**
 * The slice of a `FRAGMENT_MIME` payload, sanitized; null when it is malformed. A slice object keeps
 * its open depths (clamped to its sanitized content); a bare array (0.1 / 0.2, or a slice with a
 * fragment's depths) is a fragment, with no open depths of its own (`depths: false`).
 */
function fromJson(json: string, registry: Registry, onDrop: DropHandler): { slice: Slice; depths: boolean } | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (Array.isArray(raw)) return { slice: fragmentSlice(sanitizeFragment(raw, registry, onDrop), registry), depths: false }
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { content?: unknown }).content)) return null
  const { content, openStart, openEnd } = raw as { content: unknown[]; openStart?: unknown; openEnd?: unknown }
  const slice = { content: sanitizeFragment(content, registry, onDrop), openStart, openEnd } as Slice
  return { slice: clampSlice(slice, registry), depths: true }
}

function fromText(text: string, registry: Registry, marks: Mark[]): Fragment {
  const lines = text.split(/\r\n|\r|\n/)
  // A copied line usually ends with its newline: that one does not start another block.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 1) return [{ text: lines[0]!, marks }]
  return lines.map((line) => defaultBlock(registry, [{ text: line, marks }]))
}

/** The marks plain text pasted at `at` (else the selection) gets: those typing there would get. */
function pasteMarks(editor: Editor, at: SelectionRange | null): Mark[] {
  const { doc, selection, storedMarks } = editor.state
  const range = at ?? (selection && mainRange(selection))
  if (!range) return []
  if (!at && storedMarks) return storedMarks
  const covered = marksOfRange(doc, range, editor.registry)
  return covered ?? marksAt({ doc, selection: single(range), storedMarks: null })
}

/**
 * A parsed paste: the slice, and whether its open depths came with it (a `FRAGMENT_MIME` slice
 * object). Without them, the slice has a fragment's open depths, recomputed after `transformPasted`.
 */
export interface PastedSlice {
  slice: Slice
  depths: boolean
}

/**
 * Turns clipboard data into a fragment ready for `insertFragment`: the content of
 * `parseSliceFromClipboard`.
 */
export function parseFromClipboard(
  editor: Editor,
  data: { json?: string; html?: string; text?: string },
  options: { at?: SelectionRange | null } = {},
): Fragment {
  return parseSliceFromClipboard(editor, data, options).content
}

/**
 * Turns clipboard data into a slice ready for `insertSlice`. Tries `json` (the
 * `application/x-penline-fragment` flavor), then `html`, then `text`, moving on when a flavor is
 * missing, malformed or yields nothing. JSON and HTML are untrusted: data is validated and unknown
 * types are dropped. Text lines become default blocks (one trailing newline is dropped); a single
 * line is inline text. Text takes the marks typing at the target would get. Only a JSON slice has
 * open depths of its own; anything else has a fragment's (`fragmentSlice`).
 * Finally every plugin's `transformPasted` runs on the slice's content (`transformPastedSlice`), in
 * priority order, with `options.at`: where the slice will be inserted (a drop's drop point, or one
 * range of a multi-range paste); omitted or null, at the selection.
 */
export function parseSliceFromClipboard(
  editor: Editor,
  data: { json?: string; html?: string; text?: string },
  options: { at?: SelectionRange | null } = {},
): Slice {
  let pasted = parseRichSlice(editor, data)
  if (pasted.slice.content.length === 0 && data.text) {
    const fragment = fromText(data.text, editor.registry, pasteMarks(editor, options.at ?? null))
    pasted = { slice: fragmentSlice(fragment, editor.registry), depths: false }
  }
  return transformPastedSlice(editor, pasted, options.at ?? null)
}

/**
 * `editor.transformPasted` on the content of `pasted.slice`: a slice with depths of its own keeps
 * them, clamped to what the returned content supports; one without gets a fragment's depths for
 * the returned content.
 */
export function transformPastedSlice(editor: Editor, pasted: PastedSlice, at: SelectionRange | null): Slice {
  const content = editor.transformPasted(pasted.slice.content, at)
  return pasted.depths
    ? clampSlice({ ...pasted.slice, content }, editor.registry)
    : fragmentSlice(content, editor.registry)
}

/**
 * The `json` flavor, else the `html` one, as a validated fragment, before `transformPasted`; empty when
 * neither yields content (`parseFromClipboard` then falls back to `text`, whose marks depend on the
 * target). It does not depend on where the fragment goes, so a paste at several ranges parses it once.
 * Malformed nodes and marks dropped on the way are reported as one warning (not one each).
 */
export function parseRichClipboard(editor: Editor, data: { json?: string; html?: string }): Fragment {
  return parseRichSlice(editor, data).slice.content
}

/** `parseRichClipboard` as a slice: a JSON slice keeps its open depths (`fromJson`). */
export function parseRichSlice(editor: Editor, data: { json?: string; html?: string }): PastedSlice {
  const { registry } = editor
  let pasted: PastedSlice | null = null
  const drops = dropCollector()
  if (data.json) pasted = fromJson(data.json, registry, drops.onDrop)
  if ((!pasted || pasted.slice.content.length === 0) && data.html) {
    const fragment = sanitizeFragment(parseHTML(data.html, registry), registry, drops.onDrop)
    pasted = { slice: fragmentSlice(fragment, registry), depths: false }
  }
  drops.warn('pasted content')
  return pasted ?? { slice: { content: [], openStart: 0, openEnd: 0 }, depths: false }
}
