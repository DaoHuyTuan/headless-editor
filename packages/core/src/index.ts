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
