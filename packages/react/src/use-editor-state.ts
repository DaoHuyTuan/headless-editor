import { useCallback, useRef, useSyncExternalStore } from 'react'
import type { AnyPlugin, Editor, EditorState } from '@hte/core'

/**
 * Subscribes to the editor's `transaction` event and returns `selector(editor.state, editor)`.
 * The component re-renders only when the selected value changes according to `isEqual`
 * (default `Object.is`); otherwise the previous value is returned so the snapshot stays stable.
 */
export function useEditorState<T, E extends Editor<readonly AnyPlugin[]> = Editor<readonly AnyPlugin[]>>(
  editor: E,
  selector: (state: EditorState, editor: E) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const cache = useRef<{ editor: E; value: T } | null>(null)

  const subscribe = useCallback((onChange: () => void) => editor.on('transaction', onChange), [editor])

  const getSnapshot = (): T => {
    const next = selector(editor.state, editor)
    const prev = cache.current
    if (prev && prev.editor === editor && isEqual(prev.value, next)) return prev.value
    cache.current = { editor, value: next }
    return next
  }

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
