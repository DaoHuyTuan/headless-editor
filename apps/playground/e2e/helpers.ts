import { expect, type Page } from '@playwright/test'
import type { Doc, ElementNode, Node, SelectionRange } from '@penline/core'

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

/** The main range of the model selection, or null without a selection. */
export function getSelection(page: Page): Promise<SelectionRange | null> {
  return page.evaluate(() => {
    const sel = window.editor.state.selection
    return sel && sel.ranges[sel.main]!
  })
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
    tr.setSelection({ ranges: [{ anchor: point, focus: point }], main: 0 }).setMeta('addToHistory', false)
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
      tr.setSelection({ ranges: [{ anchor: point, focus: point }], main: 0 }).setMeta('addToHistory', false)
      editor.dispatch(tr)
      editor.view!.focus()
    },
    [path, offset] as const,
  )
}

/** Opens the playground and switches to `scenario`, waiting until its content is in the editor. */
export async function openScenario(page: Page, scenario: string, path = '/'): Promise<void> {
  await openPlayground(page, path)
  await page.getByTestId(`story-${scenario}`).click()
  await expect(page.getByTestId(`story-${scenario}`)).toHaveAttribute('aria-current', 'page')
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

/**
 * Skip reason for keyboard copy/cut → paste tests on WebKit. Headless WebKit (Playwright's Windows
 * build) does not carry data written by a `copy`/`cut` handler (`clipboardData.setData` +
 * `preventDefault`) to the next keyboard paste, even on a bare page with no editor: the paste sees
 * `text/plain`, `text/uri-list`, `text/html`, every value empty. A native copy does round-trip.
 * Evidence: docs/superpowers/m4-cross-browser.md (B). The editor's handlers stay covered on WebKit by
 * `syntheticCopy` / `syntheticPaste` tests.
 */
export const WEBKIT_KEYBOARD_CLIPBOARD =
  'headless WebKit drops data set by a copy/cut handler before the next keyboard paste (see m4-cross-browser.md B)'

/**
 * Dispatches a synthetic `copy` or `cut` on the editor root with a fresh `DataTransfer`, kept on the
 * page for `syntheticPaste`. Returns whether the editor handled it (prevented the default) and the
 * flavors it set.
 */
export function syntheticCopy(page: Page, type: 'copy' | 'cut'): Promise<{ prevented: boolean; types: string[] }> {
  return page.evaluate((type) => {
    const dt = new DataTransfer()
    ;(window as unknown as { __penlineClipboard: DataTransfer }).__penlineClipboard = dt
    const e = new ClipboardEvent(type, { clipboardData: dt, bubbles: true, cancelable: true })
    window.editor.view!.root.dispatchEvent(e)
    return { prevented: e.defaultPrevented, types: [...dt.types] }
  }, type)
}

/**
 * Dispatches a synthetic `paste` on the editor root carrying the data the last `syntheticCopy` set.
 * `without` drops flavors first (e.g. the JSON flavor, to exercise the HTML fallback).
 */
export function syntheticPaste(page: Page, without: string[] = []): Promise<boolean> {
  return page.evaluate((without) => {
    const src = (window as unknown as { __penlineClipboard: DataTransfer }).__penlineClipboard
    const dt = new DataTransfer()
    for (const t of src.types) if (!without.includes(t)) dt.setData(t, src.getData(t))
    const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
    window.editor.view!.root.dispatchEvent(e)
    return e.defaultPrevented
  }, without)
}
