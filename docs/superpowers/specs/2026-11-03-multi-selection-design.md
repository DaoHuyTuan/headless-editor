# Multi-selection: design

Status: draft, 2026-11-03. Parent docs:
- the spec: `docs/superpowers/specs/2026-10-27-headless-editor-design.md`;
- the architecture: `docs/architecture.md` (§3, and §4a "Decision: multi-selection lives in the model").

## 1. Intent

The editor gets **multiple selection ranges in the core model**, the way VS Code and CodeMirror have multiple cursors. Typing `x` with two carets inserts `x` at both, in one undo step.

**Why now:** the main future consumer is a code view (`docs/architecture.md` §3). Multi-cursor is a core feature of a code editor, and model-level selection is an API-breaking change. No plugin outside this repo depends on the current single-range `Selection` yet, so changing it now is the cheapest it will ever be.

**For whom:** plugin authors and the future code view. End users of the document view see no change in this milestone.

## 2. Goals, non-goals, anti-goals

### Goals
1. **Selection shape.** `Selection` holds one or more ranges, and one of them is the main range. This replaces the current single-range shape completely, with no compatibility layer.
2. **Core editing works on every range, in one transaction and one undo step:**
   - typing (including input rules);
   - Backspace/Delete, by character and by word;
   - Enter (`splitBlock`);
   - toggling, adding and removing marks;
   - stored marks;
   - paste and drop of text, HTML and fragments;
   - inserting inline and block nodes.
3. **Every built-in plugin supports multiple ranges:** paragraph, bold, font-size, image, mention and code-block. Their commands act on every range.
4. **History** records and restores every range. The M4 history rebase maps every range through operations made outside history.
5. **Selection mapping:** each range is mapped through ops (`transformSelection` works per range). After each change, overlapping or touching ranges are merged.
6. **The view.** The document view shows the main range as the native browser selection. It keeps the other ranges in the model, never drops them by itself, and offers an extension point so a later step can draw them.
7. **Presence-ready.** The `Selection` type and its mapping function have no "this is my selection" assumptions, so a future collaboration presence plugin can use the same type for remote users' cursors.

### Non-goals (this milestone)
- Any UI that creates multiple ranges: Alt+Click, Ctrl+D, Ctrl+Alt+Down and column selection. Multiple ranges are created only through the API, `tr.setSelection(...)`.
- Drawing secondary carets or highlights in the document view.
- Collaboration and remote presence.
- The code view.

### Anti-goals (a failure even if everything compiles)
- A secondary range silently ignored by a command or plugin. If a command cannot honour every range, it must say so in its JSDoc and act on the main range on purpose. It must never do that by accident.
- Edits at several ranges ending up in more than one undo step.
- An edit at one range shifting another range to the wrong place.
- Any change of behaviour for the single-range case, which is every user today.

## 3. Constraints

- All existing constraints hold:
  - the core is framework-free;
  - document changes go through invertible ops;
  - `data` is JSON;
  - `filterTransaction` never vetoes history;
  - commit trailers.
- The single-range behaviour must stay identical. The existing ~1,017 unit tests, the type tests, and the Chromium (85) and WebKit (65) e2e suites must pass, adjusted only for the new type shape.
- IME composition still targets only the main range. The browser composes at one place, so a composition with secondary ranges first collapses the selection to the main range. This is the same as VS Code/CodeMirror. The anti-goal above does not apply here, because the collapse is explicit.

## 4. Approaches considered

1. **Replace `Selection` with a list of ranges (chosen).**
   - Shape: `{ ranges: SelectionRange[]; main: number }`, with no top-level `anchor`/`focus`.
   - One source of truth. Every user of the selection is updated in this milestone, including all built-in plugins.
   - Breaking for plugins outside the repo, of which there are none.
2. **Keep `Selection` and add secondary ranges** (`extra?: Range[]`).
   - Rejected. It creates two sources of truth, and secondary ranges become easy to forget, which is exactly the anti-goal.
3. **A new type with a compatibility accessor for the main range** (`selection.main` returning the old shape).
   - Rejected by the human partner in favour of a full, explicit migration with no compatibility path.

