# Architecture and future direction

This page records the current architecture and the decisions taken about where it is going. The main future direction is a **code view**: a VS Code-like code editor built on the same core and plugin system. Nothing here is scheduled yet. Read this page before starting that work.

Status: written 2026-11-03, after M4. The design spec is `docs/superpowers/specs/2026-10-27-headless-editor-design.md`.

## 1. Layers today

```
 Plugins (definePlugin)            paragraph · bold · font-size · image · mention · code-block
        │ register
        ▼
 @hte/core: model layer            doc tree · ops · transaction pipeline · history (+ rebase)
                                   · plugin registry · commands · content I/O (HTML, clipboard)
        │ (no formal boundary yet: Editor.mount creates EditorView directly)
        ▼
 DOM document view (in core/view) renderer · dom-selection · input/composition · mutation
                                   · decorations · node views
        ▲
 @hte/react                        useEditor · EditorContent (portals for node views) · hooks
```

Properties worth keeping:
- **The model layer has no DOM.** An editor that is never mounted still runs commands, `getJSON()` and `getHTML()`. Content I/O moved out of `view/` into `content/` in M4.
- **Every change is an invertible op.** History, history rebasing through changes made outside history, and later collaboration all build on this.
- **Features are plugins.** The core knows no paragraph or bold; it knows only the plugin contract. See [plugin-api.md](plugin-api.md).

Known coupling in the current code:
- `Editor.mount(el)` constructs `EditorView` itself.
- `PluginSpec` mixes model hooks with hooks that only make sense for the DOM view:
  - model hooks: `commands`, `filterTransaction`, `normalize`, `state`, `renderHTML`, …
  - DOM hooks: `stopEvent`, `ignoreMutation`, `handleDOMEvents`, `onMount(view)`, node views.
- The `Decoration` type lives in `view/decorations.ts`, although it only uses model `Point`s.
- `useEditor` reads `nodeViews` once, when the editor is created. Changing it later is ignored silently, while `pluginOptions` is synced.

## 2. What the engine is, and is not, for

| Fits well | Does not fit as-is |
|---|---|
| Documents with mixed content: wiki, Notion/Confluence-like pages, blog/CMS | IDE-scale code editing |
| Notebooks: prose plus many short code blocks | Files of 10k–100k lines |
| Code blocks with highlighting, and with LSP features at snippet scale | Multi-cursor, column selection, minimap |

Leaving out the document plugins does **not** turn the engine into a code editor. The limits are in the core:
1. The renderer draws the whole document into `contenteditable`; nothing is virtualized.
2. The model is a node tree. One block per line turns a large file into thousands of nodes, and normalize and decorations currently walk the whole doc.
3. `Selection` is a single range, so there is no multi-cursor.
4. The browser draws the caret and owns native selection.

`contenteditable` itself is **not** the blocker. CodeMirror 6 uses `contenteditable` and renders only the visible viewport, with spacers above and below.

## 3. Future: a code view

Goal: a second view, beside the DOM document view, that renders like a code editor. It reuses the core (ops, transactions, history, plugins, commands, keymap, state, decorations) and swaps only the view layer.

```ts
new Editor({ plugins, view: 'document' }) // today
new Editor({ plugins, view: 'code' })     // future
```

### What the code view needs

| Piece | Size | Notes |
|---|---|---|
| Viewport renderer | large | Track scroll, measure line heights, add spacers. The hard parts are a selection that extends off-screen and IME near the edges of the viewport. |
| Line schema | small | `doc > line*` of text-only lines, enforced by a plugin and normalize. |
| Incremental normalize and decorations | medium | Only touch changed nodes. This also benefits the document view. |
| Multi-selection | large, API-breaking | **Decided: model-level** (see §4a). `Selection` becomes a list of ranges with a primary one. Commands, transactions and history handle every range. The view draws the extra carets: the primary caret is native, the others are drawn in an overlay, as in CodeMirror. |
| Self-drawn selection and caret overlay | medium | Needed for multi-cursor and column selection. |
| Gutter, folding, minimap | medium | Parts of the code view, or plugins that target it. |

### Shared and separate

- **Shared:** ops, transactions, history, `definePlugin` (commands, keymap, state, storage, lifecycle, filters), decorations (defined over `Point`), and the LSP, highlighting and search plugins.
- **Separate:** the renderer, selection sync, DOM reading, input and composition (essentially all of `view/`). Node views are document-view only, so plugins must declare which views they support.

### Risks
- **Two views to maintain.** Every browser or IME fix has to be made twice. M4 showed how costly one view already is.
- **Plugin × view compatibility matrix.** Which plugin runs in which view has to be declared and tested.
- **Multi-selection changes the core API.** Decide it early, with a migration plan.

## 4. Roadmap to get there

Steps 1–4 are worth doing even if the code view never happens.

1. **Extract a `View` interface** from `EditorView`, with what `Editor` needs: `update(state)`, `destroy()`, `coordsAt(pos)`, `hasFocus()`, `focus()`. `Editor.mount(el, viewFactory?)` takes a factory and defaults to the document view. This is a refactor with no behaviour change.
2. **Enforce the dependency direction.** The model layer must not import from `view/`. Guard this with a lint rule or an import test.
3. **Move neutral types down to the model.** `Decoration` moves to the model layer. DOM-only hooks (`stopEvent`, `ignoreMutation`, node views, `handleDOMEvents`) are grouped as DOM-view extensions, so a code view can add its own group.
4. **Make normalize and decorations incremental.** This is open in the follow-ups: code-block decorations walk the whole doc, and normalize rule 11 used to be super-linear.
5. **Spike a code view.** Build a minimal viewport-rendered, single-caret, line-schema view to test the `View` interface. Only then fix the API.
6. **Split packages** once the spike holds: `@hte/core` (model only), `@hte/view-dom`, `@hte/view-code`.
7. **Multi-selection** as its own milestone, with an API migration (see §4a).

