import { useLayoutEffect, useRef, type HTMLAttributes } from 'react'
import type { AnyPlugin, Editor } from '@hte/core'

export type EditorContentProps = { editor: Editor<readonly AnyPlugin[]> } & HTMLAttributes<HTMLDivElement>

/** Renders the editor's root `<div>`; the editor mounts its view on it and owns its children. */
export function EditorContent({ editor, ...divProps }: EditorContentProps) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    editor.mount(el)
    return () => editor.unmount()
  }, [editor])
  return <div {...divProps} ref={ref} />
}
