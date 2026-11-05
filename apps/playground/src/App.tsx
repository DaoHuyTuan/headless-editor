import { useEffect, useRef, useState } from 'react'
import { CodeBlockView } from '@hte/code-block/react'
import { MentionSuggestion, MentionView, type MentionViewProps } from '@hte/mention/react'
import { EditorContent, useEditor } from '@hte/react'
import { CodePanel } from './CodePanel'
import { plugins } from './editor'
import { fakeUpload } from './fake-upload'
import { fetchUsers } from './fake-users'
import { ImageViewKindContext, PlaygroundImageView } from './image-views'
import { Sidebar } from './Sidebar'
import type { Story } from './stories'
import { Toolbar } from './Toolbar'
import { useStory } from './use-story'

// Module-level: the same identities on every render, so `useEditor` never re-applies the options
// (an inline object would re-render every node view of the type).
const nodeViews = { image: PlaygroundImageView, mention: PlaygroundMentionView, codeBlock: CodeBlockView }
const pluginOptions = { image: { upload: fakeUpload }, mention: { fetchUsers } }
const suggestionClassNames = {
  popup: 'z-10 mt-0.5 min-w-35 rounded border border-neutral-300 bg-white shadow-md',
  list: 'm-0 list-none py-1 pl-0',
  item: 'cursor-pointer px-2.5 py-0.5 data-[selected]:bg-blue-600 data-[selected]:text-white',
}
const mentionClassNames = { root: 'rounded-sm bg-blue-100 px-0.5 text-blue-800' }

/** Module-level for a stable identity (see `nodeViews`). */
function PlaygroundMentionView(props: MentionViewProps) {
  return <MentionView {...props} classNames={mentionClassNames} />
}

export function App() {
  const story = useStory()
  const [docOpen, setDocOpen] = useState(false)
  const editor = useEditor({
    plugins,
    content: story.content,
    nodeViews,
    pluginOptions,
  })

  useEffect(() => {
    if (import.meta.env.DEV) window.editor = editor
  }, [editor])

  // `useEditor` already got the first story's content; later switches replace it.
  const applied = useRef(story)
  useEffect(() => {
    if (story === applied.current) return
    applied.current = story
    editor.setContent(story.content)
  }, [editor, story]) // a story is a module-level constant, so this runs once per switch

  // Re-clicking the open story fires no `hashchange`, so the reset happens here.
  const pick = (s: Story) => {
    if (s === story) editor.setContent(s.content)
  }

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 md:flex">
      <Sidebar current={story} onPick={pick} />
      <main className="min-w-0 max-w-3xl flex-1 p-4">
        <h1 className="mb-1 text-xl font-semibold">{story.title}</h1>
        <p className="mb-3 text-sm text-neutral-600">{story.description}</p>
        <Toolbar editor={editor} />
        {/* Node views render through portals inside EditorContent, so they see this context. */}
        <ImageViewKindContext.Provider value={story.imageView ?? 'default'}>
          <EditorContent editor={editor} className="editor min-h-50 whitespace-pre-wrap rounded border border-neutral-300 bg-white p-3 outline-none focus:border-blue-500" data-testid="editor" spellCheck={false} />
        </ImageViewKindContext.Provider>
        <MentionSuggestion editor={editor} classNames={suggestionClassNames} />
        <details data-testid="doc-panel" className="mt-4" onToggle={(e) => setDocOpen(e.currentTarget.open)}>
          <summary className="cursor-pointer font-semibold">Document</summary>
          {/* Serializes on every transaction, so it only renders while open. */}
          {docOpen && <CodePanel editor={editor} />}
        </details>
      </main>
    </div>
  )
}
