# v1 cleanup: triage of the open follow-ups

One list for every open item in `m1`–`m4-followups.md`, `m4-cross-browser.md` and `multi-selection-followups.md` (2026-11-05). Items marked ✅ in those files are not repeated here. The source files stay as the history; when an item here is fixed, mark it ✅ both here and in its source file.

**Source tags:** `m1`, `m2`, `m3`, `m4`, `ms` (multi-selection).

**Kind:** `bug` (wrong behaviour), `perf`, `doc` (JSDoc, comment or guide only), `test` (coverage gap only), `api` (type or API shape), `tool` (tooling).

**Priority:**
- `P1`: a user can hit it with normal editing, or it loses data or history.
- `P2`: reachable only through the API, remote ops, plugin authors or rare input.
- `P3`: cosmetic, or hardening with no known failure.

**Status:**
- `confirmed`: checked against the current code on 2026-11-05; still open.
- `open`: not re-checked. Each fix starts with a failing test, which is the check. If the test cannot fail, the item is stale: close it with a note.

Items that cannot be acted on here (other machines, decisions, rulings already recorded) are listed at the end, under "Closed as noted".

---

## Batch 1: Editor core, events and lifecycle
| # | Item | Src | Kind | Pri | Status |
|---|---|---|---|---|---|
| 1.1 | ✅ A throwing event listener skips the remaining listeners (`editor.ts` `emit`); also cuts hook isolation. Wrap each, rethrow after all ran. | m1, m3 | bug | P2 | fixed |
| 1.2 | ✅ The stale-tr guard drops silently in prod; add a warning. | m1 | bug | P2 | fixed |
| 1.3 | ✅ The constructor ignores `contentTransaction`'s `rejected`. Not reachable today: coerced content never rejects, and a rejecting default block makes normalize throw first (see 3.12). Closed. | m1 | bug | P2 | fixed |
| 1.4 | ✅ `setContent` normalizes twice (in `contentTransaction` and in `applyTransaction`). | m1 | perf | P3 | fixed |
| 1.5 | ✅ `isActive(type, { k: undefined })` returns false. Decided: an `undefined` entry is ignored, like a missing key (elements and marks), documented on `isActive`. | m1 | bug | P2 | fixed |
| 1.6 | ✅ `eventToKeyName` drops Shift for non-letters, so `Mod-Shift-1` never matches. | m1 | bug | P1 | fixed |
| 1.7 | ✅ `INPUT_ACTIONS` is a plain object, so inherited keys count as handled (use `Object.hasOwn` or a `Map`). | m1 | bug | P3 | fixed |
| 1.8 | ✅ Only the first destroy-hook error is rethrown (use `AggregateError`). | m2 | bug | P2 | fixed |
| 1.9 | ✅ A throwing `onCreate` leaks the resources of earlier plugins. | m3 | bug | P2 | fixed |
| 1.10 | ✅ A nested dispatch leaves state ahead of the tr. By design (committed at once); documented on `editor.on`: read the outer change from `e.tr`. | m3 | doc | P2 | fixed |
| 1.11 | ✅ `ctx.commands` is empty during the initial normalize, and `editor.storage` is undefined while storage factories run. | m2 | doc | P3 | fixed |
| 1.12 | ✅ Commands that dispatch internally become stale. | m1 | doc | P3 | fixed |
| 1.13 | ✅ Lifecycle docs: unmount fires no `onBlur`, mount on a focused root fires no `onFocus`; `editor.view` is null during `onMount`; `onCreate` must be side-effect-free under StrictMode. | m3 | doc | P3 | fixed |
| 1.14 | ✅ The result of `onInvalidData` is not validated again. | m1 | bug | P2 | fixed |
| 1.15 | ✅ Readonly typing gaps: `getNode`, `nodeEntries`, `textEntries` return mutable types; `tr.doc` is typed mutable. Deferred: a breaking type change across the core; do it with the API review before publishing. Decided 2026-11-09: done before v1. All four return `DeepReadonly`; `isText` / `isElement` are generic over read-only and mutable nodes. Internally, the doc's own objects are cast only where they become op payloads (ops never mutate them). `getJSON()` stays a mutable copy (8.1, decided the same day). | m1 | api | P3 | fixed |
| 1.16 | ✅ `PluginOverrides` types `state.apply` / `mark.render` as `any` in `extend`. By design: an override may change the data and state types (commented in `PluginOverrides`). Closed. | m3 | api | P3 | fixed |
| 1.17 | ✅ `Transaction.setSelection` accepts a `node` path that isn't opaque (now throws in dev mode). Kept: `nodeSelection` of an inline atom, which `MentionView`'s `data-selected` relies on. | m2, m4 | bug | P2 | fixed |

