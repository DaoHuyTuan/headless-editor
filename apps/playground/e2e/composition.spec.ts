import { expect, test, type CDPSession, type Page } from '@playwright/test'
import type { ElementNode, TextNode } from '@hte/core'
import { focusEnd, getDoc, getSelection, getText, openPlayground } from './helpers'

let cdp: CDPSession

test.beforeEach(async ({ page }) => {
  await openPlayground(page)
  cdp = await page.context().newCDPSession(page)
  await focusEnd(page)
})

/** Drives an IME composition through CDP: each step updates the composition, then `commit` is inserted. */
async function compose(steps: string[], commit: string): Promise<void> {
  for (const text of steps) {
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
  }
  await cdp.send('Input.insertText', { text: commit })
}

async function editorText(page: Page): Promise<string | null> {
  return page.getByTestId('editor').textContent()
}

test('Vietnamese composition in an empty doc', async ({ page }) => {
  await cdp.send('Input.imeSetComposition', { text: 'ê', selectionStart: 1, selectionEnd: 1 })
  await cdp.send('Input.imeSetComposition', { text: 'ế', selectionStart: 1, selectionEnd: 1 })
  await cdp.send('Input.insertText', { text: 'ế' })
  expect(await getText(page)).toBe('ế')
  expect(await editorText(page)).toBe('ế')
})

test('composition mid-word lands at the caret, which ends up after the composed text', async ({ page }) => {
  await page.keyboard.type('abc')
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => getSelection(page)).toMatchObject({ focus: { path: [0, 0], offset: 2 } })
  await compose(['ê', 'ế'], 'ế')
  expect(await getText(page)).toBe('abếc')
  await expect.poll(() => getSelection(page)).toMatchObject({ focus: { path: [0, 0], offset: 3 } })
  await page.keyboard.type('x')
  expect(await getText(page)).toBe('abếxc')
  expect(await editorText(page)).toBe('abếxc')
})

test('CJK composition; one undo removes it', async ({ page }) => {
  await compose(['n', 'ni', 'nih', 'niha', 'nihao', '你好'], '你好')
  expect(await getText(page)).toBe('你好')
  expect(await editorText(page)).toBe('你好')
  await page.keyboard.press('ControlOrMeta+z')
  expect(await getText(page)).toBe('')
  await expect(page.getByTestId('editor')).toHaveText('')
})

test('composing inside bold text keeps it bold', async ({ page }) => {
  await page.keyboard.type('a')
  await page.keyboard.press('ControlOrMeta+b')
  await page.keyboard.type('bc')
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => getSelection(page)).toMatchObject({ focus: { path: [0, 1], offset: 1 } })
  await compose(['ê', 'ế'], 'ế')
  const block = (await getDoc(page)).children[0] as ElementNode
  expect(block.children).toEqual([
    expect.objectContaining({ text: 'a', marks: [] }),
    expect.objectContaining({ text: 'bếc', marks: [{ type: 'bold', data: {} }] }),
  ])
  await expect(page.locator('[data-testid=editor] strong')).toHaveText('bếc')
})

test('Mod+b at a caret, then compose: the composed text is bold, like typing', async ({ page }) => {
  await page.keyboard.type('ab')
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => getSelection(page)).toMatchObject({ focus: { path: [0, 0], offset: 1 } })
  await page.keyboard.press('ControlOrMeta+b')
  await compose(['ê', 'ế'], 'ế')
  const block = (await getDoc(page)).children[0] as ElementNode
  expect(block.children).toEqual([
    expect.objectContaining({ text: 'a', marks: [] }),
    expect.objectContaining({ text: 'ế', marks: [{ type: 'bold', data: {} }] }),
    expect.objectContaining({ text: 'b', marks: [] }),
  ])
  await expect(page.locator('[data-testid=editor] strong')).toHaveText('ế')
  expect(await editorText(page)).toBe('aếb')
  await expect.poll(() => getSelection(page)).toMatchObject({ focus: { path: [0, 1], offset: 1 } })
})

test('composing at the start of bold text after plain text follows the typing rule (plain)', async ({ page }) => {
  await page.keyboard.type('a')
  await page.keyboard.press('ControlOrMeta+b')
  await page.keyboard.type('bc')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => getSelection(page)).toMatchObject({ focus: { offset: 1 } })
  const typedMarks = await page.evaluate(() => window.editor.isActive('bold'))
  await compose(['ê', 'ế'], 'ế')
  const block = (await getDoc(page)).children[0] as ElementNode
  expect(typedMarks).toBe(false)
  expect(block.children).toEqual([
    expect.objectContaining({ text: 'aế', marks: [] }),
    expect.objectContaining({ text: 'bc', marks: [{ type: 'bold', data: {} }] }),
  ])
  await expect(page.locator('[data-testid=editor] strong')).toHaveText('bc')
  expect(await editorText(page)).toBe('aếbc')
})

test('compose, then Backspace deletes the last composed character', async ({ page }) => {
  await compose(['n', 'ni', '你', '你好'], '你好')
  expect(await getText(page)).toBe('你好')
  await page.keyboard.press('Backspace')
  expect(await getText(page)).toBe('你')
  expect(await editorText(page)).toBe('你')
  await page.keyboard.type('a')
  expect(await getText(page)).toBe('你a')
})

test('composing at the start of an empty paragraph', async ({ page }) => {
  await page.keyboard.type('ab')
  await page.keyboard.press('Enter')
  await expect.poll(() => getSelection(page)).toMatchObject({ focus: { path: [1, 0], offset: 0 } })
  await compose(['x', 'xi', '西'], '西')
  expect(await getText(page)).toBe('ab\n西')
  await expect(page.locator('[data-testid=editor] p')).toHaveText(['ab', '西'])
  const second = (await getDoc(page)).children[1] as ElementNode
  expect((second.children![0] as TextNode).text).toBe('西')
  await page.keyboard.type('!')
  expect(await getText(page)).toBe('ab\n西!')
})

test('composition replaces a selection', async ({ page }) => {
  await page.keyboard.type('abcd')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('Shift+ArrowLeft')
  await expect.poll(() => getSelection(page)).toMatchObject({ anchor: { offset: 3 }, focus: { offset: 1 } })
  await compose(['ê', 'ế'], 'ế')
  expect(await getText(page)).toBe('aếd')
  expect(await editorText(page)).toBe('aếd')
})
