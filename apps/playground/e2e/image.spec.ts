import { deflateSync } from 'node:zlib'
import { expect, test, type Page } from '@playwright/test'
import type { Doc, ElementNode } from '@hte/core'
import { focusEnd, getDoc, getSelection, getText, openPlayground } from './helpers'

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A valid 1×1 RGBA PNG, generated (one blue pixel). */
function makePng(): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0) // width
  ihdr.writeUInt32BE(1, 4) // height
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  const scanline = Buffer.from([0, 0x4a, 0x7d, 0xff, 0xff]) // filter byte + one pixel
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(scanline)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const PNG = makePng()
const PNG_BASE64 = PNG.toString('base64')
const png = () => PNG

test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

let errors: string[]

function trackErrors(page: Page): void {
  errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
}

test.afterEach(() => {
  expect(errors).toEqual([])
})

const images = (doc: Doc) => doc.children.filter((b) => b.type === 'image') as ElementNode[]
const types = async (page: Page) => (await getDoc(page)).children.map((b) => b.type)
const srcOf = async (page: Page, index = 0) => images(await getDoc(page))[index]?.data.src as string | undefined

/** Opens the `image` scenario: `before`, an image (id `img`), `after`. */
async function openImageScenario(page: Page): Promise<void> {
  trackErrors(page)
  await openPlayground(page)
  await page.getByTestId('scenario').selectOption('image')
  await expect.poll(() => types(page)).toEqual(['paragraph', 'image', 'paragraph'])
}

/** Puts a collapsed caret at `path` / `offset` through the editor API and focuses the editor. */
async function caret(page: Page, path: number[], offset: number): Promise<void> {
  await page.evaluate(
    ([path, offset]) => {
      const editor = window.editor
      const point = { path, offset }
      const tr = editor.createTransaction()
      tr.setSelection({ anchor: point, focus: point }).setMeta('addToHistory', false)
      editor.dispatch(tr)
      editor.view!.focus()
    },
    [path, offset] as const,
  )
}

const editorImg = (page: Page) => page.locator('[data-testid=editor] img')

test.describe('inserting', () => {
  test('the file input inserts an image that is uploaded; undo and redo keep the uploaded src', async ({ page }) => {
    trackErrors(page)
    await openPlayground(page)
    await focusEnd(page)
    await page.keyboard.type('text')
    await page.getByTestId('image-file').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: png() })

    await expect(editorImg(page)).toHaveCount(1)
    // An atom inserted last gets an empty paragraph after it, for the caret.
    expect(await types(page)).toEqual(['paragraph', 'image', 'paragraph'])
    expect(await srcOf(page)).toMatch(/^blob:/)
    await expect.poll(() => srcOf(page)).toMatch(/#uploaded$/)
    await page.evaluate(() => window.editor.storage.image.whenIdle())
    expect(await page.evaluate(() => window.editor.storage.image.isUploading())).toBe(false)
    await expect(editorImg(page)).toHaveAttribute('src', /#uploaded$/)
    // The generated png is valid: the uploaded URL decodes to a 1×1 picture.
    await expect.poll(() => editorImg(page).evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(1)

    await page.getByTestId('undo').click()
    expect(await types(page)).toEqual(['paragraph'])
    await expect(editorImg(page)).toHaveCount(0)
    expect(await getText(page)).toBe('text')

    await page.getByTestId('redo').click()
    expect(await types(page)).toEqual(['paragraph', 'image', 'paragraph'])
    expect(await srcOf(page)).toMatch(/#uploaded$/)
    await expect(editorImg(page)).toHaveAttribute('src', /#uploaded$/)
  })

  test('pasting a png and a pdf file inserts exactly one image and ignores the text flavour', async ({ page }) => {
    trackErrors(page)
    await openPlayground(page)
    await focusEnd(page)
    const prevented = await page.evaluate((b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], 'pixel.png', { type: 'image/png' }))
      dt.items.add(new File(['%PDF-1.4'], 'doc.pdf', { type: 'application/pdf' }))
      dt.setData('text/plain', 'ignored text')
      const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      window.editor.view!.root.dispatchEvent(e)
      return e.defaultPrevented
    }, PNG_BASE64)
    expect(prevented).toBe(true)
    await expect(editorImg(page)).toHaveCount(1)
    expect(images(await getDoc(page))).toHaveLength(1)
    expect(await getText(page)).not.toContain('ignored')
    await page.evaluate(() => window.editor.storage.image.whenIdle())
    expect(await srcOf(page)).toMatch(/#uploaded$/)
  })

  test('dropping a png inside the second paragraph splits it and inserts the image there', async ({ page }) => {
    await openImageScenario(page)
    const prevented = await page.evaluate((b64) => {
      const editor = window.editor
      // Between "af" and "ter" in the second paragraph.
      const p = editor.view!.root.querySelectorAll('p')[1]!
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
      let text: Text | null = null
      while (walker.nextNode()) text = walker.currentNode as Text
      const range = document.createRange()
      range.setStart(text!, 2)
      range.collapse(true)
      const rect = range.getBoundingClientRect()
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }))
      const init = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.top + rect.height / 2 }
      p.dispatchEvent(new DragEvent('dragover', init))
      const e = new DragEvent('drop', init)
      p.dispatchEvent(e)
      return e.defaultPrevented
    }, PNG_BASE64)
    expect(prevented).toBe(true)
    await expect(editorImg(page)).toHaveCount(2)
    expect(await types(page)).toEqual(['paragraph', 'image', 'paragraph', 'image', 'paragraph'])
    expect(await getText(page)).toBe('before\n\naf\n\nter')
    await page.evaluate(() => window.editor.storage.image.whenIdle())
    expect(await srcOf(page, 1)).toMatch(/#uploaded$/)
    // The scenario's image is untouched.
    expect(await srcOf(page, 0)).toMatch(/^data:image\/png;base64,/)
  })

  test('a failed upload (?uploadFail=1) removes the image without throwing', async ({ page }) => {
    trackErrors(page)
    await openPlayground(page, '/?uploadFail=1')
    await focusEnd(page)
    await page.keyboard.type('text')
    await page.getByTestId('image-file').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: png() })
    await expect(editorImg(page)).toHaveCount(1)
    await page.evaluate(() => window.editor.storage.image.whenIdle())
    await expect(editorImg(page)).toHaveCount(0)
    // Only the image is removed; the paragraph inserted after it for the caret stays.
    expect(await types(page)).toEqual(['paragraph', 'paragraph'])
    expect(await getText(page)).toBe('text\n')
    // Undo does not bring the dead preview back.
    await page.getByTestId('undo').click()
    expect(images(await getDoc(page))).toHaveLength(0)
  })
})

