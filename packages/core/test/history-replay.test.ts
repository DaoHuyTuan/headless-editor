import { describe, expect, it, vi } from 'vitest'
import { historyPlugin } from '../src/history'
import { definePlugin, findPathById } from '../src/index'
import * as apply from '../src/ops/apply'
import type { ElementNode, Node } from '../src/model/types'
import { createTestEditor, doc, el, sel, txt } from '../src/testing/index'
import { testParagraph } from './fixtures'

vi.mock('../src/ops/apply', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/ops/apply')>()
  return { ...mod, applyOp: vi.fn(mod.applyOp) }
})

const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))
const img = definePlugin({ name: 'img', node: { kind: 'block', atom: true } })

describe('history skips the set_node_data replay when the stacks hold none', () => {
  it('a data-only outside tr does not replay stacks without set_node_data ops', () => {
    const ed = createTestEditor({
      plugins: [testParagraph, img, historyPlugin.configure({ now: () => 0 })],
      history: false,
      doc: doc(p('ab')),
      selection: sel([0, 0], 2),
    })
    const node = el('img', { src: 'blob:1' })
    const tr = ed.createTransaction()
    tr.meta.origin = 'command'
    tr.insertBlockNode(node)
    ed.dispatch(tr)
    const outside = ed.createTransaction()
    outside.meta.origin = 'plugin'
    outside.meta.addToHistory = false
    outside.setNodeData(findPathById(ed.state.doc, node.id)!, { src: 'https://x/1.png' })
    // Only the data op itself is applied (by the transaction); no replay of the stacks.
    vi.mocked(apply.applyOp).mockClear()
    ed.dispatch(outside)
    expect(vi.mocked(apply.applyOp)).not.toHaveBeenCalled()
    // The rewrite still happened.
    ed.commands.undo()
    ed.commands.redo()
    expect(JSON.stringify(ed.getJSON())).toContain('https://x/1.png')
  })
})
