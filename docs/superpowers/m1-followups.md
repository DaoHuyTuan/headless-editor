# M1 follow-ups (input for the M2+ plans)

Collected from the per-task and final reviews of milestone M1 (branch `feat/m1-core`). Items already fixed in the final fix wave were removed: duplicate ids on load, reversed `Range`, initial selection validation, unknown elements being editable, IME and stored marks, and `getJSON` exposing live state.

## Start of M2: do these first
Status after M2 verification: every item below was closed in M2 except the history one, which moved to M3.

- ✅ done in M2: ~~**Paste through the intent pipeline.** The `paste` handler builds an `insertFromPaste` `InputIntent` and calls `editor.handleIntent`.~~
- ✅ done in M2: ~~**Validate programmatic inserts.** `insertContent`, `tr.insertNode` and `insertFragment` sanitize and validate `data`, and reject unregistered mark types.~~
- ✅ done in M2: ~~**Typed own-commands for plugin authors.** `ctx.commands` is typed from the plugin itself.~~
- ✅ done in M2: ~~**Re-render on option changes.** `setPluginOptions` re-renders elements whose data is unchanged.~~
- ✅ done in M2: ~~**Normalize rule 9 drops atom blocks.** Atom blocks nested in an inline-content block are hoisted after the paragraph.~~
- ✅ done in M2: ~~**`deleteRange` with an opaque edge block.** Guarded against ranges ending inside unknown elements or atoms.~~
- ✅ done in M2: ~~**`serializeHTML` JSDoc.** The URL-scheme and event-attribute policy is stated in the JSDoc.~~
- ✅ done in M2: ~~**React `<Activity mode="hidden">`.** Documented in the `useEditor` JSDoc.~~
- Moved to M3: **appendTransaction and history** (see the M3 section below).

## M3
- **appendTransaction and history.**
  - Trs added by `appendTransaction` become separate undo entries; they should join the entry of the transaction that triggered them.
  - An append fired by undo clears redo.

## Core / model
- ✅ Undoing the duplicate-mark dedupe (normalize rule 6) throws. Only corrupted input can reach this.
- `coerceDoc` keeps `children` on known atoms, but the spec says they should be absent.
- ✅ Normalize rule 4 can leave a block with no text leaf when its other children are inline atoms or unknown elements (M3).
- ✅ Plugin `normalize` hooks also visit entries inside unknown elements and atoms.
- The result of `onInvalidData` is not validated again.
- ✅ `rehomeSelection` drops the selection when no sibling has text.
- Load reserves ids of nodes that are later dropped (harmless renames).
- The readonly typing has gaps:
  - `getNode`, `nodeEntries` and `textEntries` return mutable types.
  - `tr.doc` is typed mutable.
- `getJSON()` deep-clones on every call. That is O(doc) per keystroke for apps that autosave on update.
- Commands that dispatch internally become stale. Document this.
- The stale-tr guard drops silently in prod; add a warning.
- The constructor ignores `contentTransaction.rejected`.
- `setContent` normalizes twice.
- `eventToKeyName` drops Shift for non-letters, so `Mod-Shift-1` can never match.
- `isActive` with an `undefined` data value returns false.
- A throwing event listener skips the remaining events. Wrap each listener and rethrow after all have run.
- `INPUT_ACTIONS` is a plain object, so inherited keys count as handled.
- Backspace segments the whole block, which is O(n).
- ✅ `insertText('')` clears stored marks, and the intent path doesn't dispatch a change to stored marks alone.
- Marks:
  - ✅ `toggleMark` on a range covering no characters does nothing.
  - ✅ `toggleMark` checks activity with the raw data, not the validated data.
  - ✅ Caret toggles always create a new array, which causes no-op dispatches.
  - ✅ An explicit collapsed range returns true but does nothing (kept for single-range parity; documented).
- Fragments:
  - Pasting `[h, p]` into an empty paragraph loses the heading type.
  - ✅ The inline-ancestor split doesn't check `createId` against used ids.
  - ✅ An empty-string id is kept.
  - ✅ Nested containers are flattened.
- History:
  - ✅ `runHistory` returns true even when the dispatch is vetoed.
  - ✅ It uses a `-Infinity` time sentinel.
  - ✅ There is no stack depth limit.
  - A selection change between keystrokes doesn't break the typing group.
  - Cut merges with a previous Backspace.

## HTML
- iframe, object, svg, select, textarea and button are not skipped on parse.
- ✅ Text inside inline elements is not collapsed.
- ✅ Mark styles on node-rule elements are ignored.
- ✅ Inconsistent edge cases:
  - `<div></div>` and `<div> </div>` are treated differently.
  - `<pre>` content is trimmed.
  - A void tag drops its content hole.
- ✅ There is no recursion depth limit.
- ✅ The renderer fills only the first content hole, while the serializer fills every hole.

## View
- Renderer:
  - Replaces the Text node instead of updating `.data`, which churns the caret.
  - ✅ A throw mid-render leaves the id map inconsistent.
  - ✅ `getPluginOptions` returns the live object.
  - Lookups are linear.
- `skipLeaf`:
  - ✅ The docs overstate the "never moved" guarantee.
  - Anchor and before order is not checked.
  - ✅ Text is duplicated without `skipPath`.
  - ✅ An ancestor move can detach the composing leaf.
- dom-selection:
  - ✅ The no-op write can leave the selection in a stray node.
  - ✅ Non-editable positions ignore the offset.
  - `boundaryPoint` is O(leaves).
- EditorView:
  - ✅ The old root stays `contenteditable` after `mount(other)`.
  - ✅ `attach` and `listen` leak after `destroy`.
  - ✅ Remounting rebuilds the DOM.
- Input:
  - ✅ Delete intents ignore the target range.
  - ✅ `targetRange` drops the direction.
  - When a plugin's `beforeinput` handler returns true, the event is not prevented, which is inconsistent with keydown.
  - `handleDOMEvent` and `transformPasted` should be documented as view-integration API.
- Composition:
  - Text written outside the composing leaf is lost.
  - Composing with no leaf, or resuming after blur, fights the IME.
  - A nested dispatch can map ops out of order.
  - Static or atom DOM mutations are not reverted.
  - Safari's `insertFromComposition` is untested (M4).
- Clipboard:
  - A trailing newline adds an empty block.
  - ✅ A throw in `transformPasted` after `preventDefault` loses the paste.
  - Plain-text paste doesn't take the surrounding marks.
  - ✅ A paste with no model selection is swallowed.
  - Malformed payloads spam warnings.

## React adapter
- `onUpdate` can be missed for dispatches during the first commit.
- Passing an explicit `T` to `useEditorState` loses the editor type.
- Coverage gaps: StrictMode for the selector tests.

## Tests / tooling
- Test gaps flagged in reviews:
  - Backspace at `[0,1]:0`.
  - A multi-mark delete across blocks.
  - A block paste at the end of a block.
  - ✅ A vetoed undo.
  - Arrow keys and modifiers.
  - Mount on a destroyed editor.
- `reuseExistingServer` should be `!process.env.CI`.
- The undo e2e depends on history grouping.
- `createTestEditor` re-ids content and swaps the global id generator; document this.
- Real OS IME typing (Vietnamese Telex, Japanese) has not been checked by a human yet.
