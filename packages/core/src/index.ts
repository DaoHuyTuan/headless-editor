/**
 * `@penline/core`: the public API, covered by semver. Engine and view internals are in
 * `@penline/core/internal` (no semver guarantee).
 */
export type {
  Data,
  DeepReadonly,
  Doc,
  ElementNode,
  Json,
  Mark,
  Node,
  Path,
  Point,
  Range,
  Selection,
  SelectionRange,
  TextNode,
} from './model/types'
export {
  getNode,
  getParent,
  isElement,
  isText,
  nodeEntries,
  textEntries,
} from './model/node'
export {
  comparePath,
  comparePoint,
  isAncestorPath,
  isCollapsed,
  nextPath,
  parentPath,
  pointEquals,
  previousPath,
  toRange,
} from './model/path'
export { createId, setIdGenerator } from './model/id'
export { isNodeSelection, nodeSelection } from './model/editable'
export { createSelection, isNodeRange, mainRange, rangeEquals, selectionEquals, single } from './model/selection'
export { findPathById } from './model/find'
export type { Operation } from './ops/types'
export { transformPoint, transformSelection } from './ops/transform'
export type {
  AnyPlugin,
  AnyPluginSpec,
  Command,
  CommandFactory,
  CommandMap,
  CommandsOf,
  CommandsOfPlugin,
  DataOf,
  DOMEventName,
  DOMOutputSpec,
  ExtendedSpec,
  InputIntent,
  InputRule,
  MarkDOM,
  MarkSpec,
  NodeSpec,
  NodeViewFactory,
  NodeViewInstance,
  NodeViewProps,
  NodeViewPropsOf,
  NodeViewSpec,
  NoOptions,
  OptionsOf,
  ParseRule,
  PasteInfo,
  Plugin,
  PluginContext,
  PluginOverrides,
  PluginSpec,
  StateOf,
  StorageOf,
  StorageOfPlugin,
} from './plugin/types'
export type { RangeStep } from './transaction/ranges'
export { definePlugin } from './plugin/define'
export { mergeAttrs } from './plugin/attrs'
export { nodeText } from './content/text'
// Types the public API exposes (`tr.registry`, `nodeText`); creating a Registry is internal.
export type { OptionsLookup } from './content/text'
export type { Registry, RegisteredMark, RegisteredNode, ValidateResult } from './plugin/registry'
export type { Attrs, HTMLAttributes } from './plugin/attrs'
export type { EditorState } from './state'
export { Transaction } from './transaction/transaction'
export type { TransactionMeta } from './transaction/transaction'
export type { Fragment } from './transaction/fragment'
export type { Slice } from './transaction/slice'
export { parseHTML } from './html/parse'
export { Editor } from './editor'
export type {
  BoundCommands,
  EditorCommands,
  EditorEvent,
  EditorEventName,
  OptionsEvent,
  EditorListeners,
  EditorOptions,
  EditorPlugins,
  EditorStorage,
} from './editor'
export type { Platform } from './keymap'
export { findTrigger } from './suggestion'
export type { FindTriggerOptions, TriggerMatch } from './suggestion'
export { clearHistory, rewriteHistoryData } from './history'
export type { Decoration, DecorationAttrs, InlineDecoration, WidgetDecoration } from './view/decorations'
export { DECO_ATTR, WIDGET_ATTR } from './view/decorations'
export { IGNORE_ATTR } from './view/ignore'
