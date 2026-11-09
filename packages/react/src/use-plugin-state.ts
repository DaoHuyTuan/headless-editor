import type { AnyPlugin, Editor, EditorPlugins, StateOf } from '@hte/core'
import { useEditorState } from './use-editor-state'

/**
 * Subscribes to a plugin's state. Re-renders only when that plugin's state object changes identity.
 * `plugin` must be one of the editor's plugins (built-ins included) when the editor's plugin list is
 * known to TypeScript; an editor typed with a generic list (`Editor`, as in `NodeViewProps.editor`)
 * accepts any plugin. A stateless plugin gives `undefined`.
 * @experimental
 */
export function usePluginState<P extends readonly AnyPlugin[], const Pl extends EditorPlugins<P>[number]>(
  editor: Editor<P>,
  plugin: Pl,
): StateOf<Pl> {
  // A generic `Editor<P>` is not assignable to `Editor<readonly AnyPlugin[]>` inside this function.
  const untyped = editor as unknown as Editor<readonly AnyPlugin[]>
  return useEditorState(untyped, (_state, ed) => ed.getPluginState<StateOf<Pl>>(plugin.name), Object.is)
}
