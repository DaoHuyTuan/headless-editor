/**
 * Typechecks every code sample of docs/plugin-authoring.md. Keep the two in sync: each `// doc:`
 * marker names the section of the guide a sample belongs to. Nothing here runs; the samples only
 * have to compile (`pnpm exec vitest --typecheck run` and `pnpm typecheck`).
 *
 * This file lives in the image package because it needs `react`, `@hte/react`, `@hte/paragraph` and
 * `zod` to resolve, and the built-in plugins are imported by relative path.
 */
import { createContext, useContext, useMemo, type ChangeEvent, type ComponentType, type ReactNode } from 'react'
import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import {
  createId,
  definePlugin,
  isElement,
  mergeAttrs,
  nodeEntries,
  type Attrs,
  type Command,
  type Data,
  type CommandsOfPlugin,
  type HTMLAttributes,
  type NodeViewPropsOf,
} from '@hte/core'
import {
  EditorContent,
  NodeContent,
  dataAttrs,
  resolveParts,
  useEditor,
  usePluginState,
  type ViewCustomization,
} from '@hte/react'
import { paragraph } from '@hte/paragraph'
import { image, safeSrc } from '../src/index'
import {
  Image,
  ImageView,
  useAltDraft,
  useImage,
  useImageContext,
  useImageResize,
  useImageState,
  type ImagePartProps,
  type ImageProps,
  type ImageViewProps,
} from '../src/react/index'
import { mention, type User } from '../../mention/src/index'
import { MentionSuggestion, useMention } from '../../mention/src/react'
import { codeBlock } from '../../code-block/src/index'
import { CodeBlockView, type CodeBlockViewProps } from '../../code-block/src/react'

const upload = async (file: File) => URL.createObjectURL(file)

// doc: Customization levels / Level 2 — HTMLAttributes and classNames
const levelTwoImage = image.configure({ upload, HTMLAttributes: { class: 'article-img', loading: 'lazy' } })

function LevelTwoImageView(props: ImageViewProps) {
  return <ImageView {...props} classNames={{ root: 'figure', img: 'figure-img', resizeHandle: 'figure-handle' }} />
}

function LevelTwoEditor() {
  const editor = useEditor({
    plugins: [paragraph, levelTwoImage],
    nodeViews: { image: LevelTwoImageView },
  })
  return <EditorContent editor={editor} />
}

// doc: Customization levels / Level 3 — parts
function AltCaption({ className }: ImagePartProps) {
  const { alt } = useImageContext()
  return <figcaption className={className}>{alt}</figcaption>
}

function LevelThreeImageView(props: ImageViewProps) {
  return <ImageView {...props} parts={{ altInput: AltCaption, resizeHandle: false }} classNames={{ root: 'card' }} />
}

// doc: Customization levels / Level 3 — your own arrangement of the parts
function ImageWithoutHandle(props: ImageProps) {
  const api = useImage(props)
  return (
    <Image.Root value={api} className="plain">
      <Image.Img />
      <Image.AltInput className="plain-alt" />
    </Image.Root>
  )
}

// doc: Customization levels / Level 4 — hooks only
function LevelFourImageView(props: ImageProps) {
  const { selected, uploading } = useImageState(props)
  const { width, resizing, handleProps } = useImageResize(props)
  const { inputProps } = useAltDraft(props)
  // Hooks-only views must put the src behind safeSrc themselves.
  const src = safeSrc(props.node.data.src) ?? undefined
  return (
    <figure data-hte-image="" {...dataAttrs({ selected, uploading })}>
      <img src={src} alt={props.node.data.alt} width={width} draggable={false} />
      <input {...inputProps} />
      <span {...handleProps} hidden={!selected && !resizing} />
    </figure>
  )
}

// doc: Customization levels / Level 5 — extend(parent => ...)
const roundedImage = image.extend((parent) => ({
  renderHTML: (node, ctx) => {
    const [tag, attrs] = parent.renderHTML!(node, ctx) as [string, Attrs]
    return [tag, mergeAttrs(attrs, { class: 'rounded' })]
  },
  keymap: (ctx) => ({
    ...parent.keymap?.(ctx),
    'Mod-Shift-i': () => ctx.commands.insertImage('/placeholder.png'),
  }),
}))

