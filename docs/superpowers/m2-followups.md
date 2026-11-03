# M2 follow-ups (input for the M3+ plans)

Collected from the per-task and final reviews of milestone M2 (branch `feat/m2`). The open items of `m1-followups.md` still apply as well.

## Start of M3: do these first
Status after M3 verification: the typed storage/state and `appendTransaction` items were closed in M3. The other three moved to the M4 section below.

- ✅ done in M3: ~~**Typed access to a plugin's own storage and state.** `ctx.storage` is typed like `ctx.commands`, `usePluginState` reads a plugin's state with types, and the casts in `@hte/image` are gone.~~
- ✅ done in M3: ~~**`appendTransaction` joining history entries** (moved from M1). Appended trs join the entry of the transaction that triggered them (`91f6359`).~~
- ✅ closed in M4 part 1: ~~Moved to M4: **History mapping instead of clearing.** Structural changes made outside history (for example a failed upload removing an image) still clear the whole undo history.~~
- ✅ closed in M4 part 1: ~~Moved to M4: **Move clipboard parse/serialize out of `view/` into `content/`.** `core-plugin.ts` imports `view/clipboard` today.~~
- ✅ closed in M4 part 1: ~~Moved to M4: **Text pasted over a node selection** lands in the previous block, while typing replaces the node in place.~~

## M4
Kept open from "Start of M3" (no M3 plugin needed them, and each is a separate core change). All three closed in M4 part 1:
- ✅ ~~Map the history stacks through outside-history structural changes instead of clearing them.~~
- ✅ ~~Move clipboard parse/serialize into `content/`.~~
- ✅ ~~Make text pasted over a node selection behave like typing over it.~~

## Image
- After a failed upload where the user had changed the original's `src` meanwhile, undo can restore the dead `blob:` src.
- A copy of a pending image pasted into **another** editor keeps the blob URL; the source editor revokes it on destroy.
- `rewriteHistoryData` overwrites a `src` the user set before removing the image (documented).
- A pending blob src set by hand through `setNodeData` is not tracked as a copy.
- Blob URLs are revoked only on `destroy`, so long sessions hold every preview in memory.
- A drop ignores the drop point while a node is selected, so the dropped file can replace the selected image.
- Width parsing accepts unsafe integers (the schema then rejects them).
- The view-side `safeSrc` guard has no unit test.
- Resize handle:
  - no `lostpointercapture` fallback;
  - no accessibility (role, label);
  - no behavioural test that a mousedown on the handle or the input doesn't node-select.
- Failing to upload the last block's image leaves a trailing empty paragraph.

## Core / view
- `Transaction.setSelection` accepts a `node` path that isn't opaque (programmatic or remote only).
- `data-editor-ignore` is honoured anywhere under the root; scope it to node-view containers.
- ✅ done in M3: ~~`pluginOptions` given an inline function re-renders every node view of that type on each parent render. Document "memoize options".~~ (documented in `docs/plugin-authoring.md`)
- ✅ done in M3: ~~Re-entrant destroy: if `unmount()` throws, the editor is left `destroying` and `destroy()` can't be retried.~~ (`editor.ts` `destroy()` catches the `unmount()` error, still runs every destroy hook and marks the editor destroyed, then rethrows; covered by `lifecycle-view.test.ts` "editor.destroy() still runs the destroy hooks when a cleanup throws")
- `ctx.commands` is empty during the initial normalize, and `editor.storage` is undefined while storage factories run. Document both.
- ✅ done in M3: ~~Storage and commands type inference depends on the order of keys in the spec. Try `NoInfer`, or document the required order.~~ (order documented in `docs/plugin-authoring.md`, pinned by a type test)
- Only the first destroy-hook error is rethrown (use `AggregateError`).
- The renderer:
  - clears `invalidated` even when a render throws;
  - builds a frozen options copy on every `renderHTML` call;
  - doesn't pass the node selection on the initial render.
- `NodeViewHost.update` comment is wrong (stale `props.node`).
- JSDoc hazards:
  - `ignoreMutation` returning false can loop with async view rendering;
  - `stopEvent` should point focusable controls to `data-editor-ignore`.
- node-select's `mousedown` blocks native drag and shift-click.
- Node-view options are looked up by node type, not plugin name.
- Normalize and editing:
  - a hoisted atom next to empty texts leaves a stray empty paragraph (rule 9 runs before rule 4);
  - `edgeBlockOf` treats unknown inline elements as edge blocks;
  - split halves share a `data` reference;
  - `nearestEditablePoint` is O(doc).
- Node selection:
  - an op that removes the anchor text while the node survives leaves the selection null;
  - `isMarkActive` shows caret marks while a node is selected;
  - `caretAfterNode` can skip past a following atom.
- Pasting several blocks with an atom at an edge can leave an empty paragraph next to it.
- A drop within 500 ms of typing joins the typing undo step, and a drop moves the caret even when nothing was inserted.
- History replay runs on every data-only change made outside history; add a guard when the stacks hold no `set_node_data`.
- `rewriteHistoryData` doesn't validate its data.
- Validated data from insert can alias the caller's object.
- A default block whose schema has required fields would make normalize's inserts reject.
- The mutation.ts JSDoc is garbled.
- Duplicate `samePath` helpers.

## React adapter
- StrictMode builds a throwaway editor in the `useState` initializer.
- Node views get one commit with stale options after a `pluginOptions` change.
- No tests yet for a dispatch from a node view's `useEffect`, or for `EditorContent` receiving a different editor.

## Tests / tooling
- Gaps:
  - e2e for undo during a pending upload;
  - font-size e2e that selects with the mouse instead of the editor API;
  - multi-entry redo replay and replay-failure fallback;
  - the non-sibling opaque `deleteRange` branch;
  - `fragment.test.ts` assertions on unknown subtrees.
- `image.test.ts` has a prettier formatting nit (`toRange,   type Doc,`).
- The playground's `fakeUpload` never revokes its URLs, and the playground sets no `onUploadError`.