test.describe('the image scenario', () => {
  test.beforeEach(async ({ page }) => {
    await openImageScenario(page)
  })

  test('clicking the image node-selects it', async ({ page }) => {
    await editorImg(page).click()
    expect((await getSelection(page))?.node).toEqual([1])
    await expect(page.locator('[data-testid=editor] [data-hte-node-view]')).toHaveAttribute('data-hte-selected', '')
  })

  test('Backspace removes the selected image', async ({ page }) => {
    await editorImg(page).click()
    await page.keyboard.press('Backspace')
    expect(await types(page)).toEqual(['paragraph', 'paragraph'])
    await expect(editorImg(page)).toHaveCount(0)
    expect(await getText(page)).toBe('before\nafter')
  })

  test('Backspace at the start of the following paragraph selects the image', async ({ page }) => {
    await caret(page, [2, 0], 0)
    await page.keyboard.press('Backspace')
    expect((await getSelection(page))?.node).toEqual([1])
    expect(await types(page)).toEqual(['paragraph', 'image', 'paragraph'])
    await expect(page.locator('[data-testid=editor] [data-hte-node-view]')).toHaveAttribute('data-hte-selected', '')
  })

  test('typing while the image is selected replaces it with a paragraph of the typed text', async ({ page }) => {
    await editorImg(page).click()
    await page.keyboard.type('xy')
    expect(await types(page)).toEqual(['paragraph', 'paragraph', 'paragraph'])
    expect(await getText(page)).toBe('before\nxy\nafter')
    const sel = await getSelection(page)
    expect(sel?.node).toBeUndefined()
    expect(sel?.focus).toEqual({ path: [1, 0], offset: 2 })
    await expect(page.locator('[data-testid=editor] p')).toHaveText(['before', 'xy', 'after'])
  })

  test('typing alt text then tabbing away commits the alt; the text is unchanged', async ({ page }) => {
    const before = await getText(page)
    const alt = page.getByLabel('Alt text')
    await alt.click()
    await page.keyboard.type('Cat')
    await expect(alt).toHaveValue('Cat')
    await page.keyboard.press('Tab')
    await expect.poll(async () => images(await getDoc(page))[0]?.data.alt).toBe('Cat')
    expect(await getText(page)).toBe(before)
    expect(await types(page)).toEqual(['paragraph', 'image', 'paragraph'])
    await expect(editorImg(page)).toHaveAttribute('alt', 'Cat')
  })

  test('dragging the resize handle by +40px increases the width', async ({ page }) => {
    const start = (await editorImg(page).boundingBox())!.width
    const handle = page.locator('[data-testid=editor] .hte-image-resize')
    const box = (await handle.boundingBox())!
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 20, y, { steps: 4 })
    await page.mouse.move(x + 40, y, { steps: 4 })
    await page.mouse.up()
    const width = images(await getDoc(page))[0]?.data.width as number
    expect(width).toBeGreaterThan(start)
    expect(width).toBe(Math.round(start + 40))
    await expect(editorImg(page)).toHaveAttribute('width', String(width))
  })

  test('copying a selected image and pasting it elsewhere adds a second image with a fresh id', async ({ page }) => {
    await editorImg(page).click()
    await page.keyboard.press('ControlOrMeta+c')
    await caret(page, [2, 0], 'after'.length)
    await page.keyboard.press('ControlOrMeta+v')
    await expect(editorImg(page)).toHaveCount(2)
    const doc = await getDoc(page)
    expect(doc.children.map((b) => b.type)).toEqual(['paragraph', 'image', 'paragraph', 'image', 'paragraph'])
    const [first, second] = images(doc)
    expect(second!.id).not.toBe(first!.id)
    expect(second!.data).toEqual(first!.data)
  })

  test('cutting a selected image removes it; pasting puts it back', async ({ page }) => {
    await editorImg(page).click()
    await page.keyboard.press('ControlOrMeta+x')
    await expect(editorImg(page)).toHaveCount(0)
    expect(await types(page)).toEqual(['paragraph', 'paragraph'])
    await caret(page, [1, 0], 'after'.length)
    await page.keyboard.press('ControlOrMeta+v')
    await expect(editorImg(page)).toHaveCount(1)
    expect(await types(page)).toEqual(['paragraph', 'paragraph', 'image', 'paragraph'])
  })
})