The human partner chose approach 1.

## 5. Decided design

### 5.1 Types (`packages/core/src/model/types.ts`)

```ts
/** One range: what `Selection` is today. */
interface SelectionRange {
  anchor: Point
  focus: Point
  /** Node selection of the opaque element at this path (see today's `Selection.node`). */
  node?: Path
}

interface Selection {
  /** Never empty. Sorted by document position, non-overlapping (see 5.3). */
  ranges: SelectionRange[]
  /** Index into `ranges` of the main range (primary caret; the one the view shows natively). */
  main: number
}
```

- The `set_selection` op keeps `selection: Selection | null` and `prevSelection`, now with the new shape.
- `InputIntent.range` stays a single `SelectionRange | null`. Intents come from the browser, which edits at one place.

**[my call] Node selections.** A selection with a node range has exactly one range. Selecting two images at once is out of scope, because no use case needs it and it would complicate deletion and paste. Normalizing a selection drops the other ranges when it contains a node range, keeping the node range.

### 5.2 Helpers (core)

- **Constructors:**
  - `Selection.single(range)`: one range;
  - `Selection.create(ranges, main)`: normalizes the ranges (sort, merge) and adjusts `main`.
  - Existing helpers are updated to return the new shape: `caret(point)`, `nodeSelection(path)`, and the testing helpers in `packages/core/src/testing`.
- **Mapping:** `transformSelection(sel, op)` maps every range and then re-normalizes. It is used by history, by the M4 rebase, and by the mention `dismissedAt` mapping.
- **Applying a command at every range** (the CodeMirror `changeByRange` idea):
  ```ts
  forEachRange(tr, (range, tr) => SelectionRange /* the range after this step */): void
  ```
  - It runs the callback once per range, in document order, on the **same** `tr`.
  - Before each call, it maps the range through the ops added so far.
  - When all calls are done, it sets the selection to the collected results, normalized, with `main` preserved.
  - Core commands and plugin commands use it, and no command does its own offset bookkeeping.

**[my call] The public `tr` editing methods act on every range by default.** This covers `insertText`, `deleteBackward`/`deleteForward`, `deleteRange`, `toggleMark`/`addMark`/`removeMark`, `splitBlock`, `insertFragment`, `insertBlockNode` and `insertInlineNode`.
- Called with no explicit range, each method runs over every range itself, internally through `forEachRange`. So a plugin that calls `tr.toggleMark('bold')` is multi-range-correct without any change. This is what keeps "a silently ignored range" from happening.
- Called with an **explicit** range or point, a method acts only there and maps the other ranges through its ops. It does not collapse them.
- Inside a `forEachRange` callback, methods must be given the callback's range explicitly. A no-range call inside a callback throws in dev mode, because the edit would otherwise run twice.

`forEachRange` is the lower-level tool, meant for commands with custom per-range logic, such as code-block Tab, mention accept and image insert.

**Stored marks.** Moving the selection inside `forEachRange`, or through a multi-range method, does **not** clear the stored marks. The marks are cleared once, at the end, by the same rule as today: only when the selection really moved for a reason other than this edit.

**[my call] Mapping a range that no longer exists, during live edits.** `transformSelection` maps each range **on its own**:
- A range whose point falls in removed content is moved to the nearest editable point, by the same rule `rehomeSelection` uses today. It is dropped only if no editable point exists.
- The whole selection becomes `null` only when **every** range is gone.
- Duplicates created by moving a range are merged by normalization (§5.3).
- The normalize code that cleans up empty texts (`normalize.ts`) is updated to map every range.

The rebase rule in §5.7 is unchanged: drop the history entry if any range fails. That rule is stricter because history must restore exact states.

### 5.3 Normalization of a selection
- Ranges are sorted by document position.
- Ranges that overlap, **or touch**, are merged. Two carets at the same point become one. A caret inside another range is absorbed.
- After a merge, `main` points at the merged range that contains the old main.
- A selection is normalized after every transaction, in the same place where the current selection is validated.

