import { useEffect, useState } from 'react'
import { EditorContent, useEditor } from '@hte/react'
import { CodePanel } from './CodePanel'
import { plugins } from './editor'
import { scenarios, type ScenarioName } from './scenarios'
import { Toolbar } from './Toolbar'

type Tab = 'view' | 'code'

export function App() {
  const [scenario, setScenario] = useState<ScenarioName>('empty')
  const [tab, setTab] = useState<Tab>('view')
  const editor = useEditor({ plugins, content: scenarios[scenario].content })

  useEffect(() => {
    if (import.meta.env.DEV) window.editor = editor
  }, [editor])

  const pick = (name: ScenarioName) => {
    setScenario(name)
    editor.setContent(scenarios[name].content)
  }

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
        <EditorContent editor={editor} className="editor" data-testid="editor" spellCheck={false} />
      </div>
      {tab === 'code' && <CodePanel editor={editor} />}
    </main>
  )
}
