export type {
  Data,
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
} from './plugin/types'
export { definePlugin } from './plugin/define'
export { DEFAULT_PRIORITY, Registry } from './plugin/registry'
export type { RegisteredMark, RegisteredNode, ValidateResult } from './plugin/registry'
export type { EditorState } from './state'
export { Transaction } from './transaction/transaction'
export type { TransactionMeta } from './transaction/transaction'
export type { Fragment } from './transaction/fragment'
export { normalize } from './normalize'
export { coerceDoc } from './load'
export { Editor } from './editor'
export type {
  BoundCommands,
  EditorCommands,
  EditorEvent,
  EditorEventName,
  EditorOptions,
  EditorPlugins,
  EditorView,
} from './editor'
export { eventToKeyName, normalizeKeyName } from './keymap'
export type { Platform } from './keymap'
export { corePlugin } from './core-plugin'
export { historyPlugin } from './history'
