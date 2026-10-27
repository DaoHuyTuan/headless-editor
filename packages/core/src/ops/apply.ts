import { deepEqualJson, isElement, isText } from '../model/node'
import { isAncestorPath } from '../model/path'
import type { Doc, ElementNode, Node, Path, TextNode } from '../model/types'
import { movedPath } from './invert'
import type { Operation } from './types'

type Root = Doc | ElementNode

function fail(msg: string): never {
  throw new Error(msg)
}

function kids(n: Root): Node[] {
  return n.children ?? []
}

function nodeAt(root: Root, path: Path): Node {
  let cur: Node = root as Node
  for (const i of path) {
    const next: Node | undefined = isText(cur) ? undefined : kids(cur as Root)[i]
    if (!next) fail(`Invalid path [${path}]`)
    cur = next
  }
  return cur
}

function textAt(root: Root, path: Path): TextNode {
  const n = nodeAt(root, path)
  if (!isText(n)) fail(`Expected a text node at [${path}]`)
  return n
}

/** Replace the node at `path` with fn(node), copying only the nodes along the path. */
function replaceAt(root: Root, path: Path, fn: (n: Node) => Node): Root {
  if (path.length === 0) return fn(root as Node) as Root
  const [i, ...rest] = path as [number, ...number[]]
  const cs = kids(root)
  const child = cs[i]
  if (!child || (isText(child) && rest.length > 0)) fail(`Invalid path [${path}]`)
  const next = rest.length === 0 ? fn(child) : (replaceAt(child as ElementNode, rest, fn) as Node)
  const copy = cs.slice()
  copy[i] = next
  return { ...root, children: copy } as Root
}

function updateChildren(root: Root, parent: Path, fn: (cs: Node[]) => Node[]): Root {
  const p = parent.length === 0 ? (root as Node) : nodeAt(root, parent)
  if (isText(p)) fail(`Expected an element at [${parent}]`)
  return replaceAt(root, parent, (n) => ({ ...(n as ElementNode), children: fn(kids(n as ElementNode)) }))
}

function insertAt(root: Root, path: Path, node: Node): Root {
  if (path.length === 0) fail('Invalid path []')
  const index = path[path.length - 1]!
  return updateChildren(root, path.slice(0, -1), (cs) => {
    if (!Number.isInteger(index) || index < 0 || index > cs.length) fail(`Invalid path [${path}]`)
    return [...cs.slice(0, index), node, ...cs.slice(index)]
  })
}

function removeAt(root: Root, path: Path): Root {
  if (path.length === 0) fail('Invalid path []')
  nodeAt(root, path)
  const index = path[path.length - 1]!
  return updateChildren(root, path.slice(0, -1), (cs) => [...cs.slice(0, index), ...cs.slice(index + 1)])
}

export function applyOp(doc: Doc, op: Operation): Doc {
  return apply(doc, op) as Doc
}

function apply(root: Root, op: Operation): Root {
  switch (op.type) {
    case 'insert_text': {
      const t = textAt(root, op.path)
      if (!Number.isInteger(op.offset) || op.offset < 0 || op.offset > t.text.length)
        fail(`Offset ${op.offset} out of range at [${op.path}]`)
      return replaceAt(root, op.path, () => ({
        ...t,
        text: t.text.slice(0, op.offset) + op.text + t.text.slice(op.offset),
      }))
    }
    case 'remove_text': {
      const t = textAt(root, op.path)
      const end = op.offset + op.text.length
      if (!Number.isInteger(op.offset) || op.offset < 0 || end > t.text.length)
        fail(`Offset ${op.offset} out of range at [${op.path}]`)
      if (t.text.slice(op.offset, end) !== op.text)
        fail(`Text mismatch at [${op.path}]: expected "${op.text}", found "${t.text.slice(op.offset, end)}"`)
      return replaceAt(root, op.path, () => ({ ...t, text: t.text.slice(0, op.offset) + t.text.slice(end) }))
    }
    case 'insert_node':
      return insertAt(root, op.path, op.node)
    case 'remove_node':
      return removeAt(root, op.path)
    case 'split_node': {
      const n = nodeAt(root, op.path)
      const pos = op.position
      let left: Node
      let right: Node
      if (isText(n)) {
        if (!Number.isInteger(pos) || pos < 0 || pos > n.text.length)
          fail(`Split position ${pos} out of range at [${op.path}]`)
        const props = op.properties as Partial<TextNode>
        left = { ...n, text: n.text.slice(0, pos) }
        right = { text: n.text.slice(pos), marks: props.marks ?? n.marks }
      } else {
        const cs = kids(n as ElementNode)
        if (!Number.isInteger(pos) || pos < 0 || pos > cs.length)
          fail(`Split position ${pos} out of range at [${op.path}]`)
        const props = op.properties as Partial<ElementNode>
        left = { ...(n as ElementNode), children: cs.slice(0, pos) }
        right = {
          id: props.id ?? (n as ElementNode).id,
          type: props.type ?? (n as ElementNode).type,
          data: props.data ?? {},
          children: cs.slice(pos),
        }
      }
      const withLeft = replaceAt(root, op.path, () => left)
      return insertAt(withLeft, [...op.path.slice(0, -1), op.path[op.path.length - 1]! + 1], right)
    }
    case 'merge_node': {
      const n = nodeAt(root, op.path)
      const idx = op.path[op.path.length - 1]!
      if (idx < 1) fail(`No previous sibling to merge [${op.path}] into`)
      const prevPath = [...op.path.slice(0, -1), idx - 1]
      const prev = nodeAt(root, prevPath)
      let merged: Node
      if (isText(n) && isText(prev)) merged = { ...prev, text: prev.text + n.text }
      else if (isElement(n) && isElement(prev)) merged = { ...prev, children: [...kids(prev), ...kids(n)] }
      else return fail(`Cannot merge nodes of different kinds at [${op.path}]`)
      return removeAt(
        replaceAt(root, prevPath, () => merged),
        op.path,
      )
    }
    case 'move_node': {
      if (op.path.length === 0) fail('Invalid path []')
      const n = nodeAt(root, op.path)
      if (isAncestorPath(op.path, op.newPath)) fail(`Cannot move [${op.path}] into its own descendant [${op.newPath}]`)
      return insertAt(removeAt(root, op.path), movedPath(op.path, op.newPath), n)
    }
    case 'set_node_data': {
      const n = nodeAt(root, op.path)
      if (!isElement(n)) fail(`Expected an element at [${op.path}]`)
      return replaceAt(root, op.path, () => ({ ...(n as ElementNode), data: op.data }))
    }
    case 'add_mark': {
      const t = textAt(root, op.path)
      if (t.marks.some((m) => m.type === op.mark.type)) fail(`Mark "${op.mark.type}" already present at [${op.path}]`)
      return replaceAt(root, op.path, () => ({ ...t, marks: [...t.marks, op.mark] }))
    }
    case 'remove_mark': {
      const t = textAt(root, op.path)
      const i = t.marks.findIndex((m) => m.type === op.mark.type && deepEqualJson(m.data, op.mark.data))
      if (i < 0) fail(`Mark "${op.mark.type}" not present at [${op.path}]`)
      return replaceAt(root, op.path, () => ({ ...t, marks: [...t.marks.slice(0, i), ...t.marks.slice(i + 1)] }))
    }
    case 'set_selection':
      return root
  }
}
