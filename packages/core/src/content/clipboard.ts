import type { Editor } from '../editor'
import { serializeHTML } from '../html/serialize'
import { parseHTML } from '../html/parse'
import { defaultBlock, isBlock, sanitizeFragment } from './sanitize'
import { nodeText } from './text'
import { mainRange, single } from '../model/selection'
import type { Doc, ElementNode, Mark, Node, Path, Range, SelectionRange } from '../model/types'
import type { Registry } from '../plugin/registry'
import { getFragment, type Fragment } from '../transaction/fragment'
import { marksAt, marksOfRange } from '../transaction/marks'

/** The MIME type of the lossless JSON flavor (a `JSON.stringify`-ed `Fragment`). */
export const FRAGMENT_MIME = 'application/x-hte-fragment'

/**
 * The three clipboard flavors of `range`: `json` is the fragment itself, `html` the fragment
 * serialized as a doc (inline content is wrapped into a default block first), `text` the text of
 * each block (inline elements included, through their `renderText` when they have one) joined by
 * `\n`. With `node` (the `node` of a node selection's range), the fragment is that node alone.
 */
export function serializeForClipboard(
  editor: Editor,
  range: Range,
  node?: Path,
): { html: string; text: string; json: string } {
  const { registry } = editor
  const fragment = getFragment(editor.state.doc, range, node)
  const textOf = (n: Node) => nodeText(n, registry, (plugin) => editor.getPluginOptions(plugin.name))
  const blocks = fragment.length > 0 && isBlock(fragment[0]!, registry)
  const doc: Doc = {
    type: 'doc',
    children: blocks ? (fragment as ElementNode[]) : fragment.length > 0 ? [defaultBlock(registry, fragment)] : [],
  }
  return {
    json: JSON.stringify(fragment),
    html: serializeHTML(doc, registry, (name) => editor.getPluginOptions(name)),
    text: fragment.map(textOf).join(blocks ? '\n' : ''),
  }
}

function fromJson(json: string, registry: Registry): Fragment {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  return Array.isArray(raw) ? sanitizeFragment(raw, registry) : []
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
 * Turns clipboard data into a fragment ready for `insertFragment`. Tries `json` (the
 * `application/x-hte-fragment` flavor), then `html`, then `text`, moving on when a flavor is
 * missing, malformed or yields nothing. JSON and HTML are untrusted: data is validated and unknown
 * types are dropped. Text lines become default blocks (one trailing newline is dropped); a single
 * line is inline text. Text takes the marks typing at the target would get.
 * Finally every plugin's `transformPasted` runs, in priority order, with `options.at`: where the
 * fragment will be inserted (a drop's drop point, or one range of a multi-range paste); omitted or
 * null, at the selection.
 */
export function parseFromClipboard(
  editor: Editor,
  data: { json?: string; html?: string; text?: string },
  options: { at?: SelectionRange | null } = {},
): Fragment {
  let fragment = parseRichClipboard(editor, data)
  if (fragment.length === 0 && data.text) fragment = fromText(data.text, editor.registry, pasteMarks(editor, options.at ?? null))
  return editor.transformPasted(fragment, options.at ?? null)
}

/**
 * The `json` flavor, else the `html` one, as a validated fragment, before `transformPasted`; empty when
 * neither yields content (`parseFromClipboard` then falls back to `text`, whose marks depend on the
 * target). It does not depend on where the fragment goes, so a paste at several ranges parses it once.
 */
export function parseRichClipboard(editor: Editor, data: { json?: string; html?: string }): Fragment {
  const { registry } = editor
  let fragment: Fragment = []
  if (data.json) fragment = fromJson(data.json, registry)
  if (fragment.length === 0 && data.html) fragment = sanitizeFragment(parseHTML(data.html, registry), registry)
  return fragment
}
