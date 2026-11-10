import { expect, test, type Page } from '@playwright/test'
import { openPlayground } from './helpers'

/*
 * The playground has no atom plugin with a node view yet, so these tests build a second editor on
 * the page from the playground's own Editor class and plugins, with a minimal atom plugin whose node
 * view holds an alt `<input data-editor-ignore>` committed through `updateData`.
 */

let errors: string[]

test.beforeEach(async ({ page }) => {
  errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await openPlayground(page)
  await page.evaluate(() => {
    const base = window.editor
    const plugins = base.registry.plugins.filter((p) => p.name === 'paragraph' || p.name === 'bold')
    const atomSpec = { name: 'figure', node: { kind: 'block', atom: true } }
    const atom = { name: 'figure', spec: atomSpec, configure: () => atom, extend: () => atom }
    const EditorClass = base.constructor as new (options: unknown) => typeof base
    const el = document.createElement('div')
    el.setAttribute('data-testid', 'nv-editor')
    el.style.cssText = 'padding:8px;border:1px solid #ccc;white-space:pre-wrap'
    document.body.appendChild(el)
    const editor = new EditorClass({
      plugins: [...plugins, atom],
      content: {
        type: 'doc',
        children: [
          { id: 'p1', type: 'paragraph', data: {}, children: [{ text: 'before', marks: [] }] },
          { id: 'fig', type: 'figure', data: { alt: '' }, children: [] },
          { id: 'p2', type: 'paragraph', data: {}, children: [{ text: 'after', marks: [] }] },
        ],
      },
      nodeViews: {
        figure: (container: HTMLElement, props: { node: { data: { alt: string } }; updateData(d: object): boolean }) => {
          const label = document.createElement('span')
          label.textContent = 'figure'
          label.setAttribute('data-testid', 'nv-label')
          const input = document.createElement('input')
          input.setAttribute('data-editor-ignore', '')
          input.setAttribute('data-testid', 'nv-alt')
          input.value = props.node.data.alt
          input.addEventListener('input', () => props.updateData({ alt: input.value }))
          container.append(label, input)
          return { update: () => {}, destroy: () => {} }
        },
      },
    })
    editor.mount(el)
    ;(window as unknown as { nvEditor: typeof base }).nvEditor = editor
  })
})

test.afterEach(() => {
  expect(errors).toEqual([])
})

function nvState(page: Page) {
  return page.evaluate(() => {
    const editor = (window as unknown as { nvEditor: typeof window.editor }).nvEditor
    return { doc: editor.getJSON(), selection: editor.state.selection }
  })
}

test('typing in the alt input reaches the input and commits through updateData', async ({ page }) => {
  const before = await nvState(page)
  const input = page.getByTestId('nv-alt')
  await input.click()
  await page.keyboard.type('a cat')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.type('X')
  await expect(input).toHaveValue('a cXa')
  await expect(input).toBeFocused()
  const after = await nvState(page)
  expect(after.doc.children[1]!.data).toEqual({ alt: 'a cXa' })
  // The paragraphs are untouched and the model selection did not move.
  expect(after.doc.children[0]).toEqual(before.doc.children[0])
  expect(after.doc.children[2]).toEqual(before.doc.children[2])
  expect(after.selection).toEqual(before.selection)
  await expect(page.getByTestId('nv-label')).toHaveText('figure')
})

test('clicking the node view outside the input node-selects it', async ({ page }) => {
  await page.getByTestId('nv-label').click()
  const { selection } = await nvState(page)
  expect(selection?.ranges[0]?.node).toEqual([1])
  await expect(page.locator('[data-testid=nv-editor] [data-penline-node-view]')).toHaveAttribute('data-penline-selected', '')
  await page.keyboard.press('Backspace')
  const { doc } = await nvState(page)
  expect(doc.children.map((b) => b.type)).toEqual(['paragraph', 'paragraph'])
})