## Batch 2: History
| # | Item | Src | Kind | Pri | Status |
|---|---|---|---|---|---|
| 2.1 | ✅ A selection change between keystrokes doesn't break the typing group. | m1 | bug | P1 | fixed |
| 2.2 | ✅ Cut merges with a previous Backspace. | m1 | bug | P1 | fixed |
| 2.3 | ✅ A drop within 500 ms of typing joins the typing undo step; a drop moves the caret even when nothing was inserted. | m2 | bug | P1 | fixed |
| 2.4 | ✅ No stack depth limit. Now the `depth` option (default 100): recording past it drops the oldest step. | m1 | bug | P2 | fixed |
| 2.5 | ✅ `runHistory` returns true even when the dispatch is dropped. Now false when the state did not change, like a bound command. | m1 | bug | P3 | fixed |
| 2.6 | ✅ `-Infinity` time sentinel for "closed group"; replace with an explicit flag. Now `HistoryEntry.closed`; `time` is kept. | m1 | api | P3 | fixed |
| 2.7 | ✅ Entries grow across undo/redo cycles with appends (no compaction). Folds now cancel an op that meets its inverse (`compactOps`). | m3 | perf | P2 | fixed |
| 2.8 | ✅ A structural append under `addToHistory: false` clears the stacks. Stale: since M4 it maps the stacks (`rebaseStack`); a test now covers it after an undo too. Closed. | m3 | bug | P2 | fixed |
| 2.9 | ✅ History replay runs on every data-only change made outside history; skip when the stacks hold no `set_node_data`. | m2 | perf | P3 | fixed |
| 2.10 | ✅ `rewriteHistoryData` doesn't validate its data. Every merged stored copy is validated now; a failure rejects the rewrite (throws in dev mode). | m2 | bug | P2 | fixed |
| 2.11 | ✅ A mixed data+structural outside tr drops entries the data path would rewrite. Its data ops now rewrite the payloads, and only the other ops are rebased. | m4 | bug | P2 | fixed |
| 2.12 | ✅ Undoing the duplicate-mark dedupe (normalize rule 6) throws (corrupted input only). Rule 6 now replaces a text with repeated mark types (its inverse is valid) and keeps the selection; a plain reorder still uses mark ops. | m1 | bug | P3 | fixed |
| 2.13 | ✅ Docs: appended trs cannot be separate undo steps; meaning of `selectionBefore` after a fold. | m3 | doc | P3 | fixed |
| 2.14 | ✅ Tests: 3+ levels of appends, a selection-only append, a data-only append after an undo root; multi-entry redo replay and replay-failure fallback; a vetoed undo. All added except the replay-failure fallback, which the public API cannot reach (the stacks always replay from the doc they were kept with); it stays as a defensive branch. The data-only append test found growth that 2.7 missed: back-to-back `set_node_data` on one path now merge. | m1, m2, m3 | test | P3 | fixed |

