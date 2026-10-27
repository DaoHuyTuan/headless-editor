import { expect, test } from '@playwright/test'
import { getDoc, getSelection, getText, openPlayground } from './helpers'

const unknownHeading = {
  id: 'unknown-heading',
  type: 'heading',
  data: { level: 1 },
  children: [{ text: 'Title', marks: [] }],
}

let errors: string[]

test.beforeEach(async ({ page }) => {
  errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await openPlayground(page)
  await page.getByTestId('scenario').selectOption('unknownBlock')
  await expect.poll(() => getText(page)).toBe('Title\nBody text')
  // The initial caret skips the unknown block's text (it is not rendered).
  expect(await getSelection(page)).toEqual({ anchor: { path: [1, 0], offset: 0 }, focus: { path: [1, 0], offset: 0 } })
  await page.evaluate(() => window.editor.view!.focus())
})

test.afterEach(() => {
  expect(errors).toEqual([])
})

test('focus, type, Ctrl+A and Backspace work; the unknown block survives', async ({ page }) => {
  await page.keyboard.type('X')
  expect(await getText(page)).toBe('Title\nXBody text')
  await expect(page.locator('[data-testid=editor] p')).toHaveText(['XBody text'])

  await page.keyboard.press('ControlOrMeta+a')
  await expect
    .poll(() => getSelection(page))
    .toEqual({ anchor: { path: [1, 0], offset: 0 }, focus: { path: [1, 0], offset: 10 } })
  await page.keyboard.press('Backspace')
  const doc = await getDoc(page)
  expect(doc.children[0]).toEqual(unknownHeading)
  expect(doc.children).toHaveLength(2)
  expect(await getText(page)).toBe('Title\n')

  await page.keyboard.type('Y')
  expect(await getText(page)).toBe('Title\nY')
  await expect(page.locator('[data-testid=editor] p')).toHaveText(['Y'])
})

test('Backspace at the start of the block after the unknown block does nothing', async ({ page }) => {
  await page.keyboard.press('Backspace')
  expect(await getText(page)).toBe('Title\nBody text')
  expect((await getDoc(page)).children[0]).toEqual(unknownHeading)
  await expect(page.locator('[data-testid=editor] p')).toHaveText(['Body text'])
  await expect(page.locator('[data-testid=editor] [data-hte-unknown=heading]')).toHaveCount(1)
  await page.keyboard.type('Z')
  expect(await getText(page)).toBe('Title\nZBody text')
})
