# Changelog

## Unreleased: v1 cleanup

Behaviour changes an integrator may notice.

### Content and JSON
- Normalize rule 10 gives every inline element a text sibling on each side, possibly empty. This covers inline atoms (mentions) and unknown types found in inline content. Stored JSON that is loaded and read back with `getJSON()` gains `{ text: '' }` nodes around them.
- Loading content drops `children` on registered atoms: an atom has none. Subtrees below unknown elements are still kept as given.
- The default block must accept empty data. The core creates default blocks with `{}`, and the stored data is the schema's output for it, so defaults apply. A required field without a default makes the editor constructor throw a clear error.
- Malformed clipboard payloads produce one warning per paste, with the count and the first offender, instead of one per dropped node. Loading content still warns once per dropped node.
- `getJSON()` is still a mutable copy, but much faster. To autosave, `JSON.stringify(editor.state.doc)` needs no copy.

### HTML and attributes
- `mergeAttrs` normalizes a `style` from `extra` even when the base has none. It drops CSS comments, and drops a declaration whose string or parenthesis is never closed, so the declarations merged after it survive. A style left with no declarations is omitted. A mark style value with an unclosed quote is no longer serialized.
- In `renderHTML`, a content hole (`0`) inside a void tag throws. Only the first hole gets the content, in the view and in `getHTML()` alike.

### Types
- The doc is read-only through every accessor: `getNode`, `getParent`, `nodeEntries`, `textEntries` return `DeepReadonly` nodes, and `tr.doc` is `DeepReadonly<Doc>` (as `editor.state.doc` already was). Change the doc through a transaction. `isText` / `isElement` narrow read-only and mutable nodes alike.

### Editor and view
- New `EditorOptions.listeners`: `transaction`, `update`, `selectionUpdate` and `options` listeners registered before any plugin hook, so they also see dispatches from `onCreate`.
- `editor.dev` is public (read-only).
- `data-editor-ignore` is honoured only inside a node view's own DOM.
- Node-view warnings follow `editor.dev`, not `NODE_ENV`.
- `coordsAt` returns null when nothing measured has a height.
- `EditorView.hasFocus` is no longer public (it was marked `@internal`).
- New exports `WIDGET_ATTR` and `DECO_ATTR`.
- A plugin's `handleDOMEvents.beforeinput` returning true now prevents the event, as `keydown` does.
- A throwing `transformPasted` or `decorations` hook is skipped and logged, instead of losing the paste or the render.

### React
- `useEditor` builds one editor per mount, StrictMode included, and reports dispatches from the first commit (and from `onCreate`) to `onUpdate`.
- React node views render with new `pluginOptions` in the same commit.
- `resolveParts` infers its overrides (a new `ResolvedParts` type); `usePluginState` is typed against the editor's plugins.

### Plugins and input
- Input rules match anchored at the caret, with or without a trailing `$`, across inline elements such as links. `findTrigger` reads the same text when given `registry`.
- Mention: `MentionState.dismissedAt` is now `dismissed` (an array); new `MentionStorage.user(id)`. Its priority is 160 (was 150), so an open popup claims Enter before a code block.
- Code block: new `languageLabel` option (default `'Language'`); `useCodeBlock` returns a memoized object.
- Image: a preview's `blob:` URL is revoked once its upload settled and nothing can show it; a pasted `blob:` image this editor does not own (or whose upload failed) is dropped; an invalid `width` is ignored instead of dropping the image.

### Tooling
- The e2e suite runs Chromium and WebKit; Firefox is no longer part of it (checked by hand).
- Playwright reads `E2E_PORT` (default 5174) and `E2E_REUSE_SERVER=1` (never on CI).