### 5.4 Core commands with several ranges

[my calls, following VS Code and CodeMirror unless noted]

| Command | Behaviour with N ranges |
|---|---|
| Insert text / typing | Replace each range's text; each caret ends after its insert. |
| Input rules | **[my call]** The undo shape stays as it is today: typing at all carets is one step, then the rules are one combined `inputRule` step that undoes the rule and keeps the typed text. Each caret is checked **on its own**: at each caret the first matching rule wins and ends that caret's run, and other carets still run their own rules. All firings share one rule tr, and each handler gets its own `range` mapped through the earlier firings. Handlers must not set the selection on that shared tr (documented; in dev mode, a `setSelection` in a rule handler throws when there is more than one range). With one caret this behaves exactly as today. |
| Backspace/Delete, character and word | Per range; empty ranges delete one unit at each caret. |
| Backspace/Delete next to an opaque block | **[my call]** With one range, unchanged: the first press node-selects and the second deletes. With several ranges, a caret next to an opaque block **does nothing** for that press and stays put; the other carets delete normally. Turning it into a node selection would drop every other range (§5.1), and deleting the node right away would skip the confirmation step that single-caret users get. |
| A `beforeinput` intent with its own target range (autocorrect, spellcheck `insertReplacementText`, macOS double-space period) | **[my call]** Applied only at the intent's range, then the selection collapses to that one range. This is the same rule as IME (§3). The browser addressed one place, and replaying it at other carets would corrupt their text. Plain typing, where the intent range equals the main range, goes to every caret. |
| Enter (`splitBlock`) | Split at every caret; two carets in one block give three blocks. |
| Toggle mark | Mark state is computed over **all** ranges: if every range already has the mark, remove it everywhere; otherwise add it everywhere. Matches ProseMirror/Tiptap single-range semantics extended to the union. |
| `isActive` / `isMarkActive` | True only when every range has it. |
| Stored marks | One set for the whole selection, applied at every caret on the next insert. |
| Paste / drop | The same fragment is inserted at every range. VS Code's rule "N lines into N cursors, one line each" is **not** adopted; it is a code-view feature to revisit there. A drop targets its drop point only and collapses the selection to one range. |
| Insert inline/block node (`insertContent`, `insertInlineNode`, `insertBlockNode`) | Insert at every range; each copy gets fresh ids. |
| Undo/redo | One step restores the full previous `Selection`, every range plus `main`. |
| Select all | Collapses to one range covering the doc. |

### 5.5 Plugins with several ranges [my calls]

- **paragraph, bold, font-size:** follow the core command table. Font-size with mixed sizes across ranges reports "mixed" (`''`), as it already does for a mixed single range.
- **code-block:**
  - **Tab/Shift-Tab:** indent or outdent per range. Ranges that cover several lines indent each line, and two ranges on the same line indent that line once.
  - **Enter, Shift-Enter and line-break intents:** per caret.
  - **Triple-Enter exit:** happens for a caret only when that caret is at the end of a block ending in `\n\n`; other carets just insert `\n`.
  - **`setCodeBlock` and `exitCodeBlock`:** apply to every distinct block that holds a range.
  - **`setLanguage`:** applies to every code block holding a range.
  - **The filter that vetoes marks in code blocks:** already op-based, so it works unchanged.
- **mention:**
  - **The suggestion popup follows the main caret only:** trigger detection, query and position all use it.
  - **Accepting a suggestion** inserts the mention at **every** caret whose text before it matches the same trigger plus query as the main caret, as VS Code applies a completion at all cursors that share the prefix. Carets that don't match are left untouched.
  - **Backspace/Delete next to a mention** deletes it whole at each caret, through the core delete.
- **image:**
  - **`insertImage` (src):** inserts at every range.
  - **Upload of a file with several ranges:** one upload. A preview node is inserted at every range, all pointing at the same blob URL. All of them are tracked as copies of the same upload, which the image plugin already supports for pasted copies. They are all finalized or all removed together.
  - **Node-view actions** (alt text, resize) act on that one node, as today.

### 5.6 View (document view)

