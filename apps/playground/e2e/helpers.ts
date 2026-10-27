import type { Page } from '@playwright/test'
import type { Doc, ElementNode, Node, Selection } from '@hte/core'

/** Opens the playground and waits for the dev `window.editor` to be mounted. */
export async function openPlayground(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => !!window.editor?.view)
}

export function getDoc(page: Page): Promise<Doc> {
  return page.evaluate(() => window.editor.getJSON())
}

function textOf(node: Node): string {
  return 'text' in node ? node.text : (node.children ?? []).map(textOf).join('')
}

/** The text of each top-level block, joined by a newline. */
export async function getText(page: Page): Promise<string> {
  const doc = await getDoc(page)
  return doc.children.map(textOf).join('\n')
}

export function getSelection(page: Page): Promise<Selection | null> {
  return page.evaluate(() => window.editor.state.selection)
}

/** Focuses the editor with the caret at the end of the document (through the editor API, not clicks). */
export async function focusEnd(page: Page): Promise<void> {
  await page.evaluate(() => {
    const editor = window.editor
    const path: number[] = []
    let node: Node = editor.getJSON() as unknown as ElementNode
    while (!('text' in node) && node.children?.length) {
      path.push(node.children.length - 1)
      node = node.children[node.children.length - 1]!
    }
    const offset = 'text' in node ? node.text.length : 0
    const point = { path, offset }
    const tr = editor.createTransaction()
    tr.setSelection({ anchor: point, focus: point }).setMeta('addToHistory', false)
    editor.dispatch(tr)
    editor.view!.focus()
  })
}
