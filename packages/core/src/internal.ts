/**
 * `@penline/core/internal`: the engine and view internals behind the public API.
 *
 * **No semver guarantee.** Anything here can change or go in any release, minor and patch included.
 * It is for advanced integrations that need the machinery itself (collaboration on raw ops, a
 * custom view, tooling); everyday plugins and apps only need `@penline/core`. If you rely on
 * something here, open an issue: it may belong in the public API.
 */

// Ops: apply, invert and transform raw operations.
export { applyOp } from './ops/apply'
export { invertOp } from './ops/invert'
export { transformPath, transformSelectionStrict } from './ops/transform'

// Loading and normalization.
export { coerceDoc } from './load'
export { normalize } from './normalize'
export type { OptionsLookup } from './content/text'

// Plugin machinery.
export { DEFAULT_PRIORITY, Registry } from './plugin/registry'
export type { RegisteredMark, RegisteredNode, ValidateResult } from './plugin/registry'
// The compiled content automaton (`registry.contentMatch(type)`).
export type { ContentEdge, ContentMatch } from './schema/content-match'
export { corePlugin } from './core-plugin'
export { historyPlugin } from './history'

// Comparisons and marks.
export { deepEqualJson, sameMarkSet } from './model/node'
export { isMarkActive, marksAt } from './transaction/marks'
export type { MarkStateView } from './transaction/marks'

// Keys.
export { eventToKeyName, normalizeKeyName } from './keymap'

// Clipboard and HTML serialization (the editor's `getHTML()` and its clipboard handling use these).
export { FRAGMENT_MIME, parseFromClipboard, serializeForClipboard } from './content/clipboard'
export { getFragment } from './transaction/fragment'
export { serializeHTML } from './html/serialize'

// The DOM view (`editor.mount()` creates it).
export { Renderer } from './view/renderer'
export { domToModel, modelToDom, readDomSelection, writeDomSelection } from './view/dom-selection'
export { EditorView } from './view/view'
export type { CompositionTarget, InputRecord, ViewModule } from './view/view'
export { isIgnoredTarget } from './view/ignore'
