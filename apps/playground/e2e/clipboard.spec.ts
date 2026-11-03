import { expect, test, type Page } from '@playwright/test'
import type { Doc, ElementNode, Node, TextNode } from '@hte/core'
import { focusEnd, getDoc, getSelection, getText, openPlayground } from './helpers'

test.beforeEach(async ({ page }) => {
  await openPlayground(page)
  await focusEnd(page)
})

function elementIds(doc: Doc): string[] {
  const out: string[] = []
  const walk = (n: Node) => {
    if ('text' in n) return
    out.push(n.id)
    n.children?.forEach(walk)
  }
  doc.children.forEach(walk)
  return out
}

/** Dispatches a synthetic `paste` whose DataTransfer holds `data` (MIME type → value) at the model caret. */
async function pasteData(page: Page, data: Record<string, string>): Promise<boolean> {
  return page.evaluate((entries) => {
    const dt = new DataTransfer()
    for (const [type, value] of Object.entries(entries)) dt.setData(type, value)
    const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
    window.editor.view!.root.dispatchEvent(e)
    return e.defaultPrevented
  }, data)
}

/** Selects a model range through the editor API and shows it in the DOM. */
async function select(page: Page, anchor: [number[], number], focus: [number[], number]): Promise<void> {
  await page.evaluate(
    ([a, f]) => {
      const editor = window.editor
      const tr = editor.createTransaction()
      tr.setSelection({ anchor: { path: a[0], offset: a[1] }, focus: { path: f[0], offset: f[1] } })
      tr.setMeta('addToHistory', false)
      editor.dispatch(tr)
      editor.view!.focus()
    },
    [anchor, focus] as const,
  )
}

test('copy then paste with the keyboard round-trips through the clipboard', async ({ page }) => {
  await page.keyboard.type('abc')
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('Shift+ArrowLeft')
  await expect.poll(() => getSelection(page)).toMatchObject({ anchor: { offset: 3 }, focus: { offset: 1 } })
  await page.keyboard.press('ControlOrMeta+c')
  await page.keyboard.press('End')
  await expect.poll(() => getSelection(page)).toMatchObject({ anchor: { offset: 3 }, focus: { offset: 3 } })
  await page.keyboard.press('ControlOrMeta+v')
  await expect.poll(() => getText(page)).toBe('abcbc')
  await expect(page.getByTestId('editor')).toHaveText('abcbc')
})

test('copy across two blocks and paste keeps the block structure with unique ids', async ({ page }) => {
  await page.keyboard.type('one')
  await page.keyboard.press('Enter')
  await page.keyboard.type('two')
  await select(page, [[0, 0], 1], [[1, 0], 2])
  await page.keyboard.press('ControlOrMeta+c')
  await focusEnd(page)
  await page.keyboard.press('ControlOrMeta+v')
  await expect.poll(() => getText(page)).toBe('one\ntwone\ntw')
  const doc = await getDoc(page)
  expect(doc.children).toHaveLength(3)
  const ids = elementIds(doc)
  expect(new Set(ids).size).toBe(ids.length)
  await expect(page.locator('[data-testid=editor] p')).toHaveText(['one', 'twone', 'tw'])
})

test('a synthetic HTML paste yields bold in the model', async ({ page }) => {
  await page.keyboard.type('a')
  expect(await pasteData(page, { 'text/html': '<p>x<strong>y</strong></p>', 'text/plain': 'xy' })).toBe(true)
  await expect.poll(() => getText(page)).toBe('axy')
  const block = (await getDoc(page)).children[0] as ElementNode
  expect(block.children).toEqual([
    { text: 'ax', marks: [] },
    { text: 'y', marks: [{ type: 'bold', data: {} }] },
  ])
  await expect(page.locator('[data-testid=editor] strong')).toHaveText('y')
})

test('pasting plain text keeps Vietnamese diacritics and emoji intact', async ({ page }) => {
  const text = 'Tiếng Việt có dấu 👍🏽 👨‍👩‍👧'
  await pasteData(page, { 'text/plain': text })
  await expect.poll(() => getText(page)).toBe(text)
  const block = (await getDoc(page)).children[0] as ElementNode
  expect((block.children![0] as TextNode).marks).toEqual([])
  await expect(page.getByTestId('editor')).toHaveText(text)
  await page.keyboard.type('!')
  expect(await getText(page)).toBe(`${text}!`)
})

test('pasting multi-line plain text creates blocks', async ({ page }) => {
  await pasteData(page, { 'text/plain': 'first\r\nsecond\nthird' })
  await expect.poll(() => getText(page)).toBe('first\nsecond\nthird')
  await expect(page.locator('[data-testid=editor] p')).toHaveText(['first', 'second', 'third'])
})

test('cut removes the selection and puts it on the clipboard', async ({ page }) => {
  await page.keyboard.type('hello world')
  await select(page, [[0, 0], 5], [[0, 0], 11])
  await page.keyboard.press('ControlOrMeta+x')
  await expect.poll(() => getText(page)).toBe('hello')
  await expect(page.getByTestId('editor')).toHaveText('hello')
  await page.keyboard.press('ControlOrMeta+v')
  await expect.poll(() => getText(page)).toBe('hello world')
})
