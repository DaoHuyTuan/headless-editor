import { expect, test, type Page } from '@playwright/test'
import type { ElementNode } from '@hte/core'
import { collectErrors, getDoc, getSelection, getText, openScenario } from './helpers'

let errors: string[]

test.beforeEach(async ({ page }) => {
  errors = collectErrors(page)
  await openScenario(page, 'customImage')
  await expect.poll(async () => (await getDoc(page)).children.map((b) => b.type)).toEqual(['paragraph', 'image', 'paragraph'])
})

test.afterEach(() => {
  expect(errors).toEqual([])
})

const image = async (page: Page) => (await getDoc(page)).children[1] as ElementNode
const custom = (page: Page) => page.locator('[data-testid=editor] [data-custom-image]')
const img = (page: Page) => custom(page).locator('img')

test('the customImage scenario renders the hooks-only view; other scenarios the default one', async ({ page }) => {
  await expect(custom(page)).toHaveCount(1)
  await expect(custom(page)).toHaveAttribute('data-hte-image', '')
  await expect(page.getByTestId('custom-alt-caption')).toHaveText('(no alt)')
  // The controls the hooks spread carry data-editor-ignore.
  await expect(custom(page).getByLabel('Alt text')).toHaveAttribute('data-editor-ignore', '')
  await expect(custom(page).locator('.image-resize')).toHaveAttribute('data-editor-ignore', '')
  // The src went through safeSrc: the data URL is kept.
  await expect(img(page)).toHaveAttribute('src', /^data:image\/png;base64,/)
  await page.getByTestId('scenario').selectOption('image')
  await expect(custom(page)).toHaveCount(0)
  await expect(page.locator('[data-testid=editor] [data-hte-image]')).toHaveCount(1)
})

test('editing the alt in the custom view commits it on Tab; the text is unchanged; undo restores it', async ({ page }) => {
  const before = await getText(page)
  const alt = custom(page).getByLabel('Alt text')
  await alt.click()
  await page.keyboard.type('A cat')
  await expect(alt).toHaveValue('A cat')
  // Not committed while typing (a draft).
  expect((await image(page)).data.alt).toBe('')
  await page.keyboard.press('Tab')
  await expect.poll(async () => (await image(page)).data.alt).toBe('A cat')
  await expect(page.getByTestId('custom-alt-caption')).toHaveText('A cat')
  await expect(img(page)).toHaveAttribute('alt', 'A cat')
  expect(await getText(page)).toBe(before)
  await page.getByTestId('undo').click()
  await expect.poll(async () => (await image(page)).data.alt).toBe('')
  await expect(alt).toHaveValue('')
})

test('Enter in the alt input commits; Escape reverts a draft', async ({ page }) => {
  const alt = custom(page).getByLabel('Alt text')
  await alt.click()
  await page.keyboard.type('Dog')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await image(page)).data.alt).toBe('Dog')
  await page.keyboard.type('gy')
  await page.keyboard.press('Escape')
  await expect(alt).toHaveValue('Dog')
  expect((await image(page)).data.alt).toBe('Dog')
})

test('dragging the resize handle of the custom view by +40px increases the width', async ({ page }) => {
  const start = (await img(page).boundingBox())!.width
  const handle = custom(page).locator('.image-resize')
  const box = (await handle.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 20, y, { steps: 4 })
  await expect(custom(page)).toHaveAttribute('data-resizing', '')
  await page.mouse.move(x + 40, y, { steps: 4 })
  await page.mouse.up()
  await expect(custom(page)).not.toHaveAttribute('data-resizing', '')
  const width = (await image(page)).data.width as number
  expect(width).toBe(Math.round(start + 40))
  await expect(img(page)).toHaveAttribute('width', String(width))
})

test('clicking the custom view node-selects it; Backspace removes it', async ({ page }) => {
  await img(page).click()
  expect((await getSelection(page))?.node).toEqual([1])
  await expect(custom(page)).toHaveAttribute('data-selected', '')
  await page.keyboard.press('Backspace')
  await expect(custom(page)).toHaveCount(0)
  expect(await getText(page)).toBe('before\nafter')
})
