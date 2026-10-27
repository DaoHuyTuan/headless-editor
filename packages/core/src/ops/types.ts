import type { Data, ElementNode, Mark, Node, Path, Selection, TextNode } from '../model/types'

export type Operation =
  | { type: 'insert_text'; path: Path; offset: number; text: string }
  | { type: 'remove_text'; path: Path; offset: number; text: string }
  | { type: 'insert_node'; path: Path; node: Node }
  | { type: 'remove_node'; path: Path; node: Node }
  // text: splits at char `position`; element: splits at child index `position`.
  // `properties` = what the new right-hand node gets (text: { marks }; element: { id, type, data }).
  | { type: 'split_node'; path: Path; position: number; properties: Partial<ElementNode> | Partial<TextNode> }
  // merges node at `path` into its previous sibling; `position` = previous sibling's length before merge;
  // `properties` = the removed node's own properties (for inversion).
  | { type: 'merge_node'; path: Path; position: number; properties: Partial<ElementNode> | Partial<TextNode> }
  // `newPath` is a path in the tree *before* the move (Slate semantics).
  | { type: 'move_node'; path: Path; newPath: Path }
  | { type: 'set_node_data'; path: Path; data: Data; prevData: Data }
  | { type: 'add_mark'; path: Path; mark: Mark }
  | { type: 'remove_mark'; path: Path; mark: Mark }
  | { type: 'set_selection'; selection: Selection | null; prevSelection: Selection | null }
