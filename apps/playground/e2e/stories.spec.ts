import { expect, test } from '@playwright/test'
import type { Node } from '@hte/core'
import { collectErrors, focusEnd, getDoc, getText, openPlayground, setCaret } from './helpers'

const current = (page: import('@playwright/test').Page, id: string) => page.getByTestId(`story-${id}`)

function leaves(node: Node): Node[] {
  return 'text' in node ? [node] : (node.children ?? []).flatMap(leaves)
}

test('a deep link opens its story', async ({ page }) => {
  const errors = collectErrors(page)
  await openPlayground(page, '/#/code-block/javascript')
  expect(await getText(page)).toMatch(/^A JS snippet:/)
  await expect(current(page, 'codeBlock')).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('h1')).toHaveText('Code block')
  expect(errors).toEqual([])
})

test('clicking a story updates the URL and the content', async ({ page }) => {
  await openPlayground(page)
  await current(page, 'bold').click()
  await expect(current(page, 'bold')).toHaveAttribute('aria-current', 'page')
  await page.waitForURL(/#\/bold\/basic$/)
  expect(page.url().endsWith('#/bold/basic')).toBe(true)
  const doc = await getDoc(page)
  const bold = leaves(doc as unknown as Node).some((n) => 'marks' in n && n.marks.some((m) => m.type === 'bold'))
  expect(bold).toBe(true)
})

test('back and forward switch stories and the toolbar follows', async ({ page }) => {
  await openPlayground(page, '/#/bold/basic')
  const boldText = await getText(page)
  await setCaret(page, [0, 1], 2)
  await expect(page.getByTestId('bold')).toHaveAttribute('aria-pressed', 'true')
  await current(page, 'paragraphs').click()
  await expect(current(page, 'paragraphs')).toHaveAttribute('aria-current', 'page')
  const paragraphsText = await getText(page)
  await focusEnd(page)
  await page.keyboard.type('X')
  await page.goBack()
  await expect(current(page, 'bold')).toHaveAttribute('aria-current', 'page')
  expect(await getText(page)).toBe(boldText)
  await page.goForward()
  await expect(current(page, 'paragraphs')).toHaveAttribute('aria-current', 'page')
  expect(await getText(page)).toBe(paragraphsText)
  await setCaret(page, [0, 0], 1)
  await expect(page.getByTestId('bold')).toHaveAttribute('aria-pressed', 'false')
  await page.goBack()
  await expect(current(page, 'bold')).toHaveAttribute('aria-current', 'page')
  await setCaret(page, [0, 1], 2)
  await expect(page.getByTestId('bold')).toHaveAttribute('aria-pressed', 'true')
})

test('clicking the open story restores its content', async ({ page }) => {
  await openPlayground(page, '/#/basics/paragraphs')
  const original = await getText(page)
  await focusEnd(page)
  await page.keyboard.type('zzz')
  expect(await getText(page)).not.toBe(original)
  await current(page, 'paragraphs').click()
  expect(await getText(page)).toBe(original)
})

test('an unknown hash shows the first story', async ({ page }) => {
  const errors = collectErrors(page)
  await openPlayground(page, '/#/nope')
  await expect(current(page, 'empty')).toHaveAttribute('aria-current', 'page')
  expect(errors).toEqual([])
})

test('a query flag survives a deep link and story switches', async ({ page }) => {
  await openPlayground(page, '/?slowUsers=1#/mention/basic')
  await expect(current(page, 'mention')).toHaveAttribute('aria-current', 'page')
  await current(page, 'bold').click()
  await expect(current(page, 'bold')).toHaveAttribute('aria-current', 'page')
  const url = new URL(page.url())
  expect(url.search).toBe('?slowUsers=1')
  expect(url.hash).toBe('#/bold/basic')
})

test('the document panel shows JSON when opened', async ({ page }) => {
  await openPlayground(page)
  await expect(page.getByTestId('json')).toBeHidden()
  await page.getByTestId('doc-panel').locator('summary').click()
  await expect(page.getByTestId('json')).toContainText('"type": "doc"')
})

test('phone width stacks the sidebar', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 })
  await openPlayground(page, '/#/image/default')
  const nav = await page.getByRole('navigation', { name: 'Stories' }).boundingBox()
  const editor = await page.getByTestId('editor').boundingBox()
  expect(nav!.y + nav!.height).toBeLessThanOrEqual(editor!.y)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