## Batch 3: Text, marks, fragments and normalize
| # | Item | Src | Kind | Pri | Status |
|---|---|---|---|---|---|
| 3.1 | ✅ Pasting `[h, p]` into an empty paragraph loses the heading type; a lone non-opaque block pasted over a node selection becomes a paragraph. | m1, m4 | bug | P1 | fixed |
| 3.2 | ✅ Pasting several blocks with an atom at an edge leaves an empty paragraph next to it (leading edge fixed; a trailing atom keeps the empty right half on purpose: the caret goes there). | m2 | bug | P1 | fixed |
| 3.2b | ✅ A hoisted atom next to empty texts leaves a stray empty paragraph (normalize rule 9 runs before rule 4). Rule 9 now drops those empty texts before hoisting. | m2 | bug | P2 | fixed |
| 3.3 | ✅ `insertText('')` clears stored marks, and the intent path doesn't dispatch a stored-marks-only change. An empty insert at a caret is now a no-op; the intent path dispatches a stored-marks-only change like bound commands. | m1 | bug | P2 | fixed |
| 3.4 | ✅ `toggleMark`: on a range covering no characters it does nothing and stays on "add"; it checks activity with raw data, not validated data; caret toggles always allocate a new array (no-op dispatches); an explicit collapsed range returns true but does nothing. Such ranges now toggle the stored marks like carets; activity uses the validated data; an unchanged stored set keeps its reference. The explicit collapsed range keeps returning true (recorded single-range parity), now documented on `eachTarget`. | m1, ms | bug | P2 | fixed |
| 3.5 | ✅ Fragments: the inline-ancestor split doesn't check `createId` against used ids; an empty-string id is kept; nested containers are flattened. `splitBlockAt` takes an id source (fragments pass one checked against the doc); `''` gets a fresh id; a container (a block without `content` that holds blocks) at a fragment edge or alone goes in whole. | m1 | bug | P2 | fixed |
| 3.6 | ✅ Normalize rule 4 can leave a block with no text leaf when its other children are inline atoms or unknown elements. Rule 10 (and rule 4's exception for it) now counts an unknown type in inline content as an inline element: it gets a text on each side. Atoms were already covered by rule 10. Changes `getJSON()` for docs holding such elements (changelog note, with 9.5). | m1 | bug | P2 | fixed |
| 3.7 | ✅ Plugin `normalize` hooks also visit entries inside unknown elements and atoms. They visit the opaque element, not its descendants. | m1 | bug | P2 | fixed |
| 3.8 | ✅ `coerceDoc` keeps `children` on known atoms (spec says absent). Dropped on load (parity data updated: only `children: []` left atom payloads). | m1 | bug | P3 | fixed |
| 3.9 | ✅ `rehomeSelection` leaves the selection on a removed node when no sibling has text. Rule 4 then puts a caret at the doc's nearest editable point. | m1 | bug | P2 | fixed |
| 3.10 | ✅ Split pieces / split halves share a `data` reference; validated insert data can alias the caller's object. `split_node` gives the right half a copy; validated node, `setNodeData` and mark data are copied into the doc (`cloneJson`). | m2, m4 | bug | P2 | fixed |
| 3.11 | ✅ `edgeBlockOf` treats unknown inline elements as edge blocks. An edge inside one belongs to the block around it, and a range delete moves such an edge out of it (the element is removed whole). | m2 | bug | P2 | fixed |
| 3.12 | ✅ A default block whose schema has required fields makes normalize's inserts reject. Defaults apply (inserts store the schema output); a required field without a default throws a clear error at construction instead of looping in normalize. | m2 | bug | P3 | fixed |
| 3.13 | ✅ Node selection: an op that removes the anchor text while the node survives leaves the selection null; `isMarkActive` shows caret marks while a node is selected; `caretAfterNode` can skip past a following atom. The node is selected again (`nodeSelection`); only stored marks count for a selected node; an empty block goes between a block node and a following opaque block. | m2 | bug | P2 | fixed |
| 3.14 | ✅ Inline atoms: `insertInlineNode` returns false with ops on the tr; `pastMiddle` asymmetry for text-less atoms; unknown inline elements get no rule-10 siblings (✅ fixed with 3.6); rule 10 changes the link-end caret (untested). False with ops happens only on a rejected tr, which is never applied (documented; now tested); a position inside the last child of a text-less atom is past its middle; the link-end caret (typing after a trailing link types outside it) is tested. | m3 | bug | P2 | fixed |
| 3.15 | ✅ Multi-selection core: touching ranges across a text-node boundary stay two ranges; commit-time `rehomeRanges` can span blocks for a half-invalid raw selection; one position can sit in two leaves until commit; a `forEachRange` callback that deletes and re-inserts text skips later carets inside it; the selection after a mark split lands at offset 0 of the next text. Fixed: `rehomeRanges` merges ranges touching across leaves, and collapses a half-invalid range at its re-homed point. Documented (by design, now tested): two leaves inside a tr until commit; delete-then-reinsert swallows later carets (positional mapping); the mark-split edge is the same position (single-range parity). | ms | bug | P2 | fixed |
| 3.16 | ✅ Tests: Backspace at `[0,1]:0`, multi-mark delete across blocks, block paste at the end of a block, the non-sibling opaque `deleteRange` branch, `fragment.test.ts` unknown subtrees, rule-11 multi-newline selection mapping, merging across blocks and a non-main node range (`createSelection`), non-atom block node views cannot be node-selected. All added; they pass (no bug found). | m1, m2, m4, ms | test | P3 | tested |
| 3.17 | ✅ `comparePath` treats an ancestor and a descendant as equal (safe today: add a comment). JSDoc says so, why it is safe for selection points, and when to use `pathEquals` / `isAncestorPath`. | ms | doc | P3 | documented |

## Batch 4: HTML parse/serialize and clipboard
| # | Item | Src | Kind | Pri | Status |
|---|---|---|---|---|---|
| 4.1 | ✅ A pasted trailing newline adds an empty block. | m1 | bug | P1 | fixed |
| 4.2 | ✅ Plain-text paste doesn't take the surrounding marks. | m1 | bug | P1 | fixed |
| 4.3 | ✅ A throw in `transformPasted` after `preventDefault` loses the paste. The throwing transform is skipped and logged (`console.error`); the others run. | m1 | bug | P2 | fixed |
| 4.4 | ✅ A paste with no model selection is swallowed. It goes to the end of the doc (a new default block when there is no editable text). | m1 | bug | P2 | fixed |
| 4.5 | ✅ Malformed payloads spam warnings. One warning per paste (count and first offender); loading content still warns per node. A multi-range paste whose rich flavor parses to nothing can warn once per range. | m1 | bug | P3 | fixed |
| 4.6 | ✅ Parse doesn't skip iframe, object, svg, select, textarea, button. | m1 | bug | P1 | fixed |
| 4.7 | ✅ Text inside inline elements is not whitespace-collapsed. Collapsed across their texts now (edges kept). | m1 | bug | P2 | fixed |
| 4.8 | ✅ Mark styles on node-rule elements are ignored. Mark rules now also run on elements an element rule matched. | m1 | bug | P2 | fixed |
| 4.9 | ✅ Edge cases: `<div></div>` vs `<div> </div>`; `<pre>` content is trimmed; a void tag drops its content hole. Both give an empty block; `<pre>` keeps its whitespace; a hole in a void tag throws in the serializer and the renderer alike. | m1 | bug | P2 | fixed |
| 4.10 | ✅ No recursion depth limit in parse. Past 256 levels, content is read as flat text (iteratively). | m1 | bug | P2 | fixed |
| 4.11 | ✅ The renderer fills only the first content hole, the serializer every hole. The serializer fills only the first too (documented in plugin-api). | m1 | bug | P2 | fixed |
| 4.12 | ✅ Attributes: `mergeStyle` only normalizes when base has a style; `parseStyle` ignores comments and unbalanced quotes. `style` from `extra` normalized without a base style; comments dropped; an unclosed string or parenthesis drops its declaration; an empty style is omitted. | m3 | bug | P3 | fixed |
| 4.13 | ✅ Clipboard tests: html-only multi-block variants keep `text/plain`; no html-only marks variant. HTML-only variants (no `text/plain`) added in `test/content/paste-edge.test.ts`. | m4 | test | P3 | tested |

## Batch 5: DOM view (renderer, selection, input, composition, decorations, node views)
| # | Item | Src | Kind | Pri | Status |
|---|---|---|---|---|---|
| 5.1 | ✅ A click exactly on the main caret keeps the secondary ranges (flag `pointerdown`, collapse on next sync). | ms | bug | P1 | fixed |
| 5.2 | ✅ The renderer replaces the Text node instead of updating `.data`, which churns the caret. | m1 | bug | P1 | fixed |
| 5.3 | ✅ Composition: text written outside the composing leaf is lost (bare Text nodes beside the leaf are now read in). | m1 | bug | P1 | fixed |
| 5.3b | Composition: composing with no leaf or resuming after blur fights the IME; a nested dispatch can map ops out of order; static or atom DOM mutations are not reverted. Needs a repro with a real IME (or CDP IME in Chromium e2e) before a fix. Tried with CDP IME in Chromium e2e (2026-11-09): composing with no leaf and resuming after blur do not reproduce (DOM and model agree; Chromium commits on blur). Nested dispatch and static/atom mutations not tried yet. Real IMEs stay on the release checklist. | m1 | bug | P2 | open |
| 5.4 | ✅ node-select's `mousedown` blocks shift-click (fixed). Native drag out of the editor is unsupported anyway (`dragstart` is prevented). | m2 | bug | P1 | fixed |
| 5.5 | ✅ Input: delete intents ignore the target range; `targetRange` drops the direction; a plugin `beforeinput` handler returning true does not prevent the event (keydown does). A remote target (not touching the main range) is deleted exactly; otherwise the core unit logic runs. A target equal to the main range keeps its direction. A claimed `beforeinput` is prevented. | m1 | bug | P2 | fixed |
| 5.5b | ✅ `deleteSoftLineForward` / `deleteHardLineForward` are not in `INPUT_ACTIONS`: prevented, then nothing happens. Add them with `deleteForward(tr, 'line')`. Both added (`deleteForward(tr, 'line')`, remote targets as the other deletes). | 5.5 | bug | P2 | fixed |
| 5.6 | ✅ Renderer: a throw mid-render leaves the id map inconsistent and still clears `invalidated`; `getPluginOptions` returns the live object; the initial render doesn't pass the node selection. A throwing render keeps what it built and keeps the pending work for the next render. `getPluginOptions` was already a frozen copy (stale). The initial render passes the node selection. | m1, m2 | bug | P2 | fixed |
| 5.7 | ✅ dom-selection: the no-op write can leave the selection in a stray node; non-editable positions ignore the offset. A collapsed caret outside every leaf (static text, a block position) is moved into its leaf; positions in non-editable content use the offset (`pastMiddle`). | m1 | bug | P2 | fixed |
| 5.8 | ✅ `skipLeaf`: anchor/before order not checked; text duplicated without `skipPath`; an ancestor move can detach the composing leaf; docs overstate "never moved". Order checked; the composing leaf's holder stays put on reorders and shell rebuilds around it wait for the next render. Without `skipPath`: by design (documented); the "never moved" docs list when it can move. | m1 | bug | P2 | fixed |
| 5.9 | ✅ EditorView: the old root stays `contenteditable` after `mount(other)`; `attach`/`listen` leak after `destroy`; remounting rebuilds the DOM. Destroy restores the root's attributes; `attach`/`listen` after destroy are no-ops. Remounting renders from scratch (documented: the old view's node views are gone). | m1 | bug | P2 | fixed |
| 5.10 | ✅ `data-editor-ignore` is honoured anywhere under the root; scope it to node-view containers. Honoured only inside a node view's own DOM, outside its `contentDOM`. | m2 | bug | P2 | fixed |
| 5.11 | ✅ Decorations: a throwing `decorations` hook propagates out of update/mount; invalid attribute names are caught mid-render (validate in `groupDecorations`); duplicate keys rebuild the leaf each render; decoration attrs not checked by `leafIntact`; widget at offset 0 caret side. A throwing hook is skipped and logged; bad attribute names are dropped in `groupDecorations` with a warning; duplicate keys no longer rebuild; `leafIntact` checks decoration attrs. Widget caret side: see 5.11b. | m3 | bug | P2 | fixed |
| 5.11b | A widget at offset 0: which side of it the caret shows on. Needs a real browser to check. | 5.11 | bug | P3 | open |
| 5.12 | ✅ Node views: `isDev()` treats a missing `process` as dev; a missing `contentDOM` is never detected; `NodeContent` is silent outside a non-atom view; the placement warning is not dev-gated; a stale-caret record can be invalidated by a re-render while detached. Warnings follow `editor.dev` (now public, readonly); an unplaced `contentDOM` is reported by the core; `NodeContent` misuse warns; the placement warning is dev-only. The stale-caret case does not reproduce (documented, tests kept). | m3 | bug | P2 | fixed |
| 5.13 | ✅ `coordsAt`: the leaf-rect fallback bottom is the whole leaf's bottom; a zero-height rect is accepted; zero rects before `NodeContent` mounts. Zero-height rects are skipped; the fallback is the line box, not the whole leaf; null when nothing measured has a height. Before `NodeContent` mounts: already null (stale; now tested). | m3 | bug | P2 | fixed |
| 5.14 | ✅ Selection: a caret parked at (block element, n) is no longer rewritten by the leaf rewrite. Same cause as 5.7: a caret at a block position is rewritten into the leaf. | m3 | bug | P2 | fixed |
| 5.15 | ✅ ZW handling: a literal U+200B in source and a duplicated ZW constant/attribute; `leafDomText` strips a real U+200B. One shared module (`view/zero-width.ts`, escaped constant); only the placeholder is stripped, a real U+200B stays. | m3 | bug | P2 | fixed |
| 5.16 | ✅ Node-view options are looked up by node type, not plugin name. Stale: a node type is always its plugin's name (`extend` keeps it). Hardened anyway (options, storage and state resolved through the registry), tested. | m2 | bug | P3 | stale |
| 5.17 | ✅ `EditorView.hasFocus` is public but `@internal`; hide it behind an internal interface. Removed from `EditorView`: internal `hasEditorFocus(view)`. | m4 | api | P3 | fixed |
| 5.18 | ✅ The WebKit delete fallback is cancelled by any dispatch between keydown and the timer. Cancelled only by a selection change or a change to a block holding the selection; unrelated dispatches (timers, uploads elsewhere) keep it. | m4, ms | bug | P3 | fixed |
| 5.19 | ✅ Docs: `handleDOMEvent` and `transformPasted` as view-integration API; `ignoreMutation` returning false can loop with async rendering; `stopEvent` should point to `data-editor-ignore`; `NodeViewHost.update` comment is wrong; mutation.ts JSDoc is garbled; same-key widget keeps its element; word-Backspace removes an atom. View integration docs: editor methods behind the view, the `ignoreMutation` loop, `stopEvent` → `data-editor-ignore`, same-key widgets; `NodeViewHost.update` and mutation.ts JSDoc rewritten; word-Backspace comment. | m1, m2, m3 | doc | P3 | documented |
| 5.20 | ✅ Export `WIDGET_ATTR` / `DECO_ATTR`. Exported from the core index, documented. | m3 | api | P3 | fixed |
| 5.21 | ✅ Tests: arrow keys and modifiers; mount on a destroyed editor; caret at a widget; typing into a ZW leaf, IME before ZW, ZW to `<br>` after the last chip is removed; composition across `invalidateNodeView`. All added; they pass (no bug found). | m1, m3 | test | P3 | tested |

