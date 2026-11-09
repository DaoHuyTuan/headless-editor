import { expect, test, type Page } from '@playwright/test'
import type { ElementNode, TextNode } from '@hte/core'
import {
  collectErrors,
  compose,
  focusEnd,
  getDoc,
  getSelection,
  getText,
  openPlayground,
  openScenario,
  setCaret,
  syntheticCopy,
  syntheticPaste,
} from './helpers'

let errors: string[]

test.beforeEach(({ page }) => {
  errors = collectErrors(page)
})

test.afterEach(() => {
  expect(errors).toEqual([])
})

/** The code of the `codeBlock` scenario: [0] "A JS snippet:", [1] this code block (javascript), [2] "after". */
const SNIPPET = 'function greet(name) {\n  return `Hello, ${name}!`\n}'
const LINE_1_END = SNIPPET.indexOf('\n')

const textOf = (n: ElementNode): string =>
  (n.children ?? []).map((c) => ('text' in c ? c.text : textOf(c as ElementNode))).join('')
const types = async (page: Page) => (await getDoc(page)).children.map((b) => b.type)
const codeButton = (page: Page) => page.getByTestId('code-block')
const pre = (page: Page) => page.locator('[data-testid=editor] [data-hte-code-block] pre')

/** The code block at `index` among the top-level blocks: its single text child (asserted unmarked). */
async function code(page: Page, index: number): Promise<TextNode> {
  const block = (await getDoc(page)).children[index] as ElementNode
  expect(block.type).toBe('codeBlock')
  expect(block.children).toHaveLength(1)
  return block.children![0] as TextNode
}
const codeText = async (page: Page, index: number) => (await code(page, index)).text

async function openSnippet(page: Page): Promise<void> {
  await openScenario(page, 'codeBlock')
  await expect.poll(() => types(page)).toEqual(['paragraph', 'codeBlock', 'paragraph'])
}

/** The viewport rect of the DOM character at `offset` of the code block's text (decorations split it into several DOM texts). */
function charRect(page: Page, offset: number) {
  return page.evaluate((offset) => {
    const content = document.querySelector('[data-testid=editor] [data-hte-code-block] [data-hte-content]')!
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
    let rest = offset
    while (walker.nextNode()) {
      const t = walker.currentNode as Text
      if (rest < t.data.length) {
        const range = document.createRange()
        range.setStart(t, rest)
        range.setEnd(t, rest + 1)
        const r = range.getBoundingClientRect()
        return { left: r.left, top: r.top, width: r.width, height: r.height }
      }
      rest -= t.data.length
    }
    throw new Error(`no character at ${offset}`)
  }, offset)
}

test('toggle, two lines with Enter, Tab indents, triple Enter exits', async ({ page }) => {
  await openPlayground(page)
  await focusEnd(page)
  await page.keyboard.type('abc')
  await codeButton(page).click()
  await expect.poll(() => types(page)).toEqual(['codeBlock'])
  await expect(codeButton(page)).toHaveAttribute('aria-pressed', 'true')
  // The caret stays at the end, in the DOM too: typing continues there.
  await expect.poll(() => getSelection(page)).toMatchObject({ anchor: { path: [0, 0], offset: 3 }, focus: { path: [0, 0], offset: 3 } })
  await page.keyboard.type('d')
  expect(await codeText(page, 0)).toBe('abcd')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  await page.keyboard.type('x')
  expect(await codeText(page, 0)).toBe('abcd\n  x')
  await expect(pre(page)).toHaveText('abcd\n  x')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  expect(await codeText(page, 0)).toBe('abcd\n  x\n\n')
  await page.keyboard.press('Enter')
  expect(await types(page)).toEqual(['codeBlock', 'paragraph'])
  expect(await codeText(page, 0)).toBe('abcd\n  x')
  await expect.poll(() => getSelection(page)).toMatchObject({ focus: { path: [1, 0], offset: 0 } })
  await expect(codeButton(page)).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.type('p')
  await expect(page.locator('[data-testid=editor] p')).toHaveText(['p'])
})

