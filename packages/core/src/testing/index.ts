import { Editor, type EditorOptions } from '../editor'
import { setIdGenerator } from '../model/id'
import type { Doc, Selection } from '../model/types'
import type { AnyPlugin } from '../plugin/types'

export { doc, el, sel, stripIds, txt } from './builders'

export type TestEditorOptions<P extends readonly AnyPlugin[]> = EditorOptions<P> & { doc?: Doc; selection?: Selection }

/**
 * A headless editor for tests: `dev: true`, `platform: 'other'`, and element ids from a counter
 * (`n1`, `n2`, …) reset on every call. `doc` is the initial content.
 */
export function createTestEditor<const P extends readonly AnyPlugin[]>(opts: TestEditorOptions<P>): Editor<P> {
  let n = 0
  setIdGenerator(() => `n${++n}`)
  const { doc, ...rest } = opts
  return new Editor<P>({ dev: true, platform: 'other', ...rest, content: doc ?? rest.content })
}