## Batch 6: Input rules and plugins
| # | Item | Src | Kind | Pri | Status |
|---|---|---|---|---|---|
| 6.1 | ✅ Image: a failed upload after the user changed the original's `src` lets undo restore the dead `blob:` src; failing the last block's image leaves a trailing empty paragraph. | m2 | bug | P1 | fixed |
| 6.2 | ✅ Image: a drop ignores the drop point while a node is selected, so the file can replace the selected image. | m2 | bug | P1 | fixed |
| 6.3 | ✅ Image: blob URLs are revoked only on `destroy`; a copy pasted into another editor keeps the blob URL; a pending blob src set via `setNodeData` is not tracked; pending state is briefly only the main id with several copies; an image-file paste with a non-main targeted range goes to every range. A preview is revoked once its upload settled and neither the doc nor history holds it; a pasted `blob:` image this editor does not own (or whose upload failed) is dropped, an uploaded one gets its URL; `setNodeData` copies are tracked; every copy is pending from the insert tr; a targeted file paste goes to its range only. | m2, ms | bug | P2 | fixed |
| 6.4 | ✅ Image: width parsing accepts unsafe integers; resize handle has no `lostpointercapture` fallback and no role/label. `width` kept only as a positive safe integer (the image is kept otherwise); `lostpointercapture` ends the drag; the handle has `role="separator"` and a label. | m2 | bug | P2 | fixed |
| 6.5 | ✅ Mention: popup coords don't follow scroll or resize; no `aria-activedescendant` / option ids. | m3 | bug | P1 | fixed |
| 6.6 | ✅ Mention: hopping between triggers with the same query clears `dismissedAt`; the cache is written during render; `useMention` re-renders every chip while the popup is open; `insertAtTriggers` fakes an `EditorState`. Dismissals are keyed by trigger position (`MentionState.dismissed`, was `dismissedAt`: API break in the plugin); users are recorded before the results tr, read via `MentionStorage.user(id)`; chips subscribe to their own user; `insertAtTriggers` builds a real state. | m3, ms | bug | P2 | fixed |
| 6.7 | ✅ Code block: nested blocks lose newlines when pasted in (`plainText` joins with `""`); a vetoed line-break tr falls through to core `splitBlock`. | m3 | bug | P1 | fixed |
| 6.8 | ✅ Code block: the `decorations` hook walks the whole doc on every view update. Highlight tokens cached per subtree (WeakMap by node): only changed nodes are walked. | m3 | perf | P2 | fixed |
| 6.9 | ✅ Code block: `onBeforeInput` `insertParagraph` overlaps with the mention popup (registration order decides); Tab with a selection ending at a line start next to another indented range maps over the indent; hard-coded `aria-label` "Language"; `useCodeBlock` is not memoized. Mention priority 160 claims Enter ahead of the code block while its popup is open (both registration orders tested); the Tab range end stays before another range's indent; `languageLabel` option; `useCodeBlock` memoized. | m3, ms | bug | P3 | fixed |
| 6.9b | `toggleBold` / `setBold` / `unsetBold` / `setFontSize` / `unsetFontSize` returned true (and `can()` said yes) with no selection: `Transaction` mark methods return the tr. ✅ Fixed: they return false without a selection. | 9.4 | bug | P3 | fixed |
| 6.10 | ✅ Input rules: `findTrigger` false positive when the trigger text is the first child of a link; `runAt` vs `findTrigger` mismatch; a rule without `$` matches only the leftmost match; move `toBlockOffset` inside the try. One definition of the text before the caret (`textBeforeCaret`), used by input rules and by `findTrigger` with `registry` (mention passes it); rules match anchored at the caret, with or without `$`. `toBlockOffset` was already inside the try (stale). | m3 | bug | P2 | fixed |
| 6.11 | ✅ Plugin docs: mention zero-results Enter comment (`mention/src/index.ts` ~411); caret after a plain `@foo` opens the popup; `renderUser` reading an external store is not subscribed; multi-char triggers are loosely supported. Zero-results Enter comment fixed; `renderUser` note on its option; multi-char trigger limits documented and tested; the plain `@foo` behaviour was already documented. | m3 | doc | P3 | documented |
| 6.12 | ✅ Plugin tests: `safeSrc` unit test; mousedown on the resize handle or input doesn't node-select; resize `afterEach` asserts before cleanup; resize e2e locates via `img`; mention tests assert no `console.error`; code-block tests 4 and 7 unasserted spies; `setLanguage` rejected path; multi-line code paste into a paragraph (e2e); newline paste outside a code block from a non-code source; mention popup coordinates; input rules: next char after a rule, Vietnamese/NFD query, composition triggers no rule. Added (view-side `safeSrc`, controls do not node-select, cleanup before asserting, no `console.error` in mention tests, spies asserted, `setLanguage` rejected, newline pastes, Vietnamese/NFD query, rule-then-typing); composition was already covered; e2e: multi-line code paste, popup position, scoped image locators. | m2, m3, ms | test | P3 | tested |