test('the Code button inside a code block exits it to a new paragraph', async ({ page }) => {
  await openSnippet(page)
  await setCaret(page, [1, 0], 3)
  await expect(codeButton(page)).toHaveAttribute('aria-pressed', 'true')
  await codeButton(page).click()
  expect(await types(page)).toEqual(['paragraph', 'codeBlock', 'paragraph', 'paragraph'])
  await expect.poll(() => getSelection(page)).toMatchObject({ focus: { path: [2, 0], offset: 0 } })
  await page.keyboard.type('q')
  expect(((await getDoc(page)).children[2] as ElementNode).children).toEqual([expect.objectContaining({ text: 'q' })])
})

test('a trailing newline shows an empty last line that takes the caret', async ({ page }) => {
  await openPlayground(page)
  await focusEnd(page)
  await codeButton(page).click()
  await page.keyboard.type('a')
  const oneLine = (await pre(page).boundingBox())!.height
  await page.keyboard.press('Enter')
  expect(await codeText(page, 0)).toBe('a\n')
  const twoLines = (await pre(page).boundingBox())!.height
  const lineHeight = await pre(page).evaluate((el) => parseFloat(getComputedStyle(el).lineHeight))
  expect(twoLines - oneLine).toBeGreaterThan(lineHeight * 0.75)
  // The DOM caret is after the newline, right before what renders the empty line, which is below "a".
  const caret = await page.evaluate(() => {
    const s = window.getSelection()!
    const node = s.focusNode!
    const text = node.nodeType === 3 ? (node as Text).data.slice(0, s.focusOffset) : null
    const br = document.querySelector('[data-testid=editor] [data-hte-content] [data-hte-leaf] br')
    return { before: text, lineTop: br?.getBoundingClientRect().top ?? null }
  })
  expect(caret.before).toBe('a\n')
  const a = await charRect(page, 0)
  expect(caret.lineTop).toBeGreaterThan(a.top + a.height / 2)
  await page.keyboard.type('b')
  expect(await codeText(page, 0)).toBe('a\nb')

  // Clicking in the empty last line puts the caret there.
  await page.keyboard.press('Enter')
  await setCaret(page, [0, 0], 0)
  const box = (await pre(page).boundingBox())!
  const padding = await pre(page).evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom))
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - padding - 3)
  await expect.poll(() => getSelection(page)).toMatchObject({ focus: { path: [0, 0], offset: 4 } })
  await page.keyboard.type('c')
  expect(await codeText(page, 0)).toBe('a\nb\nc')
})

test('clicking inside the <pre> places the caret at that character', async ({ page }) => {
  await openSnippet(page)
  const at = SNIPPET.indexOf('return')
  const r = await charRect(page, at)
  await page.mouse.click(r.left + 1, r.top + r.height / 2)
  await expect.poll(() => getSelection(page)).toMatchObject({ focus: { path: [1, 0], offset: at } })
  await page.keyboard.type('X')
  expect(await codeText(page, 1)).toBe(SNIPPET.slice(0, at) + 'X' + SNIPPET.slice(at))
})

test('Enter and Shift+Enter each insert a newline inside the block', async ({ page }) => {
  await openSnippet(page)
  await setCaret(page, [1, 0], LINE_1_END)
  await page.keyboard.press('Enter')
  await expect.poll(() => codeText(page, 1)).toBe(SNIPPET.slice(0, LINE_1_END) + '\n' + SNIPPET.slice(LINE_1_END))
  await page.keyboard.press('Shift+Enter')
  await expect.poll(() => codeText(page, 1)).toBe(SNIPPET.slice(0, LINE_1_END) + '\n\n' + SNIPPET.slice(LINE_1_END))
  expect(await types(page)).toEqual(['paragraph', 'codeBlock', 'paragraph'])
  await expect.poll(() => getSelection(page)).toMatchObject({ focus: { path: [1, 0], offset: LINE_1_END + 2 } })
  await page.keyboard.type('z')
  expect(await codeText(page, 1)).toBe(SNIPPET.slice(0, LINE_1_END) + '\n\nz' + SNIPPET.slice(LINE_1_END))
})

