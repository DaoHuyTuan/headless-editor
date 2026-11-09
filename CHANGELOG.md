# Changelog

## Unreleased: v1 cleanup

Behaviour changes an integrator may notice.

### Content and JSON
- Normalize rule 10 gives every inline element a text sibling on each side, possibly empty. This covers inline atoms (mentions) and unknown types found in inline content. Stored JSON that is loaded and read back with `getJSON()` gains `{ text: '' }` nodes around them.
- Loading content drops `children` on registered atoms: an atom has none. Subtrees below unknown elements are still kept as given.
- The default block must accept empty data. The core creates default blocks with `{}`, and the stored data is the schema's output for it, so defaults apply. A required field without a default makes the editor constructor throw a clear error.
- Malformed clipboard payloads produce one warning per paste, with the count and the first offender, instead of one per dropped node. Loading content still warns once per dropped node.

### HTML and attributes
- `mergeAttrs` normalizes a `style` from `extra` even when the base has none. It drops CSS comments, and drops a declaration whose string or parenthesis is never closed, so the declarations merged after it survive. A style left with no declarations is omitted. A mark style value with an unclosed quote is no longer serialized.
- In `renderHTML`, a content hole (`0`) inside a void tag throws.

### View
- `data-editor-ignore` is honoured only inside a node view's own DOM.
- Node-view warnings follow `editor.dev`.
- `coordsAt` returns null when nothing measured has a height.

### Plugins and input
- Input rules match anchored at the caret.
- Mention: `MentionState.dismissedAt` is now `dismissed`.
