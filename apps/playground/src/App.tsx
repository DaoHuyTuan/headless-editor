import { useEffect, useState } from 'react'
import { CodeBlockView } from '@hte/code-block/react'
import { MentionSuggestion, MentionView } from '@hte/mention/react'
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
const nodeViews = { image: PlaygroundImageView, mention: MentionView, codeBlock: CodeBlockView }
const pluginOptions = { image: { upload: fakeUpload }, mention: { fetchUsers } }
const suggestionClassNames = { popup: 'mention-popup', item: 'mention-item' }

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
    <main className="app">
      <header>
        <label>
          Scenario{' '}
          <select data-testid="scenario" value={scenario} onChange={(e) => pick(e.target.value as ScenarioName)}>
            {Object.entries(scenarios).map(([name, s]) => (
              <option key={name} value={name}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <nav className="tabs" role="tablist">
          {(['view', 'code'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
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
          <EditorContent editor={editor} className="editor" data-testid="editor" spellCheck={false} />
        </ImageViewKindContext.Provider>
        <MentionSuggestion editor={editor} classNames={suggestionClassNames} />
      </div>
      {tab === 'code' && <CodePanel editor={editor} />}
    </main>
  )
}