test('bold does nothing inside a code block', async ({ page }) => {
  await openSnippet(page)
  await setCaret(page, [1, 0], 3)
  await page.keyboard.press('ControlOrMeta+b')
  await page.keyboard.type('q')
  // Selected text, by keyboard and by the toolbar button.
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('ControlOrMeta+b')
  // The toolbar button follows `can()`: it is disabled here, so it cannot be clicked.
  await expect(page.getByTestId('bold')).toBeDisabled()
  const text = await code(page, 1)
  expect(text).toEqual({ text: 'funqction greet(name) {\n  return `Hello, ${name}!`\n}', marks: [] })
  await expect(page.locator('[data-testid=editor] [data-hte-code-block] strong')).toHaveCount(0)
  await expect(page.getByTestId('bold')).toHaveAttribute('aria-pressed', 'false')
})

test('the Bold toolbar button is disabled inside a code block', async ({ page }) => {
  await openSnippet(page)
  const bold = page.getByTestId('bold')
  await setCaret(page, [0, 0], 3)
  await expect(bold).toBeEnabled()
  await setCaret(page, [1, 0], 3)
  await expect(bold).toBeDisabled()
  // Selected text inside the block too.
  await page.keyboard.press('Shift+ArrowRight')
  await expect.poll(() => getSelection(page)).toMatchObject({ anchor: { path: [1, 0], offset: 3 }, focus: { path: [1, 0], offset: 4 } })
  await expect(bold).toBeDisabled()
  // Back in a paragraph, it is enabled again and still works.
  await setCaret(page, [2, 0], 0)
  await expect(bold).toBeEnabled()
  await page.keyboard.press('Shift+End')
  await bold.click()
  expect(((await getDoc(page)).children[2] as ElementNode).children).toEqual([{ text: 'after', marks: [{ type: 'bold', data: {} }] }])
})

test('Backspace-join of bold text into a code block, then Ctrl+Z restores it', async ({ page }) => {
  await openPlayground(page)
  await page.evaluate(() =>
    window.editor.setContent({
      type: 'doc',
      children: [
        { id: 'c', type: 'codeBlock', data: { language: 'javascript' }, children: [{ text: 'x', marks: [] }] },
        {
          id: 'p',
          type: 'paragraph',
          data: {},
          children: [
            { text: 'a', marks: [] },
            { text: 'b', marks: [{ type: 'bold', data: {} }] },
          ],
        },
      ],
    }),
  )
  await expect.poll(() => types(page)).toEqual(['codeBlock', 'paragraph'])
  const before = await getDoc(page)
  await expect(page.locator('[data-testid=editor] p strong')).toHaveText('b')
  await setCaret(page, [1, 0], 0)
  await page.keyboard.press('Backspace')
  // Joined into the code block, the bold mark normalized away.
  await expect.poll(() => types(page)).toEqual(['codeBlock'])
  expect(await code(page, 0)).toEqual({ text: 'xab', marks: [] })
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => getDoc(page)).toEqual(before)
  await expect(page.locator('[data-testid=editor] p strong')).toHaveText('b')
  await expect(pre(page)).toHaveText('x')
})

test('pasting rich HTML into a code block inserts its plain text', async ({ page }) => {
  await openSnippet(page)
  await setCaret(page, [1, 0], SNIPPET.length)
  const prevented = await page.evaluate(() => {
    const dt = new DataTransfer()
    dt.setData('text/html', '<p><b>bold</b> <span style="font-size:24px">big</span></p><p>second <em>line</em></p>')
    dt.setData('text/plain', 'bold big\nsecond line')
    const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
    window.editor.view!.root.dispatchEvent(e)
    return e.defaultPrevented
  })
  expect(prevented).toBe(true)
  expect(await types(page)).toEqual(['paragraph', 'codeBlock', 'paragraph'])
  expect(await code(page, 1)).toEqual({ text: `${SNIPPET}bold big\nsecond line`, marks: [] })
  await expect(page.locator('[data-testid=editor] [data-hte-code-block] :is(strong, em, [style])')).toHaveCount(0)
  await expect.poll(() => getSelection(page)).toMatchObject({ focus: { path: [1, 0], offset: SNIPPET.length + 20 } })
})

