import { Editor, type EditorOptions } from '../editor'
import { createId, setIdGenerator } from '../model/id'
import type { Doc, Selection } from '../model/types'
import type { AnyPlugin } from '../plugin/types'

export { atomEl, doc, el, sel, stripIds, txt } from './builders'

export type TestEditorOptions<P extends readonly AnyPlugin[]> = EditorOptions<P> & { doc?: Doc; selection?: Selection }

/** Copy of `node` whose elements get fresh ids from the current generator, in document order. */
function reId(node: unknown): unknown {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return node
  const el = node as Record<string, unknown>
  if (typeof el.text === 'string') return node
  const id = createId()
  return { ...el, id, ...(Array.isArray(el.children) ? { children: el.children.map(reId) } : {}) }
}

/**
 * A headless editor for tests: `dev: true` and `platform: 'other'`. `doc` is the initial content.
 *
 * Two side effects to know about:
 * - It re-ids the content: every element of `doc` (or `content`) gets a new id `n1`, `n2`, … in
 *   document order; the ids you passed are not kept, so look nodes up by path, or read the ids back
 *   from `editor.state.doc`. Ids created later (normalize, splits) continue after them and never collide.
 * - It swaps the global id generator (`setIdGenerator`) for that counter, reset on every call, and
 *   does not restore it: `createId()` anywhere afterwards, including in other editors, returns
 *   `n…` ids from the latest call's counter.
 */
export function createTestEditor<const P extends readonly AnyPlugin[]>(opts: TestEditorOptions<P>): Editor<P> {
  let n = 0
  setIdGenerator(() => `n${++n}`)
  const { doc, ...rest } = opts
  let content = doc ?? rest.content
  if (content !== undefined && typeof content !== 'string') {
    const raw = content as { children?: unknown }
    // Malformed input is passed through untouched (coerceDoc handles it).
    if (Array.isArray(raw.children)) content = { ...content, children: raw.children.map(reId) } as Doc
  }
  return new Editor<P>({ dev: true, platform: 'other', ...rest, content })
}