// doc: Writing a plugin / the callout plugin (logic)
type Tone = 'info' | 'warn'

interface CalloutOptions {
  /** Extra attributes merged into the `<aside>`. */
  HTMLAttributes: HTMLAttributes
}

interface CalloutState {
  /** How many callouts were inserted by `insertCallout` in this editor. */
  inserted: number
}

export const callout = definePlugin({
  name: 'callout',
  node: { kind: 'block', content: 'inline' },
  data: z.object({ tone: z.enum(['info', 'warn']).default('info') }),
  options: { HTMLAttributes: {} } as CalloutOptions,
  // `commands` and `storage` come before every hook that takes `ctx`.
  commands: () => ({
    insertCallout:
      (tone: Tone = 'info'): Command =>
      ({ tr }) => {
        tr.insertBlockNode({ id: createId(), type: 'callout', data: { tone }, children: [{ text: '', marks: [] }] })
        tr.setMeta('calloutInserted', true)
        return tr.rejected === null && tr.docChanged
      },
  }),
  storage: (ctx) => ({
    count: () => [...nodeEntries(ctx.editor.state.doc)].filter(([n]) => isElement(n) && n.type === ctx.name).length,
  }),
  state: {
    init: (): CalloutState => ({ inserted: 0 }),
    apply: (tr, prev: CalloutState): CalloutState => (tr.meta.calloutInserted ? { inserted: prev.inserted + 1 } : prev),
  },
  keymap: (ctx) => ({ 'Mod-Alt-c': () => ctx.commands.insertCallout('info') }),
  parseHTML: [
    {
      tag: 'aside',
      getData: (el) => ({ tone: el.getAttribute('data-tone') === 'warn' ? 'warn' : 'info' }),
    },
  ],
  renderHTML: (node, { options }) => [
    'aside',
    // HTMLAttributes first, data-driven attributes last: the node's data always wins.
    mergeAttrs(options.HTMLAttributes, { 'data-tone': node.data.tone === 'warn' ? 'warn' : 'info' }),
    0,
  ],
  onCreate: (ctx) => {
    // Side-effect free: StrictMode may create (and drop) a throwaway editor.
    void ctx.storage.count()
  },
  onMount: (_ctx, view) => {
    // `view` is the argument; `editor.view` is still null here.
    view.root.classList.add('has-callouts')
    // Unmount fires no onBlur: undo per-view state (and close popups) in this cleanup.
    return () => view.root.classList.remove('has-callouts')
  },
})

// doc: Writing a plugin / hooks
type CalloutProps = NodeViewPropsOf<typeof callout>

export function useCallout(props: CalloutProps) {
  // Plugin state is read with usePluginState (props.state does not re-render the view).
  const { inserted } = usePluginState(props.editor, callout)
  const { tone } = props.node.data
  return {
    tone,
    selected: props.selected,
    inserted,
    selectProps: {
      'data-editor-ignore': '' as const,
      'aria-label': 'Tone',
      value: tone,
      onChange: (e: ChangeEvent<HTMLSelectElement>) => {
        props.updateData({ tone: e.target.value === 'warn' ? 'warn' : 'info' })
      },
    },
  }
}

// doc: Writing a plugin / parts
type CalloutApi = ReturnType<typeof useCallout>

const CalloutContext = createContext<CalloutApi | null>(null)

function useCalloutContext(): CalloutApi {
  const value = useContext(CalloutContext)
  if (!value) throw new Error('Callout parts must be rendered inside <Callout.Root>')
  return value
}

interface CalloutPartProps {
  className?: string
  children?: ReactNode
}