test('multi-line code copied from the block and pasted into a paragraph gives one paragraph per line', async ({ page }) => {
  await openSnippet(page)
  await setCaret(page, [2, 0], 'after'.length)
  await page.keyboard.press('Enter')
  await expect.poll(() => types(page)).toEqual(['paragraph', 'codeBlock', 'paragraph', 'paragraph'])
  await page.evaluate((end) => {
    const editor = window.editor
    const tr = editor.createTransaction()
    tr.setSelection({ ranges: [{ anchor: { path: [1, 0], offset: 0 }, focus: { path: [1, 0], offset: end } }], main: 0 })
    tr.setMeta('addToHistory', false)
    editor.dispatch(tr)
  }, SNIPPET.length)
  expect((await syntheticCopy(page, 'copy')).prevented).toBe(true)
  await setCaret(page, [3, 0], 0)
  expect(await syntheticPaste(page)).toBe(true)
  const lines = SNIPPET.split('\n')
  await expect.poll(() => types(page)).toEqual(['paragraph', 'codeBlock', 'paragraph', ...lines.map(() => 'paragraph')])
  const doc = await getDoc(page)
  expect(doc.children.slice(3).map((b) => textOf(b as ElementNode))).toEqual(lines)
  expect(await codeText(page, 1)).toBe(SNIPPET)
})

test('highlight classes appear and follow the language', async ({ page }) => {
  await openSnippet(page)
  const block = page.locator('[data-testid=editor] [data-hte-code-block]')
  await expect(block.locator('.hljs-keyword').first()).toHaveText('function')
  await expect(block.locator('.hljs-keyword')).toContainText(['function', 'return'])
  await expect(block.locator('.hljs-string')).not.toHaveCount(0)
  await expect(block.locator('code')).toHaveClass('language-javascript')
  // The highlighting is decoration only: the model text is one unmarked text.
  expect(await code(page, 1)).toEqual({ text: SNIPPET, marks: [] })
  await block.getByLabel('Language').selectOption('plaintext')
  await expect.poll(async () => ((await getDoc(page)).children[1] as ElementNode).data.language).toBe('plaintext')
  await expect(block.locator('[class*=hljs-]')).toHaveCount(0)
  await expect(pre(page)).toHaveText(SNIPPET)
  // Typing a keyword in a highlighted block highlights it.
  await block.getByLabel('Language').selectOption('javascript')
  await setCaret(page, [1, 0], SNIPPET.length)
  await page.keyboard.press('Enter')
  await page.keyboard.type('const y = 1')
  await expect(block.locator('.hljs-keyword')).toContainText(['const'])
  await expect(block.locator('.hljs-number')).toContainText(['1'])
})

test.describe('IME composition inside a code block', () => {
  test('mid-code: the text lands at the caret, newlines are kept and the caret follows', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'CDP-only')
    await openSnippet(page)
    await setCaret(page, [1, 0], LINE_1_END)
    await compose(page, ['ê', 'ế'], 'ế')
    const expected = SNIPPET.slice(0, LINE_1_END) + 'ế' + SNIPPET.slice(LINE_1_END)
    await expect.poll(() => codeText(page, 1)).toBe(expected)
    await expect(pre(page)).toHaveText(expected)
    await expect.poll(() => getSelection(page)).toMatchObject({ focus: { path: [1, 0], offset: LINE_1_END + 1 } })
    await page.keyboard.press('Enter')
    await page.keyboard.type('x')
    expect(await codeText(page, 1)).toBe(SNIPPET.slice(0, LINE_1_END) + 'ế\nx' + SNIPPET.slice(LINE_1_END))
  })

  test('on the empty last line after a trailing newline', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'CDP-only')
    await openSnippet(page)
    await setCaret(page, [1, 0], SNIPPET.length)
    await page.keyboard.press('Enter')
    await compose(page, ['n', 'ni', 'nih', '你好'], '你好')
    await expect.poll(() => codeText(page, 1)).toBe(`${SNIPPET}\n你好`)
    await expect(pre(page)).toHaveText(`${SNIPPET}\n你好`)
    await page.keyboard.type('!')
    expect(await codeText(page, 1)).toBe(`${SNIPPET}\n你好!`)
    expect(await types(page)).toEqual(['paragraph', 'codeBlock', 'paragraph'])
  })
})

