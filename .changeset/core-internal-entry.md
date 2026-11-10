---
'@penline/core': minor
---

Split the core's exports into a public API and `@penline/core/internal`.

`@penline/core` now exports only the public API (40 values), covered by semver. The engine and view internals moved to `@penline/core/internal`, which has no semver guarantee: `applyOp`, `invertOp`, `transformPath`, `transformSelectionStrict`, `coerceDoc`, `normalize`, `Registry` (as a value) and `DEFAULT_PRIORITY`, `corePlugin`, `historyPlugin`, `deepEqualJson`, `sameMarkSet`, `isMarkActive`, `marksAt`, `eventToKeyName`, `normalizeKeyName`, `FRAGMENT_MIME`, `parseFromClipboard`, `serializeForClipboard`, `getFragment`, `serializeHTML`, `Renderer`, `EditorView`, `domToModel`, `modelToDom`, `readDomSelection`, `writeDomSelection`, `isIgnoredTarget`, and the types `MarkStateView`, `CompositionTarget`, `InputRecord`, `ViewModule`.

To migrate, import those names from `@penline/core/internal`. Everyday code is unaffected: `editor.getHTML()`, `editor.mount()`, `editor.commands`, `editor.isActive()` and the clipboard handling keep working as before.