- **Writing to the DOM:** `writeDomSelection` writes the **main** range only.
- **Reading from the DOM:** a `selectionchange` from the browser replaces the selection with a single range. That is how a user click behaves today, and is what VS Code does on a plain click. Secondary ranges therefore live only until the next user-driven selection change. This is the expected behaviour, not dropping ranges by accident.
- **A seam for drawing secondary ranges later:** expose the secondary ranges to `decorations` (they are in `state.selection`). The core ships no overlay in this milestone. One test proves that a plugin can draw them from `state.selection.ranges` using widget and inline decorations.
- **IME:** `compositionstart` collapses a multi-range selection to the main range first (§3).

### 5.7 History and rebase

- Entries store the full `selectionBefore` and `selectionAfter`.
- The M4 rebase maps every range. If **any** range cannot be mapped, the entry is dropped, as today when the single range fails.
- Normalization ops folded into neighbouring entries carry the full selection.

### 5.8 Migration

- **One explicit migration of every user of the selection**, about 35 files (core plus plugins), with no compatibility accessor (approach 1). Compiler errors list every site.
- Each site is classified, and the class is recorded in the code with a comment where it is not obvious:
  - (a) rewritten to act on every range through `forEachRange`;
  - (b) acts on the main range on purpose and says so (popup position, IME, DOM write);
  - (c) is selection-agnostic.
- Docs to update:
  - `docs/plugin-api.md`, the `Command` / `tr` sections;
  - `docs/plugin-authoring.md`;
  - `docs/architecture.md` §4a: mark it as implemented;
  - the README sample, if affected.

## 6. Testing

- **Unit tests** for:
  - selection normalization (sort, merge, touching, main preserved);
  - `transformSelection` per range;
  - `forEachRange` offset mapping, including inserts before later ranges and deletes spanning ranges;
  - every row of 5.4 and every plugin rule of 5.5, with two and three ranges;
  - history undo/redo of multi-range edits;
  - rebase with a multi-range entry.
- **Single-range regression:** the existing suites pass unchanged in behaviour.
- **A seeded fuzz test,** extending the M4 history fuzz: random multi-range edits, then undo-all and redo-all, which must restore exact docs and selections.
- **E2E:** only a smoke test. One test sets two carets through `window.editor` and types with real keys; text appears at both carets and Ctrl+Z restores. It runs on Chromium and WebKit.

## 7. Left to the builder

- Internal names, file placement and helper signatures beyond the shapes in §5.1–5.2.
- Implementation order and task breakdown, including whether the type change lands first behind compiler errors.
- How `forEachRange` handles a callback that rejects. A rejected op rejects the whole tr, as today.
- Performance tuning for many ranges. The target is that 100 carets typing stays interactive (under 16 ms per keystroke in unit timing). This is not a hard requirement for this milestone.

## 8. Calls I made (for review)

1. A node range is always the only range (§5.1).
2. Touching ranges merge (§5.3).
3. Toggling a mark across ranges: if every range has it, remove; otherwise add (§5.4).
4. Paste puts the same fragment at every range; VS Code's "split lines across cursors" is deferred to the code view (§5.4).
5. Mention: the popup follows the main caret; accepting applies at every caret with the same trigger and query (§5.5).
6. Image upload with several ranges: one upload, previews everywhere, finalized together (§5.5).
7. A user `selectionchange` collapses to a single range (§5.6).
8. IME collapses to the main range first (§3, §5.6).
9. Public `tr` editing methods act on every range when no range is given. With an explicit range they act only there. A no-range call inside `forEachRange` throws in dev mode. Stored marks survive per-range caret moves (§5.2).
10. A range that can't be mapped during live edits moves to the nearest editable point, and is dropped only if none exists. The selection is null only if every range is gone (§5.2).
11. Input rules keep today's two-step undo. They are checked independently per caret and share one rule tr (§5.4).
12. With several ranges, Backspace/Delete at a caret next to an opaque block does nothing for that caret (§5.4).
13. A `beforeinput` intent with its own target range applies only there and collapses to one range (§5.4).