export const Callout = {
  Root({ value, className, children }: CalloutPartProps & { value: CalloutApi }) {
    return (
      <CalloutContext.Provider value={value}>
        <aside data-hte-callout="" data-tone={value.tone} {...dataAttrs({ selected: value.selected })} className={className}>
          {children}
        </aside>
      </CalloutContext.Provider>
    )
  },
  Toolbar({ className, children }: CalloutPartProps) {
    // A sibling of the content, never its ancestor.
    return (
      <div contentEditable={false} suppressContentEditableWarning className={className}>
        {children}
      </div>
    )
  },
  ToneSelect({ className }: CalloutPartProps) {
    const { selectProps } = useCalloutContext()
    return (
      <select {...selectProps} className={className}>
        <option value="info">Info</option>
        <option value="warn">Warning</option>
      </select>
    )
  },
  Body({ className }: CalloutPartProps) {
    return <NodeContent className={className} />
  },
}

// doc: Writing a plugin / default view
type CalloutParts = {
  toolbar: ComponentType<CalloutPartProps>
  toneSelect: ComponentType<CalloutPartProps>
  body: ComponentType<CalloutPartProps>
}

export type CalloutViewProps = CalloutProps & ViewCustomization<CalloutParts>

export function CalloutView({ parts, classNames, ...props }: CalloutViewProps) {
  const api = useCallout(props)
  const P = resolveParts<CalloutParts>(
    { toolbar: Callout.Toolbar, toneSelect: Callout.ToneSelect, body: Callout.Body },
    parts,
  )
  return (
    <Callout.Root value={api} className={classNames?.root}>
      {P.toolbar && (
        <P.toolbar className={classNames?.toolbar}>
          {P.toneSelect && <P.toneSelect className={classNames?.toneSelect} />}
        </P.toolbar>
      )}
      {P.body && <P.body className={classNames?.body} />}
    </Callout.Root>
  )
}

function CalloutEditor() {
  const editor = useEditor({
    plugins: [paragraph, callout],
    nodeViews: { callout: CalloutView },
  })
  editor.commands.insertCallout('warn')
  expectTypeOf(editor.storage.callout.count).toEqualTypeOf<() => number>()
  return <EditorContent editor={editor} />
}

// doc: Plugin options in React — memoize
const fetchUsers = async (query: string): Promise<User[]> => [{ id: '1', label: query }]
const renderUser = (user: User) => user.label

const mentionOptions = { mention: { fetchUsers, renderUser } }

function MentionEditor() {
  const editor = useEditor({
    plugins: [paragraph, mention],
    pluginOptions: mentionOptions, // module-level: same identity on every render
  })
  return (
    <>
      <EditorContent editor={editor} />
      <MentionSuggestion editor={editor} classNames={{ popup: 'mention-popup', item: 'mention-item' }} />
    </>
  )
}

function InlineOptionsEditor({ token }: { token: string }) {
  // Values that depend on props: memoize the object (a fresh object or function per render
  // re-renders every node view of the type).
  const pluginOptions = useMemo(() => ({ mention: { fetchUsers: async (q: string) => [{ id: token, label: q }] } }), [token])
  const editor = useEditor({ plugins: [paragraph, mention], pluginOptions })
  return <EditorContent editor={editor} />
}

// doc: Mention — a custom label from the live user
function ShoutingMention(props: NodeViewPropsOf<typeof mention>) {
  const { label } = useMention(props)
  return <span data-hte-mention="">@{label.toUpperCase()}</span>
}

// doc: Code block — highlight.js themes
function HighlightedCodeBlockView(props: CodeBlockViewProps) {
  return <CodeBlockView {...props} classNames={{ content: 'hljs', toolbar: 'code-toolbar' }} />
}

function CodeEditor() {
  const editor = useEditor({
    plugins: [paragraph, codeBlock],
    nodeViews: { codeBlock: HighlightedCodeBlockView },
  })
  return <EditorContent editor={editor} />
}

