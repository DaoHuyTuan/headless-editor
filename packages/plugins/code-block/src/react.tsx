import { createContext, useCallback, useContext, useMemo, type ChangeEvent, type ComponentType, type ReactNode } from 'react'
import type { NodeViewPropsOf } from '@penline/core'
import { NodeContent, dataAttrs, resolveParts, type ViewCustomization } from '@penline/react'
import type { codeBlock } from './index'

type CodeBlockProps = NodeViewPropsOf<typeof codeBlock>

/** @experimental Level 4 customization API; may change after M3 without a deprecation cycle. */
export interface CodeBlockSelectProps {
  'data-editor-ignore': ''
  'aria-label': string
  value: string
  onChange(e: ChangeEvent<HTMLSelectElement>): void
}

/** @experimental Level 4 customization API; may change after M3 without a deprecation cycle. */
export interface CodeBlockApi {
  /** The block's language (`data.language`). */
  language: string
  /** The languages to offer: `options.languages`, plus the current language when it is not among them. */
  languages: readonly string[]
  /** Sets the block's language in one undo step; the editor's selection is kept. False when rejected. */
  setLanguage(language: string): boolean
  /** Props for a `<select>` of the languages (`data-editor-ignore` included: the editor leaves it alone). */
  selectProps: CodeBlockSelectProps
}

/**
 * The language of a code block node view and a way to change it. Reads the node and options of the
 * current props (the core updates them on a data or options change; the plugin has no state).
 * Memoized: the same api object while the language, `options.languages`, `options.languageLabel` and
 * `updateData` stay the same (`setLanguage` changes only with `updateData`).
 * @experimental Level 4 customization API; may change after M3 without a deprecation cycle.
 */
export function useCodeBlock(props: CodeBlockProps): CodeBlockApi {
  const raw = props.node.data.language
  const language = typeof raw === 'string' && raw !== '' ? raw : 'plaintext'
  const configured = props.options.languages
  const label = typeof props.options.languageLabel === 'string' ? props.options.languageLabel : 'Language'
  const { updateData } = props
  const setLanguage = useCallback((l: string) => updateData({ language: l }), [updateData])
  return useMemo(() => {
    const list = Array.isArray(configured) ? configured : []
    return {
      language,
      languages: list.includes(language) ? list : [...list, language],
      setLanguage,
      selectProps: {
        'data-editor-ignore': '',
        'aria-label': label,
        value: language,
        onChange: (e) => {
          setLanguage(e.target.value)
        },
      },
    }
  }, [language, configured, label, setLanguage])
}

const CodeBlockContext = createContext<CodeBlockApi | null>(null)

/**
 * The `CodeBlockApi` provided by `CodeBlock.Root`, for replacement parts.
 * @experimental Level 3 customization API; may change after M3 without a deprecation cycle.
 */
export function useCodeBlockContext(): CodeBlockApi {
  const value = useContext(CodeBlockContext)
  if (!value) throw new Error('@penline/code-block: CodeBlock parts must be rendered inside <CodeBlock.Root>')
  return value
}

/** @experimental */
export interface CodeBlockRootProps {
  value: CodeBlockApi
  selected?: boolean
  className?: string
  children?: ReactNode
}

/** @experimental */
export interface CodeBlockPartProps {
  className?: string
  children?: ReactNode
}

/**
 * The parts of the code block view. `Root` is `<div data-penline-code-block data-selected?>` and provides
 * the `CodeBlockApi` to the other parts; `Toolbar` is a `contenteditable="false"` `<div>` beside the
 * content; `LanguageSelect` is the language `<select>`; `Content` is `<pre><code class="language-x">`
 * holding the editable content (whitespace kept by `<pre>`). Never render `Content` inside `Toolbar`
 * or any other `contentEditable={false}` element.
 * @experimental Level 3 customization API; may change after M3 without a deprecation cycle.
 */
export const CodeBlock = {
  Root({ value, selected, className, children }: CodeBlockRootProps) {
    return (
      <CodeBlockContext.Provider value={value}>
        <div data-penline-code-block="" {...dataAttrs({ selected })} className={className}>
          {children}
        </div>
      </CodeBlockContext.Provider>
    )
  },
  Toolbar({ className, children }: CodeBlockPartProps) {
    return (
      <div contentEditable={false} suppressContentEditableWarning className={className}>
        {children}
      </div>
    )
  },
  LanguageSelect({ className }: CodeBlockPartProps) {
    const { languages, selectProps } = useCodeBlockContext()
    return (
      <select {...selectProps} className={className}>
        {languages.map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
      </select>
    )
  },
  Content({ className }: CodeBlockPartProps) {
    const { language } = useCodeBlockContext()
    return (
      <pre className={className}>
        <code className={`language-${language}`}>
          <NodeContent as="span" />
        </code>
      </pre>
    )
  },
}

type CodeBlockParts = {
  toolbar: ComponentType<CodeBlockPartProps>
  languageSelect: ComponentType<CodeBlockPartProps>
  content: ComponentType<CodeBlockPartProps>
}

export type CodeBlockViewProps = CodeBlockProps & ViewCustomization<CodeBlockParts>

/**
 * Default React node view of the code block plugin: a toolbar with a language select above the
 * editable code. Stable attributes: `data-penline-code-block` on the root, `data-selected` when
 * node-selected. `parts` / `classNames` keys: `root`, `toolbar`, `languageSelect` (rendered inside the
 * toolbar), `content` (`classNames.content` goes on the `<pre>`).
 */
export function CodeBlockView({ parts, classNames, ...props }: CodeBlockViewProps) {
  const api = useCodeBlock(props)
  const P = resolveParts<CodeBlockParts>(
    { toolbar: CodeBlock.Toolbar, languageSelect: CodeBlock.LanguageSelect, content: CodeBlock.Content },
    parts,
  )
  return (
    <CodeBlock.Root value={api} selected={props.selected} className={classNames?.root}>
      {P.toolbar && (
        <P.toolbar className={classNames?.toolbar}>
          {P.languageSelect && <P.languageSelect className={classNames?.languageSelect} />}
        </P.toolbar>
      )}
      {P.content && <P.content className={classNames?.content} />}
    </CodeBlock.Root>
  )
}