### 4a. Decision: multi-selection lives in the model

Decided 2026-11-03. Multi-cursor is implemented in the **core model**, not as a view-only overlay.

**Implemented** on branch `feat/multi-selection`:
- design: `docs/superpowers/specs/2026-11-03-multi-selection-design.md`;
- plan: `docs/superpowers/plans/2026-11-03-multi-selection.md`;
- API summary: `docs/plugin-api.md`, "Selections and multiple ranges".

The document view still shows a single caret: no UI creates secondary ranges yet, and they are not drawn.

- **Shape.** The selection holds one or more ranges, one of them primary. A single-range selection stays the common case. The document view uses the primary range only and behaves as it does today.
- **Commands and transactions** apply to every range: typing, delete, toggling a mark and paste. Overlapping ranges are merged after each change.
- **History.** One undo step restores every range. `selectionBefore` and `selectionAfter` hold the whole list.
- **Ops and rebase.** Mapping a selection maps each range: `transformSelection` per range. Collaboration can later show remote carets with the same type.
- **View.** The primary caret stays the browser's native one. Extra carets and ranges are drawn by the view in an overlay layer.
- **Rejected alternative:** a view-only overlay that replays commands at each extra caret. It leaves extra carets second-class: commands that don't know about them act on the primary only, and undo does not group the edits.
- **Why decide early:** this changes the core `Selection` API that plugins use. Doing it before many external plugins depend on the current single-range shape keeps the migration small.
- **Migration sketch.** Keep a `selection.main`-style accessor, or helpers, so that plugins written for a single range keep working. Add multi-range-aware helpers, such as "for each range", for commands that should act everywhere.

Do not split into packages before the spike. An interface designed against a single implementation tends to be wrong in the hard places: selection, IME and measurement.

## 5. LSP integration

LSP is plugin-level work; the engine does not know about languages.

**Model to follow:** VS Code's notebooks, not its single-file editor.
- Each code block (cell) is addressed by its node id.
- Blocks of the same language are joined, in document order, into one **virtual file**, so declarations in one block are visible from the next.
- A position map translates between virtual-file positions and (block, offset).
- `didChange` is built incrementally from the transaction's `insert_text` and `remove_text` ops, with an increasing `version`.
- A late result is mapped through later ops with `transformPoint`, or dropped. In-flight requests are cancelled when typing continues.
- Highlighting stays local and instant (highlight.js today, the role TextMate grammars play in VS Code). LSP only adds diagnostics and semantic tokens through decorations.
- Transport is a WebSocket to a backend language server, or a Web Worker for languages that have a web build (TypeScript).

**What the engine already provides:** `onUpdate` with ops, UTF-16 offsets (the LSP default), inline decorations for diagnostics, widget decorations for inlay hints, the mention-style popup machinery (`findTrigger`, `coordsAt`, plugin state, `requestId` race guards) for completion, `storage` and `onMount` cleanup for the connection, and `transformPoint`.

**Gaps to close in the core first:**
- A pointer-event hook for hover: `handleDOMEvents` only covers `keydown`, `beforeinput` and `input`.
- Decorations computed incrementally and cached per node.
- Key priority between a completion popup and code-block keys (Tab, Enter) works today through `priority` and `handleDOMEvents`. It should be documented as a pattern.

**Alternative for IDE-grade code inside a document:** embed CodeMirror 6 in the code-block node view. Make it an atom node view, mark its subtree `data-editor-ignore`, and sync through `updateData`. That brings its LSP client, folding and multi-cursor without a code view. This is how Notion and Jupyter mix document and code engines.

## 6. Settings

There is no settings layer yet. The document view's settings are unknown, while the code view is expected to need many: LSP, AI, account. The decision is to **design the mechanism when the first real consumer needs it**, most likely an LSP or AI plugin for the code view, and to keep these principles until then:

1. **Three different things, three different places:**

   | Kind | Examples | Where |
   |---|---|---|
   | User-facing behaviour settings | tab size, AI inline suggestions on/off, diagnostics verbosity | plugin-declared, namespaced settings (`lsp.diagnostics`, `ai.inlineSuggest`) |
   | Connection configuration | LSP server URL, AI model, endpoints | plugin `options`, given by the app at setup (exists today) |
   | Services and secrets | login, tokens, AI client, LSP client | injected as services or callbacks (`getToken()`, `aiClient`); **never** settings, which get serialized, synced and shown |
2. **Settings belong to plugins.** Each plugin declares its own keys and schema, as VS Code extensions do with `contributes.configuration`. There is no central list in the core.
3. **No mutable global singleton.** Several editors can share a page, SSR shares module state between requests, and tests leak into each other. "Library-wide" means a shared config object passed in, for example `defineEditorConfig(...)`, plus a React `<EditorConfigProvider>`.
4. **Precedence:** plugin options, then editor settings, then shared defaults.
5. **Where it will live:** the model layer, next to the plugin registry. Plugins read it through `ctx.settings`; `editor.setSettings(partial)` emits an event, as `setPluginOptions` does. It must not depend on the DOM, so the code view can use it.

Likely candidates once the mechanism exists: i18n strings (for example the code block's `languageLabel` option, default `"Language"`), `editable`/`readOnly`, the allowed URL schemes now inside image's `safeSrc`, history `groupDelay`, and the `data-hte-*` prefix.

## 7. Open questions

- Should `nodeViews` become updatable at runtime (re-register the factories and invalidate), or be documented as read-once? The playground works around it with React context (`apps/playground/src/image-views.tsx`).
- Decide whether `@experimental` levels 3–4 (parts, hooks) graduate before a second view arrives.
