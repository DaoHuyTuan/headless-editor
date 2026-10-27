import { expect, test } from '@playwright/test'
import type { ElementNode, TextNode } from '@hte/core'
import { focusEnd, getDoc, getSelection, getText, openPlayground } from './helpers'

test.beforeEach(async ({ page }) => {
  await openPlayground(page)
  await focusEnd(page)
})

test('typing inserts text', async ({ page }) => {
  await page.keyboard.type('Hello')
  expect(await getText(page)).toBe('Hello')
  await expect(page.getByTestId('editor')).toHaveText('Hello')
})

test('Enter splits into two blocks', async ({ page }) => {
  await page.keyboard.type('Hello')
  await page.keyboard.press('Enter')
  await page.keyboard.type('World')
  expect((await getDoc(page)).children).toHaveLength(2)
  expect(await getText(page)).toBe('Hello\nWorld')
  await expect(page.locator('[data-testid=editor] p')).toHaveText(['Hello', 'World'])
})

test('Backspace at the start of block 2 merges, then keeps deleting', async ({ page }) => {
  await page.keyboard.type('Hello')
  await page.keyboard.press('Enter')
  await page.keyboard.type('World')
  await page.keyboard.press('Home')
  await expect.poll(() => getSelection(page)).toMatchObject({ focus: { path: [1, 0], offset: 0 } })
  for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace')
  expect(await getText(page)).toBe('HWorld')
  await expect(page.locator('[data-testid=editor] p')).toHaveText(['HWorld'])
})

test('select all, then type, leaves one block with the typed text', async ({ page }) => {
  await page.keyboard.type('One')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Two')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Three')
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('X')
  expect((await getDoc(page)).children).toHaveLength(1)
  expect(await getText(page)).toBe('X')
  await expect(page.locator('[data-testid=editor] p')).toHaveText(['X'])
})

test('select all, then Backspace, leaves one empty block', async ({ page }) => {
  await page.keyboard.type('One')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Two')
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  expect((await getDoc(page)).children).toHaveLength(1)
  expect(await getText(page)).toBe('')
  await page.keyboard.type('Y')
  expect(await getText(page)).toBe('Y')
})

test('Mod+b then typing makes the new text bold', async ({ page }) => {
  await page.keyboard.type('plain ')
  await page.keyboard.press('ControlOrMeta+b')
  await page.keyboard.type('B')
  const block = (await getDoc(page)).children[0] as ElementNode
  const last = block.children!.at(-1) as TextNode
  expect(last.text).toBe('B')
  expect(last.marks).toEqual([{ type: 'bold', data: {} }])
  expect((block.children![0] as TextNode).marks).toEqual([])
  await expect(page.locator('[data-testid=editor] strong')).toHaveText('B')
})

test('Mod+z undoes and Shift+Mod+z redoes', async ({ page }) => {
  await page.keyboard.type('Hello')
  await page.keyboard.press('ControlOrMeta+z')
  expect(await getText(page)).toBe('')
  await expect(page.getByTestId('editor')).toHaveText('')
  await page.keyboard.press('ControlOrMeta+Shift+z')
  expect(await getText(page)).toBe('Hello')
})

test('arrow keys move the caret; typing inserts at the moved caret', async ({ page }) => {
  await page.keyboard.type('Hello')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.type('X')
  expect(await getText(page)).toBe('HelXlo')
  await page.keyboard.press('Enter')
  await page.keyboard.type('next')
  await page.keyboard.press('ArrowUp')
  await expect.poll(async () => (await getSelection(page))?.focus.path[0]).toBe(0)
  await page.keyboard.press('End')
  await page.keyboard.type('!')
  // Enter split "HelX|lo", so block 2 is "next" + "lo".
  expect(await getText(page)).toBe('HelX!\nnextlo')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.type('_')
  expect(await getText(page)).toBe('HelX!\nn_extlo')
})

test('the Bold button follows the selection', async ({ page }) => {
  const button = page.getByTestId('bold')
  await page.keyboard.type('ab')
  await expect(button).toHaveAttribute('data-active', 'false')
  await page.keyboard.press('ControlOrMeta+b')
  await expect(button).toHaveAttribute('data-active', 'true')
  await page.keyboard.type('cd')
  await expect(button).toHaveAttribute('data-active', 'true')
  await page.keyboard.press('Home')
  await expect(button).toHaveAttribute('data-active', 'false')
  await page.keyboard.press('End')
  await expect(button).toHaveAttribute('data-active', 'true')
  await page.keyboard.press('Shift+Home')
  await expect(button).toHaveAttribute('data-active', 'false')
  await button.click()
  await expect(button).toHaveAttribute('data-active', 'true')
  const block = (await getDoc(page)).children[0] as ElementNode
  expect(block.children).toEqual([expect.objectContaining({ text: 'abcd', marks: [{ type: 'bold', data: {} }] })])
})
