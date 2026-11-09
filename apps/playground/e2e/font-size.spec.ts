import { expect, test } from '@playwright/test'
import type { ElementNode } from '@hte/core'
import { focusEnd, getDoc, getText, openPlayground } from './helpers'

let errors: string[]

test.beforeEach(async ({ page }) => {
  errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await openPlayground(page)
  await focusEnd(page)
})

test.afterEach(() => {
  expect(errors).toEqual([])
})

const size = (s: string) => ({ type: 'fontSize', data: { size: s } })

test('choosing 24px on a selection adds the fontSize mark to it', async ({ page }) => {
  await page.keyboard.type('hello world')
  // Select "world" as a user does: Shift+ArrowLeft from the end.
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft')
  await expect
    .poll(() => page.evaluate(() => window.editor.state.selection?.ranges[0]))
    .toEqual({ anchor: { path: [0, 0], offset: 11 }, focus: { path: [0, 0], offset: 6 } })
  const select = page.getByTestId('font-size')
  await expect(select).toHaveValue('')
  await select.selectOption('24px')

  const block = (await getDoc(page)).children[0] as ElementNode
  expect(block.children).toEqual([
    { text: 'hello ', marks: [] },
    { text: 'world', marks: [size('24px')] },
  ])
  await expect(page.locator('[data-testid=editor] span[style*="font-size"]')).toHaveText('world')
  await expect(page.locator('[data-testid=editor] span[style*="font-size"]')).toHaveCSS('font-size', '24px')
  // The select reflects the active size, and the editor keeps focus.
  await expect(select).toHaveValue('24px')
  await expect(page.getByTestId('editor')).toBeFocused()

  // "Default" removes the mark again.
  await select.selectOption('')
  const after = (await getDoc(page)).children[0] as ElementNode
  expect(after.children).toEqual([{ text: 'hello world', marks: [] }])
  await expect(select).toHaveValue('')
})

test('typing after choosing a size at the caret uses that size', async ({ page }) => {
  await page.keyboard.type('a')
  await page.getByTestId('font-size').selectOption('16px')
  await expect(page.getByTestId('editor')).toBeFocused()
  await page.keyboard.type('big')
  expect(await getText(page)).toBe('abig')
  const block = (await getDoc(page)).children[0] as ElementNode
  expect(block.children).toEqual([
    { text: 'a', marks: [] },
    { text: 'big', marks: [size('16px')] },
  ])
  await expect(page.getByTestId('font-size')).toHaveValue('16px')
})

test('the fontSizes scenario loads sizes as marks, and the select follows the caret', async ({ page }) => {
  await page.getByTestId('story-fontSizes').click()
  await expect(page.getByTestId('story-fontSizes')).toHaveAttribute('aria-current', 'page')
  const doc = await getDoc(page)
  const marks = doc.children.flatMap((b) => ((b as ElementNode).children ?? []).flatMap((c) => ('text' in c ? c.marks : [])))
  expect(marks).toEqual(expect.arrayContaining([size('12px'), size('16px'), size('24px'), size('32px')]))
  // Put the caret inside the 32px text with a click.
  await page.locator('[data-testid=editor] span[style*="font-size: 32px"]').first().click()
  await expect(page.getByTestId('font-size')).toHaveValue('32px')
})
