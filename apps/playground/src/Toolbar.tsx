import type { MouseEvent } from 'react'
import { useEditorState } from '@hte/react'
import type { PlaygroundEditor } from './editor'

const isBold = (_: unknown, editor: PlaygroundEditor) => editor.isActive('bold')

export function Toolbar({ editor }: { editor: PlaygroundEditor }) {
  const bold = useEditorState(editor, isBold)
  // mousedown is prevented so the editor keeps focus and its selection.
  const keepFocus = (e: MouseEvent) => e.preventDefault()
  return (
    <div className="toolbar" role="toolbar">
      <button
        type="button"
        data-testid="bold"
        data-active={bold}
        aria-pressed={bold}
        onMouseDown={keepFocus}
        onClick={() => editor.commands.toggleBold()}
      >
        <strong>B</strong>
      </button>
      <button type="button" data-testid="undo" onMouseDown={keepFocus} onClick={() => editor.commands.undo()}>
        Undo
      </button>
      <button type="button" data-testid="redo" onMouseDown={keepFocus} onClick={() => editor.commands.redo()}>
        Redo
      </button>
    </div>
  )
}