## Batch 7: React adapter
| # | Item | Src | Kind | Pri | Status |
|---|---|---|---|---|---|
| 7.1 | ✅ `onUpdate` can be missed for dispatches during the first commit. The update listener attaches in the `useState` initializer (StrictMode-safe); `onUpdate` sees dispatches from child layout effects and `onMount`. From `onCreate`: see 7.1b. | m1 | bug | P2 | fixed |
| 7.1b | ✅ Dispatches from `onCreate` run inside the `Editor` constructor, before `useEditor` can listen, so `onUpdate` never sees them. Needs a core hook (a listener in `EditorOptions`, registered before `onCreate`). Documented on `onUpdate`. `EditorOptions.listeners` (registered before `onCreate`); `useEditor` passes `onUpdate` through it. | 7.1 | bug | P3 | fixed |
| 7.2 | ✅ Node views get one commit with stale options after a `pluginOptions` change. Node views render with the new options in the same commit (`PortalStore.pendingOptions`). | m2 | bug | P2 | fixed |
| 7.3 | ✅ StrictMode builds a throwaway editor in the `useState` initializer. `useEditor` creates the editor lazily in a ref: one per mount, StrictMode included (a render React discards before committing can still build one: documented). | m2 | perf | P3 | fixed |
| 7.4 | ✅ Passing an explicit `T` to `useEditorState` loses the editor type; `resolveParts` always returns `\| null`; `PartsOverride` has no excess-key check for spread variables; `usePluginState` is not tied to the editor's plugins. `resolveParts` infers its overrides (`ResolvedParts`); `usePluginState` is typed against the editor's plugins. An explicit `T` in `useEditorState` and spread extra keys in `PartsOverride` are TypeScript limits: documented, pinned by type tests. | m1, m3 | api | P3 | fixed |
| 7.5 | ✅ Docs: `props.state` is stale without `usePluginState`; nested dispatch, hook-vs-event order and StrictMode mount counts not verified against code. Hook and event order, nested dispatch and StrictMode notes corrected and pinned by tests (`docs-claims.test.ts`); `props.state` staleness documented. | m3 | doc | P3 | documented |
| 7.6 | ✅ Tests: StrictMode for selector tests; dispatch from a node view's `useEffect`; `EditorContent` receiving a different editor; `parts` positive/negative type tests; `{ Img: undefined }` fallback; `usePluginState` ZW/atom/decorated/stateless cases. All added. | m1, m2, m3 | test | P3 | tested |

