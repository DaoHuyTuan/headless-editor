import { expect, test } from '@playwright/test'
import { focusEnd, getText, openPlayground } from './helpers'

test.beforeEach(async ({ page }) => {
  await openPlayground(page)
  await focusEnd(page)
})

/** Sets carets at the given offsets of the first block's first text (through the editor API: no UI creates several yet). */
async function setCarets(page: import('@playwright/test').Page, offsets: number[]): Promise<void> {
  await page.evaluate((offsets) => {
    const editor = window.editor
    const ranges = offsets.map((offset) => ({ anchor: { path: [0, 0], offset }, focus: { path: [0, 0], offset } }))
    editor.dispatch(editor.createTransaction().setSelection({ ranges, main: ranges.length - 1 }))
  }, offsets)
}

const rangeCount = (page: import('@playwright/test').Page) =>
  page.evaluate(() => window.editor.state.selection?.ranges.length ?? 0)

test('typing at two carets set through the editor inserts at both; Ctrl+Z restores', async ({ page }) => {
  // Loaded through setContent, so the undo below reverts only the typing at the carets.
  await page.evaluate(() => window.editor.setContent('<p>foo bar foo</p>'))
  await setCarets(page, [3, 11])
  await expect.poll(() => rangeCount(page)).toBe(2)

  await page.keyboard.type('x')
  await expect.poll(() => getText(page)).toBe('foox bar foox')
  expect(await rangeCount(page)).toBe(2)
  await expect(page.getByTestId('editor')).toHaveText('foox bar foox')

  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => getText(page)).toBe('foo bar foo')
  expect(await rangeCount(page)).toBe(2)
})
