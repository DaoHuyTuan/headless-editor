export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
export type Data = Record<string, Json>

export interface Mark {
  type: string
  data: Data
}

export interface TextNode {
  text: string
  marks: Mark[]
}

export interface ElementNode {
  id: string
  type: string
  data: Data
  children?: Node[]
}

export type Node = ElementNode | TextNode

export interface Doc {
  type: 'doc'
  children: ElementNode[]
}

/** `T` with every property and array readonly, recursively (a compile-time guard only). */
export type DeepReadonly<T> = T extends (infer U)[]
  ? ReadonlyArray<DeepReadonly<U>>
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T

export type Path = number[]

export interface Point {
  path: Path
  offset: number
}

export interface Selection {
  anchor: Point
  focus: Point
  /**
   * Node selection: the opaque element (atom or unknown type) at this path is selected. `anchor`
   * and `focus` are then a collapsed caret at the nearest editable point before it (the end of the
   * previous editable text), or after it when there is none before. Absent for a text selection.
   */
  node?: Path
}

/** Ordered: start <= end. */
export interface Range {
  start: Point
  end: Point
}
