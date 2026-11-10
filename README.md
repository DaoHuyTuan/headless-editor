# penline

[![CI](https://github.com/DaoHuyTuan/headless-editor/actions/workflows/ci.yml/badge.svg)](https://github.com/DaoHuyTuan/headless-editor/actions/workflows/ci.yml)

A headless rich-text editor with its own editing engine. It is not built on ProseMirror.

```sh
npm install @penline/core @penline/react @penline/paragraph @penline/bold
```

> Pre-release (0.x): the API can still change between minor versions until 1.0.

- **Headless.** The editor ships behaviour, not styles. You own the markup and the CSS.
- **Framework-free core.** `@penline/core` has no UI framework dependency. `@penline/react` is the React adapter, and the core is designed so a Vue adapter can be added later.
- **Plugins in control.** Every feature (paragraph, bold, image, mention, code block…) is a plugin defined with `definePlugin`. A plugin owns its schema, commands, keys, HTML, paste handling and view. Each built-in plugin can be customized at several levels, from CSS up to rebuilding its view from hooks.
- **Operations-based.** Every change goes through invertible operations. That gives exact undo/redo, and leaves the door open for realtime collaboration later. Collaboration is not built yet.

> Status: early development (milestones M1–M4 done). The packages are not published to npm yet; use them from this monorepo.

## Contents

1. [Requirements and setup](#requirements-and-setup)
2. [Run the playground](#run-the-playground)
3. [Use the editor in React](#use-the-editor-in-react)
4. [Use the core without React](#use-the-core-without-react)
5. [Content: JSON and HTML](#content-json-and-html)
6. [Built-in plugins](#built-in-plugins)
7. [Customizing a plugin](#customizing-a-plugin)
8. [Writing your own plugin](#writing-your-own-plugin)
9. [Tests](#tests)
10. [Repository layout](#repository-layout)
11. [Browser support](#browser-support)
12. [Documentation](#documentation)

## Requirements and setup

- Node.js 20 or newer. Development uses Node 24.
- pnpm. The version is pinned in `package.json` under `packageManager`; `corepack enable` picks it up.

```bash
pnpm install
```

## Run the playground

The playground is a small story browser for trying the editor. The sidebar lists the stories (mention, code block, image, custom image view, and others), grouped by plugin. Each story has its own URL, e.g. `#/code-block/javascript`, so you can deep-link to one; clicking the open story resets its content. Under the editor, the **Document** panel (collapsed by default) shows the document as JSON and HTML.

```bash
pnpm --filter playground dev
```

Open the URL Vite prints (default `http://localhost:5173`).

## Use the editor in React

```tsx
import { EditorContent, useEditor, useEditorState } from '@penline/react'
import { paragraph } from '@penline/paragraph'
import { bold } from '@penline/bold'

// Module-level: the same array on every render.
const plugins = [paragraph, bold] as const

export function MyEditor() {
  const editor = useEditor({
    plugins,
    content: '<p>Hello <strong>world</strong></p>',
    onUpdate: ({ editor }) => console.log(editor.getJSON()),
  })

  // Re-renders only when the selected value changes.
  const isBold = useEditorState(editor, (_, ed) => ed.isActive('bold'))

  return (
    <>
      <button aria-pressed={isBold} onMouseDown={(e) => e.preventDefault()} onClick={() => editor.commands.toggleBold()}>
        Bold
      </button>
      <EditorContent editor={editor} className="editor" />
    </>
  )
}
```

How the pieces fit together:
- `useEditor(options)` creates one editor for the component's lifetime. It is StrictMode-safe.
- `<EditorContent editor={editor} />` renders the editable area.
- `editor.commands.x()` runs a command and returns whether it applied. `editor.can().x()` asks the same question without changing anything; use it for a button's enabled state.
- `useEditorState(editor, selector)` subscribes a component to part of the editor state.
- `onMouseDown={(e) => e.preventDefault()}` on toolbar buttons keeps the focus, and with it the selection, in the editor.

Plugins with a React view, such as image, mention and code block, take a `nodeViews` entry. Options that are functions go in `pluginOptions`:

```tsx
import { image } from '@penline/image'
import { ImageView } from '@penline/image/react'
import { mention } from '@penline/mention'
import { MentionSuggestion, MentionView } from '@penline/mention/react'

const plugins = [paragraph, bold, image, mention] as const
// Keep these stable (module constants or useMemo): new objects on every render re-render every node view.
const nodeViews = { image: ImageView, mention: MentionView }
const pluginOptions = {
  image: { upload: async (file: File) => uploadAndReturnUrl(file) },
  mention: { fetchUsers: async (query: string) => searchUsers(query) },
}

function MyEditor() {
  const editor = useEditor({ plugins, nodeViews, pluginOptions })
  return (
    <>
      <EditorContent editor={editor} />
      <MentionSuggestion editor={editor} /> {/* the @-mention popup, rendered once */}
    </>
  )
}
```

`nodeViews` is read once, when the editor is created. To switch a view at runtime, render a component that reads React context, as the playground does in `apps/playground/src/image-views.tsx`.

## Use the core without React

```ts
import { Editor } from '@penline/core'
import { paragraph } from '@penline/paragraph'
import { bold } from '@penline/bold'

const editor = new Editor({ plugins: [paragraph, bold], content: '<p>Hello</p>' })
editor.mount(document.querySelector('#editor')!) // makes the element contenteditable and renders into it

editor.on('update', () => console.log(editor.getHTML()))
editor.commands.toggleBold()

// later
editor.destroy()
```

A headless editor that is never mounted also works. It is useful on a server or in tests: commands, `getJSON()` and `getHTML()` run without any DOM view.

## Content: JSON and HTML

The document is a tree of elements and texts:

```json
{
  "type": "doc",
  "children": [
    { "type": "paragraph", "id": "p1", "data": {}, "children": [
      { "text": "Hello " },
      { "text": "world", "marks": [{ "type": "bold", "data": {} }] }
    ] }
  ]
}
```

| | |
|---|---|
| Read | `editor.getJSON()` (store this; a mutable copy) or `editor.getHTML()`. To autosave, `JSON.stringify(editor.state.doc)` needs no copy |
| Load | `new Editor({ content })`, or `editor.setContent(jsonOrHtml)` |
| Listen | `editor.on('update', …)`, or `onUpdate` in `useEditor` |

Two kinds of data:
- **Node data** (`data`) is part of the document and saved with it. Examples: an image's `src`, a mention's `userId`, a code block's `language`.
- **Plugin options** are runtime configuration and never saved. Examples: the upload function, `fetchUsers`, `HTMLAttributes`.

HTML is parsed and sanitized through each plugin's `parseHTML` rules:
- Unknown inline tags are unwrapped.
- Unknown block tags become paragraphs.

In JSON, an element whose `type` no plugin knows is kept as an opaque, non-editable block, so loading and saving never loses data.

## Built-in plugins

| Package | What it does | React view |
|---|---|---|
| `@penline/paragraph` | the default block | – |
| `@penline/bold` | bold mark, `Mod-b` | – |
| `@penline/font-size` | font-size mark | – |
| `@penline/image` | image block: upload with preview, resize, alt text, safe `src` policy | `@penline/image/react` |
| `@penline/mention` | `@` mentions with an async suggestion popup | `@penline/mention/react` |
| `@penline/code-block` | code block with highlight.js highlighting, Tab indent, triple-Enter exit | `@penline/code-block/react` |

Undo and redo (`Mod-z`, `Mod-Shift-z`) are built in. Pass `history: false` to turn them off.

## Customizing a plugin

Every plugin with a view can be customized at six levels, from least to most effort:

| Level | How | Example |
|---|---|---|
| 0 | use the default view | `nodeViews: { image: ImageView }` |
| 1 | CSS on stable `data-*` attributes | `[data-penline-image][data-selected] { outline: 2px solid }` |
| 2 | `HTMLAttributes` option, `classNames` prop | `<ImageView {...props} classNames={{ root: 'my-figure' }} />` |
| 3 | hide or replace parts | `<ImageView {...props} parts={{ altInput: false }} />` |
| 4 | build your own view from the hooks | `useImageResize`, `useAltDraft`, `useImageState` |
| 5 | change the behaviour | `image.extend((parent) => ({ … }))` |

Levels 3 and 4 are marked `@experimental` and may still change. [docs/plugin-authoring.md](docs/plugin-authoring.md) has a worked example for each level.

## Writing your own plugin

```ts
import { definePlugin, type Command } from '@penline/core'

export const italic = definePlugin({
  name: 'italic',
  mark: { render: () => ({ tag: 'em' }) },
  parseHTML: [{ tag: 'em' }, { tag: 'i' }],
  commands: () => ({
    toggleItalic: (): Command => ({ tr }) => tr.toggleMark('italic').rejected === null,
  }),
  keymap: (ctx) => ({ 'Mod-i': () => ctx.commands.toggleItalic() }),
})
```

Add it to `plugins`, and `editor.commands.toggleItalic()` is typed automatically.

- [docs/plugin-api.md](docs/plugin-api.md) describes every field of the object passed to `definePlugin`. It covers schema, options, commands, keymap, input rules, transaction hooks, HTML, decorations, state and storage, and the lifecycle hooks.
- [docs/plugin-authoring.md](docs/plugin-authoring.md) builds a complete plugin with a React view: logic, hooks, parts and a default view.

## Tests

| Command | What |
|---|---|
| `pnpm test` | unit tests (Vitest + happy-dom) |
| `pnpm typecheck` | TypeScript, including the docs' code samples |
| `pnpm exec vitest --typecheck run` | type-level tests (`*.test-d.ts`) |
| `pnpm --filter playground e2e:chromium` | end-to-end tests in Chromium (Playwright) |
| `pnpm --filter playground e2e:webkit` | the same in WebKit |

The first e2e run needs browsers: `pnpm --filter playground exec playwright install chromium webkit`. The e2e suite starts its own dev server on port **5174** (or `E2E_PORT`), which must be free. `pnpm e2e` runs Chromium and WebKit together; Firefox is not part of the automated suite.

### CI and releases

- **CI** (`.github/workflows/ci.yml`) runs on every pull request and every push to `main`: typecheck, unit tests (a failing test is retried twice: a few are timing-bound), type tests, the package build, and e2e in Chromium and WebKit. A failed e2e run uploads the Playwright report.
- **Versions** are managed with [Changesets](https://github.com/changesets/changesets). A pull request that changes what users of a package see adds a changeset: run `pnpm changeset`, pick the packages and the bump (patch, minor, major), write one line for the changelog, and commit the file it creates in `.changeset/`. Every `@penline/*` package shares one version: a bump of one bumps them all.
- **Release** (`.github/workflows/release.yml`) runs on every push to `main`. While changesets are pending, it opens (or updates) a "chore: version packages" pull request that bumps the versions and writes each package's `CHANGELOG.md`. Merging that pull request publishes to npm, with provenance, and tags the release. That pull request is opened by GitHub Actions, so CI does not run on it (it only changes versions and changelogs).
- Setup, once, in the repository settings: a secret `NPM_TOKEN` (an npm granular access token with read and write access to the `@penline` packages, "bypass 2FA" on), and Actions > General > "Allow GitHub Actions to create and approve pull requests". The job runs in the `npm` environment, which can require a reviewer before publishing.
- Publishing by hand still works: `npm login`, then `pnpm release` (with `--otp=<code>` when 2FA is on).

## Repository layout

```
packages/
  core/            @penline/core: model, operations, transactions, history, plugins, DOM view
  react/           @penline/react: useEditor, EditorContent, useEditorState, node views, customization helpers
  plugins/
    paragraph/ bold/ font-size/ image/ mention/ code-block/
apps/
  playground/      demo app + Playwright e2e tests
docs/
  architecture.md      layers today, future code view, LSP, settings
  plugin-api.md        definePlugin reference
  plugin-authoring.md  writing and customizing plugins
  superpowers/         design spec, milestone plans, follow-up lists
```

## Browser support

The targets are desktop Chrome, Firefox and Safari. Mobile is best-effort. The current state:
- **Chromium:** fully covered by e2e.
- **WebKit (Playwright):** passing. A few clipboard and IME tests are skipped, for reasons explained in `docs/superpowers/m4-cross-browser.md`.
- **Firefox and real Safari on macOS:** not covered by the automated suite; to be checked by hand before a release.

## Documentation

- [docs/architecture.md](docs/architecture.md): the current layers, plus the future direction (a VS Code-like code view, LSP integration, settings).
- [docs/plugin-api.md](docs/plugin-api.md): reference for the `definePlugin` object.
- [docs/plugin-authoring.md](docs/plugin-authoring.md): guide to customization levels and writing a plugin.
- `docs/superpowers/specs/2026-10-27-headless-editor-design.md`: design spec.
- `docs/superpowers/m*-followups.md`: known gaps and planned work.
- [CHANGELOG.md](CHANGELOG.md): behaviour changes.