test.describe('selections across a code block boundary', () => {
  test('Shift+Arrow extends from the paragraph into the code block; typing replaces the range', async ({ page }) => {
    await openSnippet(page)
    await setCaret(page, [0, 0], 'A JS snippet:'.length)
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Shift+ArrowRight')
    await expect
      .poll(() => getSelection(page))
      .toMatchObject({ anchor: { path: [0, 0], offset: 13 }, focus: { path: [1, 0], offset: 1 } })
    await page.keyboard.press('Shift+ArrowLeft')
    await page.keyboard.press('Shift+ArrowLeft')
    await page.keyboard.press('Shift+ArrowLeft')
    await expect
      .poll(() => getSelection(page))
      .toMatchObject({ anchor: { path: [0, 0], offset: 13 }, focus: { path: [0, 0], offset: 12 } })
  })

  test('Shift+ArrowUp from the code block into the paragraph, then Backspace', async ({ page }) => {
    await openSnippet(page)
    await setCaret(page, [1, 0], 3)
    await page.keyboard.press('Shift+ArrowUp')
    await expect.poll(async () => (await getSelection(page))?.focus.path).toEqual([0, 0])
    const sel = (await getSelection(page))!
    expect(sel.anchor).toEqual({ path: [1, 0], offset: 3 })
    // Where ArrowUp lands in the paragraph depends on the font metrics: read it.
    const k = sel.focus.offset
    expect(k).toBeGreaterThan(0)
    expect(k).toBeLessThan('A JS snippet:'.length)
    await page.keyboard.press('Backspace')
    // The range is removed and the rest of the code block joins the paragraph, the caret at the join;
    // the code's other lines become paragraphs of their own (see the next test).
    await expect.poll(() => types(page)).toEqual(['paragraph', 'paragraph', 'paragraph', 'paragraph'])
    await expect.poll(() => getSelection(page)).toMatchObject({ focus: { path: [0, 0], offset: k } })
    await page.keyboard.type('W')
    const texts = (await getDoc(page)).children.map((b) => textOf(b as ElementNode))
    expect(texts).toEqual([`${'A JS snippet:'.slice(0, k)}Wction greet(name) {`, '  return `Hello, ${name}!`', '}', 'after'])
    await expect.poll(() => getSelection(page)).toMatchObject({ focus: { path: [0, 0], offset: k + 1 } })
  })

  // A non-code block never holds `\n` (the HTML parser collapses it outside <pre>, so it would not
  // round-trip): normalization splits the joined paragraph at each newline.
  test('joining a code block into a paragraph leaves no newline in a non-code block', async ({ page }) => {
    await openSnippet(page)
    await setCaret(page, [1, 0], 3)
    await page.keyboard.press('Shift+ArrowUp')
    await expect.poll(async () => (await getSelection(page))?.focus.path).toEqual([0, 0])
    await page.keyboard.press('Backspace')
    await expect.poll(() => types(page)).not.toContain('codeBlock')
    const blocks = (await getDoc(page)).children as ElementNode[]
    const withNewline = blocks.filter((b) => b.type !== 'codeBlock' && textOf(b).includes('\n')).map((b) => b.id)
    expect(withNewline).toEqual([])
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph', 'paragraph', 'paragraph'])
  })

  test('Ctrl+A in the code block selects the document; typing replaces everything', async ({ page }) => {
    await openSnippet(page)
    await setCaret(page, [1, 0], 5)
    await page.keyboard.press('ControlOrMeta+a')
    await expect
      .poll(() => getSelection(page))
      .toMatchObject({ anchor: { path: [0, 0], offset: 0 }, focus: { path: [2, 0], offset: 5 } })
    await page.keyboard.type('x')
    const doc = await getDoc(page)
    expect(doc.children).toHaveLength(1)
    expect(((doc.children[0] as ElementNode).children![0] as TextNode).text).toBe('x')
    await expect(page.getByTestId('editor')).toHaveText('x')
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(() => types(page)).toEqual(['paragraph', 'codeBlock', 'paragraph'])
    expect(await codeText(page, 1)).toBe(SNIPPET)
  })
})