## Batch 8: Performance
| # | Item | Src | Kind | Pri | Status |
|---|---|---|---|---|---|
| 8.1 | ✅ `getJSON()` deep-clones on every call: O(doc) per keystroke for autosave. Still a mutable copy (the contract is tested and typed), now a plain JSON walk: 5000 blocks ~42 ms → ~3.7 ms. Autosave can `JSON.stringify(editor.state.doc)` with no copy (README, JSDoc). A frozen, structurally shared snapshot (O(change)) would break the contract: left for the API review. | m1 | perf | P2 | fixed |
| 8.2 | ✅ Backspace segments the whole block (O(n)). Segments a 256-character window on each side of the caret, falling back to the whole text when a cluster or word reaches the window edge (results identical; property test). 50k-character block: ~10 ms → ~0.14 ms per Backspace. | m1 | perf | P2 | fixed |
| 8.3 | ✅ `docIds` recomputed per insert (O(ranges × doc) per paste); a multi-range paste parses the clipboard once per range. Ids kept per transaction and updated from its ops; the json/html flavor is parsed once for a multi-range paste. 3 blocks at 100 carets in 2000 blocks: ~330 ms → ~62 ms. | ms | perf | P2 | fixed |
| 8.4 | ✅ Renderer lookups are linear; `boundaryPoint` is O(leaves); `nearestEditablePoint` is O(doc); `placedContentDOMs` runs `querySelectorAll` per added element; `renderHTML` builds a frozen options copy per call. Hot paths fixed: unchanged subtrees are kept by the renderer (full check after outside DOM changes), `boundaryPoint` bisects. Chromium, 2000 blocks: keystroke ~28 → ~15 ms, a boundary read ~55 → ~22 ms. The rest is off the hot path now (`renderHTML` runs only on shell rebuilds; `nearestEditablePoint` on re-homing; `placedContentDOMs` for node views). | m1, m2, m3 | perf | P3 | fixed |

