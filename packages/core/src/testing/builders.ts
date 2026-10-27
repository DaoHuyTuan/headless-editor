import { createId } from '../model/id'
import type { Data, Doc, ElementNode, Mark, Node, Path, Selection, TextNode } from '../model/types'

export function doc(...blocks: ElementNode[]): Doc {
  return { type: 'doc', children: blocks }
}

function isNodeLike(v: unknown): v is Node {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o.text === 'string' || (typeof o.id === 'string' && typeof o.type === 'string')
}

export function el(type: string, ...rest: [Data, ...Node[]] | Node[]): ElementNode {
  let data: Data = {}
  let children: Node[] = rest as Node[]
  if (rest.length > 0 && !isNodeLike(rest[0])) {
    data = rest[0] as Data
    children = rest.slice(1) as Node[]
  }
  return { id: createId(), type, data, children }
}

export function txt(text: string, ...marks: (string | Mark)[]): TextNode {
  return { text, marks: marks.map((m) => (typeof m === 'string' ? { type: m, data: {} } : m)) }
}

export function sel(path: Path, offset: number, focusPath?: Path, focusOffset?: number): Selection {
  return {
    anchor: { path, offset },
    focus: { path: focusPath ?? path, offset: focusOffset ?? offset },
  }
}
