import { expect, test, type Page } from '@playwright/test'
import type { ElementNode } from '@hte/core'
import { collectErrors, compose, focusEnd, getDoc, getSelection, getText, openPlayground, openScenario, setCaret } from './helpers'

let errors: string[]

test.beforeEach(({ page }) => {
  errors = collectErrors(page)
})

test.afterEach(() => {
  expect(errors).toEqual([])
})

const popup = (page: Page) => page.locator('[data-hte-mention-suggestion]')
const options = (page: Page) => popup(page).getByRole('option')
const editorMentions = (page: Page) => page.locator('[data-testid=editor] [data-hte-mention]')

/** The children of the first block, as `text` / `@label` strings (mentions) for compact assertions. */
async function inline(page: Page, block = 0): Promise<string[]> {
  const doc = await getDoc(page)
  const kids = (doc.children[block] as ElementNode).children ?? []
  return kids.map((n) => ('text' in n ? n.text : `@${String((n as ElementNode).data.label)}`))
}

/** The `mention` scenario: "Hi " @Anna " and " @Bob ", welcome!" in one paragraph (children 0..4). */
async function openMentions(page: Page): Promise<void> {
  await openScenario(page, 'mention')
  await expect.poll(() => inline(page)).toEqual(['Hi ', '@Anna', ' and ', '@Bob', ', welcome!'])
}

test('type @an, ArrowDown, Enter inserts the second match; the caret is after the added space', async ({ page }) => {
  await openPlayground(page)
  await focusEnd(page)
  await page.keyboard.type('Hi @an')
  await expect(options(page)).toHaveText(['Anna', 'Andrew'])
  await expect(options(page).first()).toHaveAttribute('data-selected', '')
  await page.keyboard.press('ArrowDown')
  await expect(options(page).nth(1)).toHaveAttribute('data-selected', '')
  await page.keyboard.press('Enter')
  await expect(popup(page)).toHaveCount(0)
  const block = (await getDoc(page)).children[0] as ElementNode
  expect(block.children).toEqual([
    expect.objectContaining({ text: 'Hi ' }),
    expect.objectContaining({ type: 'mention', data: { userId: 'u-andrew', label: 'Andrew' } }),
    expect.objectContaining({ text: ' ' }),
  ])
  expect(await getSelection(page)).toMatchObject({ anchor: { path: [0, 2], offset: 1 }, focus: { path: [0, 2], offset: 1 } })
  await expect(editorMentions(page)).toHaveText(['@Andrew'])
  // The DOM caret agrees: typing continues after the space.
  await page.keyboard.type('hello')
  expect(await inline(page)).toEqual(['Hi ', '@Andrew', ' hello'])
  await expect(popup(page)).toHaveCount(0)
})

test('Esc closes the popup; Enter then splits the block normally', async ({ page }) => {
  await openPlayground(page)
  await focusEnd(page)
  await page.keyboard.type('@a')
  await expect(options(page)).toHaveText(['Alice', 'Anna', 'Andrew'])
  await page.keyboard.press('Escape')
  await expect(popup(page)).toHaveCount(0)
  expect(await getText(page)).toBe('@a')
  // The dismissed trigger stays closed while typing on.
  await page.keyboard.type('n')
  expect(await getText(page)).toBe('@an')
  // Longer than the fake fetch (150 ms): a response for the dismissed trigger must not reopen it.
  await page.waitForTimeout(200)
  await expect(popup(page)).toHaveCount(0)
  await page.keyboard.press('Enter')
  expect(await getText(page)).toBe('@an\n')
})

test('Backspace right after a mention removes it whole', async ({ page }) => {
  await openMentions(page)
  await setCaret(page, [0, 2], 0)
  await page.keyboard.press('Backspace')
  await expect.poll(() => inline(page)).toEqual(['Hi  and ', '@Bob', ', welcome!'])
  await expect(editorMentions(page)).toHaveText(['@Bob'])
  expect(await getSelection(page)).toMatchObject({ focus: { path: [0, 0], offset: 3 } })
  // Undo restores it.
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => inline(page)).toEqual(['Hi ', '@Anna', ' and ', '@Bob', ', welcome!'])
  await expect(editorMentions(page)).toHaveText(['@Anna', '@Bob'])
})

test('ArrowLeft and ArrowRight jump over a mention in one key press', async ({ page }) => {
  await openMentions(page)
  // "Hi|" then → (before the mention) → (after it, one press) → (" |and").
  await setCaret(page, [0, 0], 2)
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => getSelection(page)).toMatchObject({ focus: { path: [0, 0], offset: 3 } })
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => getSelection(page)).toMatchObject({ focus: { path: [0, 2], offset: 0 } })
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => getSelection(page)).toMatchObject({ focus: { path: [0, 2], offset: 1 } })
  // Back: ← to right after the mention, ← once more lands before it.
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => getSelection(page)).toMatchObject({ focus: { path: [0, 2], offset: 0 } })
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => getSelection(page)).toMatchObject({ focus: { path: [0, 0], offset: 3 } })
  // The DOM caret is there too: typing lands before the mention, never inside it.
  await page.keyboard.type('X')
  expect(await inline(page)).toEqual(['Hi X', '@Anna', ' and ', '@Bob', ', welcome!'])
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => getSelection(page)).toMatchObject({ focus: { path: [0, 2], offset: 0 } })
  await page.keyboard.type('Y')
  expect(await inline(page)).toEqual(['Hi X', '@Anna', 'Y and ', '@Bob', ', welcome!'])
  await expect(editorMentions(page)).toHaveText(['@Anna', '@Bob'])
})

