import type { Page } from '@playwright/test'
import type { Doc, ElementNode, Node, Selection } from '@hte/core'

/** Opens the playground (at `path`, e.g. `/?uploadFail=1`) and waits for the dev `window.editor` to be mounted. */
export async function openPlayground(page: Page, path = '/'): Promise<void> {
  await page.goto(path)
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

/** Puts a collapsed caret at `path` / `offset` through the editor API and focuses the editor. */
export async function setCaret(page: Page, path: number[], offset: number): Promise<void> {
  await page.evaluate(
    ([path, offset]) => {
      const editor = window.editor
      const point = { path, offset }
      const tr = editor.createTransaction()
      tr.setSelection({ anchor: point, focus: point }).setMeta('addToHistory', false)
      editor.dispatch(tr)
      editor.view!.focus()
    },
    [path, offset] as const,
  )
}

/** Opens the playground and switches to `scenario`, waiting until its content is in the editor. */
export async function openScenario(page: Page, scenario: string, path = '/'): Promise<void> {
  await openPlayground(page, path)
  await page.getByTestId('scenario').selectOption(scenario)
  await page.waitForFunction((s) => (document.querySelector('[data-testid=scenario]') as HTMLSelectElement).value === s, scenario)
}

/** Collects page errors and console errors; assert the list is empty after the test. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  return errors
}

/** Drives an IME composition through CDP: each step updates the composition, then `commit` is inserted. */
export async function compose(page: Page, steps: string[], commit: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  for (const text of steps) {
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
  }
  await cdp.send('Input.insertText', { text: commit })
  await cdp.detach()
}
