import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Editor, type AnyPlugin, type EditorOptions } from '@hte/core'

export type UseEditorOptions<P extends readonly AnyPlugin[]> = EditorOptions<P> & {
  onUpdate?: (e: { editor: Editor<P> }) => void
}

/**
 * Creates an editor once for the component's lifetime. Options are read only on the first render;
 * `onUpdate` is held in a ref, so a new callback identity never recreates the editor.
 *
 * StrictMode-safe destruction: effect cleanup only *schedules* `destroy()` on the next tick, and the
 * effect's setup cancels any pending destroy. StrictMode's unmount → remount therefore keeps the
 * editor alive, while a real unmount destroys it.
 */
export function useEditor<const P extends readonly AnyPlugin[]>(options: UseEditorOptions<P>): Editor<P> {
  const [editor] = useState(() => {
    const { onUpdate: _onUpdate, ...editorOptions } = options
    return new Editor<P>(editorOptions as EditorOptions<P>)
  })

  const onUpdateRef = useRef(options.onUpdate)
  useLayoutEffect(() => {
    onUpdateRef.current = options.onUpdate
  })

  useEffect(
    () => editor.on('update', () => onUpdateRef.current?.({ editor })),
    [editor],
  )

  const pendingDestroy = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (pendingDestroy.current !== null) {
      clearTimeout(pendingDestroy.current)
      pendingDestroy.current = null
    }
    return () => {
      pendingDestroy.current = setTimeout(() => {
        pendingDestroy.current = null
        editor.destroy()
      }, 0)
    }
  }, [editor])

  return editor
}