test('arrows jump over a mention at the start of a block (zero-width neighbour)', async ({ page }) => {
  await openPlayground(page)
  await focusEnd(page)
  await page.keyboard.type('@ca')
  await expect(options(page)).toHaveText(['Carol'])
  await page.keyboard.press('Enter')
  await expect.poll(() => inline(page)).toEqual(['', '@Carol', ' '])
  await expect(page.locator('[data-testid=editor] [data-hte-zw]')).toHaveCount(1)
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => getSelection(page)).toMatchObject({ focus: { path: [0, 2], offset: 0 } })
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => getSelection(page)).toMatchObject({ focus: { path: [0, 0], offset: 0 } })
  await page.keyboard.type('A')
  expect(await inline(page)).toEqual(['A', '@Carol', ' '])
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => getSelection(page)).toMatchObject({ focus: { path: [0, 2], offset: 0 } })
  await page.keyboard.type('B')
  expect(await inline(page)).toEqual(['A', '@Carol', 'B '])
})

test('a selection spanning a mention is replaced by typing; undo restores the mention', async ({ page }) => {
  await openMentions(page)
  await setCaret(page, [0, 0], 2)
  // " ", the mention (one press), " ".
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  await expect
    .poll(() => getSelection(page))
    .toMatchObject({ anchor: { path: [0, 0], offset: 2 }, focus: { path: [0, 2], offset: 1 } })
  await page.keyboard.type('Z')
  expect(await inline(page)).toEqual(['HiZand ', '@Bob', ', welcome!'])
  await expect(editorMentions(page)).toHaveText(['@Bob'])
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => inline(page)).toEqual(['Hi ', '@Anna', ' and ', '@Bob', ', welcome!'])
})

test.describe('IME composition next to a mention', () => {
  test('right after a mention', async ({ page }) => {
    await openMentions(page)
    await setCaret(page, [0, 2], 0)
    await compose(page, ['ê', 'ế'], 'ế')
    await expect.poll(() => inline(page)).toEqual(['Hi ', '@Anna', 'ế and ', '@Bob', ', welcome!'])
    await expect(editorMentions(page)).toHaveText(['@Anna', '@Bob'])
    await expect.poll(() => getSelection(page)).toMatchObject({ focus: { path: [0, 2], offset: 1 } })
    await page.keyboard.type('x')
    expect(await inline(page)).toEqual(['Hi ', '@Anna', 'ếx and ', '@Bob', ', welcome!'])
  })

  test('right before a mention', async ({ page }) => {
    await openMentions(page)
    await setCaret(page, [0, 0], 3)
    await compose(page, ['n', 'ni', '你'], '你')
    await expect.poll(() => inline(page)).toEqual(['Hi 你', '@Anna', ' and ', '@Bob', ', welcome!'])
    await expect(editorMentions(page)).toHaveText(['@Anna', '@Bob'])
    await page.keyboard.type('x')
    expect(await inline(page)).toEqual(['Hi 你x', '@Anna', ' and ', '@Bob', ', welcome!'])
  })

  test('in the zero-width leaf before a mention at the start of a block', async ({ page }) => {
    await openPlayground(page)
    await focusEnd(page)
    await page.keyboard.type('@ca')
    await expect(options(page)).toHaveText(['Carol'])
    await page.keyboard.press('Enter')
    await expect.poll(() => inline(page)).toEqual(['', '@Carol', ' '])
    await setCaret(page, [0, 0], 0)
    await compose(page, ['ê', 'ế'], 'ế')
    await expect.poll(() => inline(page)).toEqual(['ế', '@Carol', ' '])
    await expect(editorMentions(page)).toHaveText(['@Carol'])
    await expect(page.locator('[data-testid=editor] p')).toHaveText(['ế@Carol '])
    await page.keyboard.type('x')
    expect(await inline(page)).toEqual(['ếx', '@Carol', ' '])
  })
})

test('?slowUsers=1: typing @a then @an quickly never shows a stale list', async ({ page }) => {
  await openPlayground(page, '/?slowUsers=1')
  // Record every list the popup shows, with the query open at that moment.
  await page.evaluate(() => {
    const seen: { query: string; labels: string[] }[] = []
    ;(window as unknown as { seen: typeof seen }).seen = seen
    new MutationObserver(() => {
      const items = Array.from(document.querySelectorAll('[data-hte-mention-suggestion] [role=option]'))
      if (items.length === 0) return
      const st = window.editor.getPluginState<{ query: string }>('mention')
      seen.push({ query: st.query, labels: items.map((li) => li.textContent ?? '') })
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
  })
  await focusEnd(page)
  for (let round = 0; round < 5; round++) {
    await page.keyboard.type('@a')
    await page.keyboard.type('n')
    await expect(options(page)).toHaveText(['Anna', 'Andrew'])
    // Longer than the slowest response: a late answer for "a" must not replace the list.
    await page.waitForTimeout(450)
    await expect(options(page)).toHaveText(['Anna', 'Andrew'])
    await page.keyboard.press('Escape')
    await page.keyboard.type(' ')
  }
  const seen = await page.evaluate(() => (window as unknown as { seen: { query: string; labels: string[] }[] }).seen)
  expect(seen.length).toBeGreaterThan(0)
  for (const { query, labels } of seen) {
    for (const label of labels) expect(label.toLowerCase().startsWith(query.toLowerCase()), `${label} for "${query}"`).toBe(true)
  }
})
