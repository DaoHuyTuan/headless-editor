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
 * A headless editor for tests: `dev: true`, `platform: 'other'`, and element ids from a counter
 * reset on every call. The content's elements are re-id'd `n1`, `n2`, … in document order, so ids
 * created later (normalize, splits) continue after them and never collide. `doc` is the initial content.
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