## Batch 9: Tooling and small cleanups
| # | Item | Src | Kind | Pri | Status |
|---|---|---|---|---|---|
| 9.1 | ✅ `reuseExistingServer` should be `!process.env.CI`; clearer failure or configurable port when the e2e port is taken. Port from `E2E_PORT` (default 5174, invalid values throw); server reuse is opt-in (`E2E_REUSE_SERVER=1`, never on CI) rather than `!CI`, since worktrees share the port. | m1, m3 | tool | P3 | fixed |
| 9.2 | ✅ Plain `pnpm --filter playground e2e` runs Firefox, which fails here; decide whether the default script should be Chromium + WebKit. Decided 2026-11-09: Firefox dropped from the e2e suite (config and script); the default `e2e` runs Chromium and WebKit. Firefox stays a product target, checked by hand before a release. | m4 | tool | P3 | fixed |
| 9.3 | ✅ Duplicate `samePath` helpers; `image.test.ts` prettier nit; `mergeAttrs` JSDoc splice. One `pathEquals` in model/path (selection, marks, text use it); `mergeAttrs` JSDoc rewritten; `image.test.ts` nit fixed. Left: `pathEq` in ops/rebase.ts, `samePath` in view/{dom-selection,renderer,view}.ts. | m2, m3 | doc | P3 | fixed |
| 9.4 | ✅ Playground: `fakeUpload` never revokes its URLs and sets no `onUploadError`; the Bold button is disabled with no selection or focus. `fakeUpload` URLs revoked on destroy, `onUploadError` set. The Bold button: stale (enabled whenever a selection exists, focus not needed; pinned by a test). | m2, m4 | bug | P3 | fixed |
| 9.5 | ✅ Docs: `createTestEditor` re-ids content and swaps the global id generator; normalize rule 10 changes `getJSON()` output (empty text siblings around inline elements): changelog note. `createTestEditor` JSDoc; new root `CHANGELOG.md` (linked from the README). | m1, m3 | doc | P3 | documented |
| 9.6 | ✅ The undo e2e depends on history grouping; font-size e2e selects via the editor API instead of the mouse; e2e for undo during a pending upload. Undo e2e sets a long `groupDelay`; font-size e2e selects with Shift+Arrow and a click; new e2e: undo while an upload is pending, redo after it settles. | m1, m2 | test | P3 | fixed |

