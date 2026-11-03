import type { Path, Point, Range, SelectionRange } from './types'

/** Document-order comparison. An ancestor and its descendant compare as 0. */
export function comparePath(a: Path, b: Path): -1 | 0 | 1 {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i]! < b[i]!) return -1
    if (a[i]! > b[i]!) return 1
  }
  return 0
}

/** True when `a` is a strict ancestor of `b`. */
export function isAncestorPath(a: Path, b: Path): boolean {
  return a.length < b.length && a.every((v, i) => v === b[i])
}

export function parentPath(p: Path): Path {
  if (p.length === 0) throw new Error('Root has no parent path')
  return p.slice(0, -1)
}

export function nextPath(p: Path): Path {
  if (p.length === 0) throw new Error('Root has no next path')
  return [...p.slice(0, -1), p[p.length - 1]! + 1]
}

export function previousPath(p: Path): Path {
  if (p.length === 0 || p[p.length - 1]! <= 0) throw new Error(`No previous path for [${p}]`)
  return [...p.slice(0, -1), p[p.length - 1]! - 1]
}

export function comparePoint(a: Point, b: Point): -1 | 0 | 1 {
  const c = comparePath(a.path, b.path)
  if (c !== 0) return c
  return a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0
}

export function pointEquals(a: Point, b: Point): boolean {
  return a.offset === b.offset && a.path.length === b.path.length && a.path.every((v, i) => v === b.path[i])
}

export function isCollapsed(sel: SelectionRange): boolean {
  return pointEquals(sel.anchor, sel.focus)
}

export function toRange(sel: SelectionRange): Range {
  return comparePoint(sel.anchor, sel.focus) <= 0
    ? { start: sel.anchor, end: sel.focus }
    : { start: sel.focus, end: sel.anchor }
}
