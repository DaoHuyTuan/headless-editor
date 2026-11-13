import { describe, expect, it } from 'vitest'
import * as core from '../src/index'
import * as internal from '../src/internal'

// The public surface of @penline/core is covered by semver: adding or removing a name here is a
// deliberate API change (and needs a changeset). Internals go to @penline/core/internal instead.
const PUBLIC = [
  'DECO_ATTR', 'Editor', 'IGNORE_ATTR', 'Transaction', 'WIDGET_ATTR', 'clearHistory', 'comparePath', 'comparePoint',
  'createId', 'createSelection', 'definePlugin', 'findPathById', 'findTrigger', 'getNode', 'getParent',
  'isAncestorPath', 'isCollapsed', 'isElement', 'isNodeRange', 'isNodeSelection', 'isText', 'mainRange', 'mergeAttrs',
  'nextPath', 'nodeEntries', 'nodeSelection', 'nodeText', 'parentPath', 'parseHTML', 'pointEquals', 'previousPath',
  'rangeEquals', 'rewriteHistoryData', 'selectionEquals', 'setIdGenerator', 'single', 'textEntries', 'toRange',
  'transformPoint', 'transformSelection',
]

const INTERNAL = [
  'DEFAULT_PRIORITY', 'EditorView', 'FRAGMENT_MIME', 'Registry', 'Renderer', 'applyOp', 'blockRange', 'canJoin', 'canLift',
  'canSetBlockType', 'canWrap', 'coerceDoc', 'corePlugin', 'deepEqualJson', 'domToModel', 'eventToKeyName', 'fits',
  'getFragment', 'historyPlugin', 'invertOp', 'isIgnoredTarget', 'isMarkActive', 'liftTarget', 'marksAt', 'matchChild',
  'modelToDom', 'normalize', 'normalizeKeyName', 'parseFromClipboard', 'parseSliceFromClipboard', 'readDomSelection',
  'sameMarkSet', 'serializeForClipboard', 'serializeHTML', 'transformPastedSlice', 'transformPath',
  'transformSelectionStrict', 'writeDomSelection',
]

describe('the public API of @penline/core', () => {
  it('exports exactly the public values', () => {
    expect(Object.keys(core).sort()).toEqual([...PUBLIC].sort())
  })

  it('keeps the internals in @penline/core/internal, not in the main entry', () => {
    expect(Object.keys(internal).sort()).toEqual([...INTERNAL].sort())
    for (const name of INTERNAL) expect(name in core).toBe(false)
  })
})
