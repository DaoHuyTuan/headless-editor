import { useEditorState } from '@penline/react'
import type { PlaygroundEditor } from './editor'

const snapshot = (_: unknown, editor: PlaygroundEditor) => ({
  json: JSON.stringify(editor.getJSON(), null, 2),
  html: editor.getHTML(),
})

const PRE = 'overflow-auto border border-neutral-300 bg-white p-2 text-[13px]'

/** The document as JSON and HTML, refreshed on every transaction. */
export function CodePanel({ editor }: { editor: PlaygroundEditor }) {
  const { json, html } = useEditorState(editor, snapshot)
  return (
    <div>
      <h3 className="my-2 font-semibold">JSON</h3>
      <pre className={PRE} data-testid="json">{json}</pre>
      <h3 className="my-2 font-semibold">HTML</h3>
      <pre className={PRE} data-testid="html">{html}</pre>
    </div>
  )
}
