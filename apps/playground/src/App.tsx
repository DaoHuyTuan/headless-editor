import { useEffect, useState } from 'react'
import { CodeBlockView } from '@hte/code-block/react'
import { MentionSuggestion, MentionView, type MentionViewProps } from '@hte/mention/react'
import { EditorContent, useEditor } from '@hte/react'
import { CodePanel } from './CodePanel'
import { plugins } from './editor'
import { fakeUpload } from './fake-upload'
import { fetchUsers } from './fake-users'
import { ImageViewKindContext, PlaygroundImageView } from './image-views'
import { scenarios, type ScenarioName } from './scenarios'
import { Toolbar } from './Toolbar'

type Tab = 'view' | 'code'

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
const TAB = 'cursor-pointer rounded border border-neutral-300 bg-white px-2.5 py-1 aria-selected:bg-neutral-900 aria-selected:text-white'

/** Module-level for a stable identity (see `nodeViews`). */
function PlaygroundMentionView(props: MentionViewProps) {
  return <MentionView {...props} classNames={mentionClassNames} />
}

export function App() {
  const [scenario, setScenario] = useState<ScenarioName>('empty')
  const [tab, setTab] = useState<Tab>('view')
  const editor = useEditor({
    plugins,
    content: scenarios[scenario].content,
    nodeViews,
    pluginOptions,
  })

  useEffect(() => {
    if (import.meta.env.DEV) window.editor = editor
  }, [editor])

  const pick = (name: ScenarioName) => {
    setScenario(name)
    editor.setContent(scenarios[name].content)
  }

  const imageView = scenarios[scenario].imageView ?? 'default'

  return (
    <main className="mx-auto min-h-screen max-w-190 bg-neutral-50 p-4 text-neutral-900">
      <header className="mb-2 flex items-center justify-between">
        <label>
          Scenario{' '}
          <select
            className="rounded border border-neutral-300 bg-white"
            data-testid="scenario" value={scenario} onChange={(e) => pick(e.target.value as ScenarioName)}>
            {Object.entries(scenarios).map(([name, s]) => (
              <option key={name} value={name}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <nav className="flex gap-1" role="tablist">
          {(['view', 'code'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={TAB} onClick={() => setTab(t)}>
              {t === 'view' ? 'View' : 'Code'}
            </button>
          ))}
        </nav>
      </header>
      <Toolbar editor={editor} />
      {/* The editor stays mounted while the Code tab is open, so its view and listeners persist. */}
      <div hidden={tab !== 'view'}>
        {/* Node views render through portals inside EditorContent, so they see this context. */}
        <ImageViewKindContext.Provider value={imageView}>
          <EditorContent editor={editor} className="editor min-h-50 whitespace-pre-wrap rounded border border-neutral-300 bg-white p-3 outline-none focus:border-blue-500" data-testid="editor" spellCheck={false} />
        </ImageViewKindContext.Provider>
        <MentionSuggestion editor={editor} classNames={suggestionClassNames} />
      </div>
      {tab === 'code' && <CodePanel editor={editor} />}
    </main>
  )
}