---

## Closed as noted (no action in v1)
- **Needs another machine:** Firefox is not in the e2e suite (9.2) and is unverified (it cannot launch here): check it by hand before a release; real Safari/macOS untested, including `insertFromComposition` and keyboard clipboard; real OS IME typing (Vietnamese Telex, Japanese) not checked by a human. Keep as a release checklist item.
- **Port 5174 held by `wslrelay.exe`:** environment, handled by the CLAUDE.md workaround.
- **Decisions, not defects:** whether the level 3–4 APIs (`parts`, hooks) leave `@experimental`; no generic cross-plugin hook interception; no internal drag-move; "distribute" paste of N lines into N carets belongs to the code view; no UI for secondary ranges yet (a feature, tracked separately as "multi-cursor UI").
- **Rulings already recorded:** part keys are camelCase; the docs-examples type test lives in the image package; `bindCommands` returns false on a dropped tr; secondary view roots carry `data-hte-<plugin>-<view>`.
- **Documented contracts, no change wanted:** image hooks read state by the plugin name `image`; `useImageResize` measures the first `<img>`; clamp max is the container's `clientWidth`; the portal handle fallback is a heuristic; `rewriteHistoryData` overwrites a user-set `src` (documented); no `hljs` class on `<code>` (documented); any caller can set `meta.origin = history` (hardened in M4); a composed undo+insert command folds into the stacks (documented); the rule-11 perf bound is machine-dependent; attribute output order changed; `pnpm vitest` needs `pnpm install --offline` (in CLAUDE.md); performance note "100 carets ≈ 9 ms" is within target.
- **Test-file nits:** the `Label` type and the `commands` cast in mention tests.

## Suggested order
1. P1 items, area by area: Batches 2, 3, 4, 5, 6 (history grouping, paste shape, HTML skip list, caret churn, IME, plugin P1s).
2. Batch 1 (small, mostly confirmed, cheap wins).
3. P2 items of Batches 2–7.
4. Batch 8 (perf), with a benchmark before and after each change.
5. P3 docs, tests and tooling, in one sweep at the end.
