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
  TextNode,
} from './model/types'
export {
  deepEqualJson,
  getNode,
  getParent,
  isElement,
  isText,
  nodeEntries,
  sameMarkSet,
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
export { findPathById } from './model/find'
export type { Operation } from './ops/types'
export { applyOp } from './ops/apply'
export { invertOp } from './ops/invert'
export { transformPath, transformPoint, transformSelection } from './ops/transform'
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
  InputIntent,
  MarkDOM,
  MarkSpec,
  NodeSpec,
  NoOptions,
  OptionsOf,
  ParseRule,
  Plugin,
  PluginContext,
  PluginSpec,
  StateOf,
  StorageOf,
  StorageOfPlugin,
} from './plugin/types'
export { definePlugin } from './plugin/define'
export { DEFAULT_PRIORITY, Registry } from './plugin/registry'
export type { RegisteredMark, RegisteredNode, ValidateResult } from './plugin/registry'
export type { EditorState } from './state'
export { Transaction } from './transaction/transaction'
export type { TransactionMeta } from './transaction/transaction'
export type { Fragment } from './transaction/fragment'
export { getFragment } from './transaction/fragment'
export { isMarkActive, marksAt } from './transaction/marks'
export type { MarkStateView } from './transaction/marks'
export { normalize } from './normalize'
export { coerceDoc } from './load'
export { parseHTML } from './html/parse'
export { serializeHTML } from './html/serialize'
export { Editor } from './editor'
export type {
  BoundCommands,
  EditorCommands,
  EditorEvent,
  EditorEventName,
  OptionsEvent,
  EditorOptions,
  EditorPlugins,
  EditorStorage,
} from './editor'
export { eventToKeyName, normalizeKeyName } from './keymap'
export type { Platform } from './keymap'
export { corePlugin } from './core-plugin'
export { historyPlugin } from './history'
export { Renderer } from './view/renderer'
export { domToModel, modelToDom, readDomSelection, writeDomSelection } from './view/dom-selection'
export { EditorView } from './view/view'
export { FRAGMENT_MIME, parseFromClipboard, serializeForClipboard } from './view/clipboard'
export type { CompositionTarget, InputRecord, ViewModule } from './view/view'
