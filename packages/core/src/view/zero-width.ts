/**
 * The zero-width placeholder of the renderer: an empty text next to an element sibling (e.g. beside
 * an inline atom) shows one `ZW` instead of a break, so a caret can sit in it without adding a line
 * break, and its leaf carries `ZW_ATTR`. That one character is not model text; any other U+200B in
 * the leaf (e.g. typed by the user or an IME before the next render) is.
 */

/** Marks a leaf that shows the zero-width placeholder. */
export const ZW_ATTR = 'data-penline-zw'

/** The placeholder character: ZERO WIDTH SPACE (U+200B). */
export const ZW = '\u200b'

/** Whether the leaf shows an empty text as the zero-width placeholder. */
export function isZwLeaf(leaf: Element): boolean {
  return leaf.hasAttribute(ZW_ATTR)
}

/**
 * Where the placeholder is in the DOM text of a leaf (`zw`: whether it is a zero-width leaf), or -1:
 * by convention its first `ZW` (all of them are the same character, so which one is dropped never
 * changes the text).
 */
export function placeholderIndex(domText: string, zw: boolean): number {
  return zw ? domText.indexOf(ZW) : -1
}

/** The model text of a leaf's DOM text: in a zero-width leaf, without its placeholder (genuine U+200B kept). */
export function stripPlaceholder(domText: string, zw: boolean): string {
  const i = placeholderIndex(domText, zw)
  return i < 0 ? domText : domText.slice(0, i) + domText.slice(i + 1)
}
