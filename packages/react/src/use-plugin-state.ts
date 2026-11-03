import type { AnyPlugin, Editor, StateOf } from '@hte/core'
import { useEditorState } from './use-editor-state'

/**
 * Subscribes to a plugin's state. Re-renders only when that plugin's state object changes identity.
 * @experimental
 */
export function usePluginState<P extends AnyPlugin>(editor: Editor<readonly AnyPlugin[]>, plugin: P): StateOf<P> {
  return useEditorState(editor, (_state, ed) => ed.getPluginState<StateOf<P>>(plugin.name), Object.is)
}
