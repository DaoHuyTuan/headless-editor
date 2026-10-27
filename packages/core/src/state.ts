import type { DeepReadonly, Doc, Mark, Selection } from './model/types'

export interface EditorState {
  /** Shared with the renderer and history: never mutate it (use `editor.getJSON()` for a copy). */
  readonly doc: DeepReadonly<Doc>
  readonly selection: Selection | null
  readonly storedMarks: Mark[] | null
  readonly pluginStates: ReadonlyMap<string, unknown>
}
