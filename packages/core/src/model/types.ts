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

export type Path = number[]

export interface Point {
  path: Path
  offset: number
}

export interface Selection {
  anchor: Point
  focus: Point
}

/** Ordered: start <= end. */
export interface Range {
  start: Point
  end: Point
}
