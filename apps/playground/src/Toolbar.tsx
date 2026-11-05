import { useRef, type ChangeEvent, type MouseEvent } from 'react'
import { useEditorState } from '@hte/react'
import type { PlaygroundEditor } from './editor'

/** The font sizes offered by the toolbar; `''` is the default (no fontSize mark). */
const BUTTON =
  'cursor-pointer rounded border border-neutral-300 bg-white px-2.5 py-1 data-[active=true]:bg-neutral-900 data-[active=true]:text-white disabled:opacity-40'

/** The font sizes offered by the toolbar; `''` is the default (no fontSize mark). */
const FONT_SIZES = ['12px', '16px', '24px', '32px'] as const

const isBold = (_: unknown, editor: PlaygroundEditor) => editor.isActive('bold')
/** Whether Bold would apply: `can()` runs the filters, so it is false inside a code block. */
const canBold = (_: unknown, editor: PlaygroundEditor) => editor.can().toggleBold()
const inCodeBlock = (_: unknown, editor: PlaygroundEditor) => editor.isActive('codeBlock')
/** The size of the fontSize mark covering the selection, or `''` when there is none (or it is mixed). */
const activeFontSize = (_: unknown, editor: PlaygroundEditor) =>
  FONT_SIZES.find((size) => editor.isActive('fontSize', { size })) ?? ''

export function Toolbar({ editor }: { editor: PlaygroundEditor }) {
  const bold = useEditorState(editor, isBold)
  const boldEnabled = useEditorState(editor, canBold)
  const fontSize = useEditorState(editor, activeFontSize)
  const code = useEditorState(editor, inCodeBlock)
  const fileInput = useRef<HTMLInputElement>(null)
  // mousedown is prevented so the editor keeps focus and its selection.
  const keepFocus = (e: MouseEvent) => e.preventDefault()

  const changeFontSize = (e: ChangeEvent<HTMLSelectElement>) => {
    const size = e.target.value
    if (size === '') editor.commands.unsetFontSize()
    else editor.commands.setFontSize(size)
    // The select took focus: give it back (with the model selection) so typing continues.
    editor.view?.focus()
  }

  const pickImages = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    // Reset, so choosing the same file again still fires `change`.
    e.target.value = ''
    if (files.length === 0) return
    editor.view?.focus()
    editor.storage.image.upload(files)
  }

  return (
    <div className="mb-2 flex gap-1" role="toolbar">
      <button
        type="button"
        className={BUTTON}
        data-testid="bold"
        data-active={bold}
        aria-pressed={bold}
        disabled={!boldEnabled}
        onMouseDown={keepFocus}
        onClick={() => editor.commands.toggleBold()}
      >
        <strong>B</strong>
      </button>
      <select
        className="rounded border border-neutral-300 bg-white"
        data-testid="font-size" aria-label="Font size" value={fontSize} onChange={changeFontSize}>
        <option value="">Default</option>
        {FONT_SIZES.map((size) => (
          <option key={size} value={size}>
            {size}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={BUTTON}
        data-testid="code-block"
        data-active={code}
        aria-pressed={code}
        onMouseDown={keepFocus}
        // In a code block: exit to a new paragraph after it; elsewhere: turn the block into a code block.
        onClick={() => (code ? editor.commands.exitCodeBlock() : editor.commands.setCodeBlock())}
      >
        Code
      </button>
      <button type="button" className={BUTTON} data-testid="image" onMouseDown={keepFocus} onClick={() => fileInput.current?.click()}>
        Image
      </button>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        data-testid="image-file"
        onChange={pickImages}
      />
      <button type="button" className={BUTTON} data-testid="undo" onMouseDown={keepFocus} onClick={() => editor.commands.undo()}>
        Undo
      </button>
      <button type="button" className={BUTTON} data-testid="redo" onMouseDown={keepFocus} onClick={() => editor.commands.redo()}>
        Redo
      </button>
    </div>
  )
}
