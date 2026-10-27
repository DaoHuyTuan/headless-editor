import { useEditorState } from '@hte/react'
import type { PlaygroundEditor } from './editor'

const snapshot = (_: unknown, editor: PlaygroundEditor) => ({
  json: JSON.stringify(editor.getJSON(), null, 2),
  html: editor.getHTML(),
})

/** The document as JSON and HTML, refreshed on every transaction. */
export function CodePanel({ editor }: { editor: PlaygroundEditor }) {
  const { json, html } = useEditorState(editor, snapshot)
  return (
    <div className="code">
      <h3>JSON</h3>
      <pre data-testid="json">{json}</pre>
      <h3>HTML</h3>
      <pre data-testid="html">{html}</pre>
    </div>
  )
}