// doc: Spec ordering rule — what goes wrong when it is broken
describe('docs: spec ordering rule', () => {
  it('commands before a hook: typed', () => {
    const ordered = definePlugin({
      name: 'ordered',
      node: { kind: 'block' },
      options: { x: 1 },
      commands: (ctx) => ({ ping: (n: number): Command => () => ctx.options.x > n }),
      keymap: (ctx) => ({ A: () => ctx.commands.ping(0) }),
    })
    expectTypeOf<CommandsOfPlugin<typeof ordered>>().toEqualTypeOf<{ ping: (n: number) => Command }>()
  })

  it('commands (using ctx) after a hook silently lose their types', () => {
    const late = definePlugin({
      name: 'late',
      node: { kind: 'block' },
      options: { x: 1 },
      keymap: (ctx) => ({ A: () => ctx.options.x > 0 }),
      commands: (ctx) => ({ ping: (n: number): Command => () => ctx.options.x > n }),
    })
    // Pinned on purpose: when TypeScript's inference improves this starts failing. Then update the
    // ordering rule in docs/plugin-authoring.md and spec §5.11.
    expectTypeOf<CommandsOfPlugin<typeof late>>().toEqualTypeOf<{}>()

    definePlugin({
      name: 'late-use',
      node: { kind: 'block' },
      options: { x: 1 },
      keymap: (ctx) => ({
        // @ts-expect-error `ctx.commands` has no `ping` yet: the commands are declared below
        A: () => ctx.commands.ping(0),
      }),
      commands: (ctx) => ({ ping: (n: number): Command => () => ctx.options.x > n }),
    })
  })

  it('storage after a hook is a confusing TS2322', () => {
    definePlugin({
      name: 'late-storage',
      node: { kind: 'block' },
      keymap: () => ({}),
      onCreate: (ctx) => void ctx.storage,
      // @ts-expect-error storage typed after a hook that uses ctx: T is fixed to `undefined` (TS2322)
      storage: (ctx) => ({ n: ctx.name.length }),
    })
  })
})

void [LevelTwoEditor, LevelThreeImageView, ImageWithoutHandle, LevelFourImageView, roundedImage, CalloutEditor]
void [MentionEditor, InlineOptionsEditor, ShoutingMention, CodeEditor]

// doc: api — the samples of docs/plugin-api.md.
const highlight = definePlugin({
  name: 'highlight',
  options: { color: 'yellow', HTMLAttributes: {} as HTMLAttributes },
  data: z.object({ color: z.string().optional() }),
  mark: {
    render: (data, { options }) => ({
      tag: 'mark',
      attrs: mergeAttrs(options.HTMLAttributes, {}),
      style: { background: data.color ?? options.color },
    }),
  },
  parseHTML: [{ tag: 'mark', getData: (el): Data => (el.style.background ? { color: el.style.background } : {}) }],
  commands: () => ({
    toggleHighlight:
      (color?: string): Command =>
      ({ tr }) =>
        tr.toggleMark('highlight', color ? { color } : {}).rejected === null,
  }),
  keymap: (ctx) => ({ 'Mod-Shift-h': () => ctx.commands.toggleHighlight() }),
})

describe('docs: plugin-api', () => {
  it('infers commands and options', () => {
    expectTypeOf<CommandsOfPlugin<typeof highlight>>().toHaveProperty('toggleHighlight')
    const pink = highlight.configure({ color: 'pink' })
    const withAlt = highlight.extend((parent) => ({
      keymap: (ctx) => ({ ...parent.keymap?.(ctx), 'Mod-Alt-h': () => ctx.commands.toggleHighlight('orange') }),
    }))
    void [pink, withAlt]
  })
})

// doc: README — the plugin sample of README.md.
const italic = definePlugin({
  name: 'italic',
  mark: { render: () => ({ tag: 'em' }) },
  parseHTML: [{ tag: 'em' }, { tag: 'i' }],
  commands: () => ({
    toggleItalic: (): Command => ({ tr }) => tr.toggleMark('italic').rejected === null,
  }),
  keymap: (ctx) => ({ 'Mod-i': () => ctx.commands.toggleItalic() }),
})

describe('docs: README', () => {
  it('types the plugin commands on the editor', () => {
    expectTypeOf<CommandsOfPlugin<typeof italic>>().toHaveProperty('toggleItalic')
  })
})
