import type { Doc, Mark, Selection } from './model/types'

export interface EditorState {
  readonly doc: Doc
  readonly selection: Selection | null
  readonly storedMarks: Mark[] | null
  readonly pluginStates: ReadonlyMap<string, unknown>
}
