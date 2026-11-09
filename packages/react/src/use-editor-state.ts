import { useCallback, useRef, useSyncExternalStore } from 'react'
import type { AnyPlugin, Editor, EditorState } from '@hte/core'

interface Cached<T, E> {
  editor: E
  state: EditorState
  selector: (state: EditorState, editor: E) => T
  value: T
}

/**
 * Subscribes to the editor's `transaction` event and returns `selector(editor.state, editor)`.
 * The component re-renders only when the selected value changes according to `isEqual`
 * (default `Object.is`).
 *
 * The snapshot is cached on (editor, state, selector). Every commit replaces the state object, so
 * the cache never goes stale. That keeps object-returning selectors stable without a custom
 * `isEqual`. When it does recompute, a value equal to the previous one keeps the previous identity.
 *
 * Types: leave the type arguments to inference, so the selector's `editor` has the type of the
 * `editor` argument (typed commands). To fix the result type, annotate the selector's return
 * (`(s, e): boolean => ...`) or pass both arguments (`useEditorState<boolean, typeof editor>`):
 * TypeScript has no partial inference, so `useEditorState<boolean>(...)` types the selector's
 * `editor` as a plain `Editor`.
 */
export function useEditorState<T, E extends Editor<readonly AnyPlugin[]> = Editor<readonly AnyPlugin[]>>(
  editor: E,
  selector: (state: EditorState, editor: E) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const cache = useRef<Cached<T, E> | null>(null)

  const subscribe = useCallback((onChange: () => void) => editor.on('transaction', onChange), [editor])

  const getSnapshot = (): T => {
    const state = editor.state
    const prev = cache.current
    if (prev && prev.editor === editor && prev.state === state && prev.selector === selector) return prev.value
    const next = selector(state, editor)
    const value = prev && prev.editor === editor && isEqual(prev.value, next) ? prev.value : next
    cache.current = { editor, state, selector, value }
    return value
  }

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
