// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { createSelection, mainRange } from '@hte/core'
import { definePlugin, serializeForClipboard, type Doc, type ElementNode, type Node, type Selection, type TextNode } from '@hte/core'
import { createTestEditor, doc, el, sel, stripIds, txt } from '@hte/core/testing'
import { bold } from '@hte/bold'
import { mention } from '@hte/mention'
import { paragraph } from '@hte/paragraph'
import { codeBlock, defaultHighlighter } from '../src/index'

const p = (...children: Node[]) => el('paragraph', ...children)
const code = (text: string, language = 'plaintext') => el('codeBlock', { language }, txt(text))
const caret = (path: number[], offset: number): Selection => sel(path, offset)
const mentionNode = (): ElementNode => ({ id: 'm1', type: 'mention', data: { userId: 'u1', label: 'Ann' }, children: [] })

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

function setup(content: Doc, selection: Selection, plugin = codeBlock) {
  return createTestEditor({
    plugins: [paragraph, bold, mention.configure({ fetchUsers: async () => [] }), plugin],
    doc: content,
    selection,
  })
}

type Ed = ReturnType<typeof setup>

const blocks = (ed: Ed) =>
  ed.state.doc.children.map((b) => ({
    type: b.type,
    text: (b.children ?? []).map((c) => ('text' in c ? c.text : `<${c.type}>`)).join(''),
  }))

/** Pastes clipboard flavors at the current selection through the paste intent. */
function paste(ed: Ed, data: Record<string, string>) {
  const dataTransfer = { getData: (type: string) => data[type] ?? '' } as unknown as DataTransfer
  return ed.handleIntent({ inputType: 'insertFromPaste', data: null, range: ed.state.selection && mainRange(ed.state.selection), dataTransfer })
}

/** Drops HTML at `at` (the drop point) through the drop intent; the selection stays where it is. */
function drop(ed: Ed, at: Selection, html: string) {
  const dataTransfer = { getData: (type: string) => (type === 'text/html' ? html : '') } as unknown as DataTransfer
  return ed.handleIntent({ inputType: 'insertFromDrop', data: null, range: mainRange(at), dataTransfer })
}

describe('code block keymap', () => {
  it('Tab inserts two spaces at the caret', () => {
    const ed = setup(doc(code('ab')), caret([0, 0], 1))
    expect(ed.runKeymap('Tab')).toBe(true)
    expect(blocks(ed)).toEqual([{ type: 'codeBlock', text: 'a  b' }])
    expect(ed.state.selection).toEqual(caret([0, 0], 3))
  })

  it('Tab with a selection spanning lines indents each line', () => {
    const ed = setup(doc(code('a\nb\nc')), sel([0, 0], 0, [0, 0], 3))
    expect(ed.runKeymap('Tab')).toBe(true)
    expect(blocks(ed)).toEqual([{ type: 'codeBlock', text: '  a\n  b\nc' }])
    expect(ed.state.selection).toEqual(sel([0, 0], 2, [0, 0], 7))
  })

  it('Shift-Tab removes up to two leading spaces from each selected line', () => {
    const ed = setup(doc(code('   a\n b\nc\n  d')), sel([0, 0], 4, [0, 0], 9))
    expect(ed.runKeymap('Shift-Tab')).toBe(true)
    expect(blocks(ed)).toEqual([{ type: 'codeBlock', text: ' a\nb\nc\n  d' }])
  })

  it('Shift-Tab with a caret dedents its line', () => {
    const ed = setup(doc(code('x\n    y')), caret([0, 0], 7))
    expect(ed.runKeymap('Shift-Tab')).toBe(true)
    expect(blocks(ed)).toEqual([{ type: 'codeBlock', text: 'x\n  y' }])
    expect(ed.state.selection).toEqual(caret([0, 0], 5))
  })

  it('Enter inserts a newline', () => {
    const ed = setup(doc(code('ab')), caret([0, 0], 1))
    expect(ed.runKeymap('Enter')).toBe(true)
    expect(blocks(ed)).toEqual([{ type: 'codeBlock', text: 'a\nb' }])
    expect(ed.state.selection).toEqual(caret([0, 0], 2))
  })

  it('Enter three times at the end exits to a new paragraph, removing the two trailing newlines', () => {
    const ed = setup(doc(code('a')), caret([0, 0], 1))
    ed.runKeymap('Enter')
    ed.runKeymap('Enter')
    expect(blocks(ed)).toEqual([{ type: 'codeBlock', text: 'a\n\n' }])
    expect(ed.runKeymap('Enter')).toBe(true)
    expect(blocks(ed)).toEqual([
      { type: 'codeBlock', text: 'a' },
      { type: 'paragraph', text: '' },
    ])
    expect(ed.state.selection).toEqual(caret([1, 0], 0))
  })

  it('Enter with two trailing newlines but the caret not at the end inserts a newline', () => {
    const ed = setup(doc(code('a\n\n')), caret([0, 0], 1))
    ed.runKeymap('Enter')
    expect(blocks(ed)).toEqual([{ type: 'codeBlock', text: 'a\n\n\n' }])
  })

  it('outside a code block the keys are left to the editor', () => {
    const ed = setup(doc(p(txt('ab'))), caret([0, 0], 1))
    for (const key of ['Tab', 'Shift-Tab', 'Enter', 'Shift-Enter', 'Mod-Enter', 'Backspace'])
      expect(ed.runKeymap(key)).toBe(false)
    expect(blocks(ed)).toEqual([{ type: 'paragraph', text: 'ab' }])
  })

  it('Shift-Enter inserts a newline (never exits)', () => {
    const ed = setup(doc(code('a\n\n')), caret([0, 0], 3))
    expect(ed.runKeymap('Shift-Enter')).toBe(true)
    expect(blocks(ed)).toEqual([{ type: 'codeBlock', text: 'a\n\n\n' }])
    expect(ed.state.selection).toEqual(caret([0, 0], 4))
  })

  it('a key whose tr another plugin vetoes reports not handled', () => {
    const veto = definePlugin({ name: 'veto', filterTransaction: (tr) => !tr.ops.some((o) => o.type === 'insert_text') })
    const ed = createTestEditor({ plugins: [paragraph, codeBlock, veto], doc: doc(code('ab')), selection: caret([0, 0], 1) })
    expect(ed.runKeymap('Tab')).toBe(false)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(code('ab'))))
  })

  it('Backspace at the start of an empty code block turns it into a paragraph', () => {
    const ed = setup(doc(p(txt('x')), code('')), caret([1, 0], 0))
    expect(ed.runKeymap('Backspace')).toBe(true)
    expect(blocks(ed)).toEqual([
      { type: 'paragraph', text: 'x' },
      { type: 'paragraph', text: '' },
    ])
    expect(ed.state.selection).toEqual(caret([1, 0], 0))
  })

  it('Backspace at the start of a code block after a paragraph joins it as one paragraph per line', () => {
    const ed = setup(doc(p(txt('p')), code('a\nb')), caret([1, 0], 0))
    ed.handleIntent({ inputType: 'deleteContentBackward', data: null, range: ed.state.selection && mainRange(ed.state.selection) })
    expect(blocks(ed)).toEqual([
      { type: 'paragraph', text: 'pa' },
      { type: 'paragraph', text: 'b' },
    ])
    expect(ed.getHTML()).toBe('<p>pa</p><p>b</p>')
  })

  it('a range delete from a paragraph into a code block keeps the remaining lines as paragraphs', () => {
    const ed = setup(doc(p(txt('pq')), code('a\nb')), sel([0, 0], 1, [1, 0], 1))
    ed.handleIntent({ inputType: 'deleteContentBackward', data: null, range: ed.state.selection && mainRange(ed.state.selection) })
    expect(ed.getHTML()).toBe('<p>p</p><p>b</p>')
  })

  it('Backspace in a non-empty code block is left to the editor', () => {
    const ed = setup(doc(code('ab')), caret([0, 0], 0))
    expect(ed.runKeymap('Backspace')).toBe(false)
  })

  it('Mod-Enter exits the code block to a new paragraph after it', () => {
    const ed = setup(doc(code('a\nb'), p(txt('z'))), caret([0, 0], 1))
    expect(ed.runKeymap('Mod-Enter')).toBe(true)
    expect(blocks(ed)).toEqual([
      { type: 'codeBlock', text: 'a\nb' },
      { type: 'paragraph', text: '' },
      { type: 'paragraph', text: 'z' },
    ])
    expect(ed.state.selection).toEqual(caret([1, 0], 0))
  })
})

describe('code block line-break intents (beforeinput without keydown)', () => {
  const intent = (ed: Ed, inputType: string) => ed.handleIntent({ inputType, data: null, range: ed.state.selection && mainRange(ed.state.selection) })

  for (const inputType of ['insertParagraph', 'insertLineBreak']) {
    it(`${inputType} inserts a newline instead of splitting the block`, () => {
      const ed = setup(doc(code('ab')), caret([0, 0], 1))
      expect(intent(ed, inputType)).toBe(true)
      expect(blocks(ed)).toEqual([{ type: 'codeBlock', text: 'a\nb' }])
      expect(ed.state.selection).toEqual(caret([0, 0], 2))
    })

    it(`${inputType} at the end after two newlines exits like Enter`, () => {
      const ed = setup(doc(code('a\n\n')), caret([0, 0], 3))
      expect(intent(ed, inputType)).toBe(true)
      expect(blocks(ed)).toEqual([
        { type: 'codeBlock', text: 'a' },
        { type: 'paragraph', text: '' },
      ])
    })
  }

  it('a vetoed newline in a code block is still consumed: the core does not split the block', () => {
    const veto = definePlugin({ name: 'veto', filterTransaction: (tr) => tr.meta.origin !== 'command' })
    const vetoed = createTestEditor({
      plugins: [paragraph, bold, codeBlock, veto],
      doc: doc(code('ab')),
      selection: caret([0, 0], 1),
    })
    expect(intent(vetoed as unknown as Ed, 'insertParagraph')).toBe(true)
    expect(blocks(vetoed as unknown as Ed)).toEqual([{ type: 'codeBlock', text: 'ab' }])
  })

  it('outside a code block the intent is left to the core (splits the paragraph)', () => {
    const ed = setup(doc(p(txt('ab'))), caret([0, 0], 1))
    intent(ed, 'insertParagraph')
    expect(blocks(ed)).toEqual([
      { type: 'paragraph', text: 'a' },
      { type: 'paragraph', text: 'b' },
    ])
  })
})

describe('code block commands', () => {
  it('setCodeBlock replaces the paragraph with a code block, keeping the text and the caret', () => {
    const ed = setup(doc(p(txt('x')), p(txt('hello'))), caret([1, 0], 2))
    expect(ed.commands.setCodeBlock('javascript')).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p(txt('x')), code('hello', 'javascript'))))
    expect(ed.state.selection).toEqual(caret([1, 0], 2))
    expect(ed.isActive('codeBlock')).toBe(true)
    // One undo restores the paragraph.
    ed.commands.undo()
    expect(blocks(ed)).toEqual([
      { type: 'paragraph', text: 'x' },
      { type: 'paragraph', text: 'hello' },
    ])
  })

  it('setCodeBlock keeps a selection and defaults the language to plaintext', () => {
    const ed = setup(doc(p(txt('a', 'bold'), txt('bc'))), sel([0, 0], 0, [0, 1], 1))
    expect(ed.commands.setCodeBlock()).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(code('abc'))))
    expect(ed.state.selection).toEqual(sel([0, 0], 0, [0, 0], 2))
  })

  it('setCodeBlock keeps a mention as its text (@label), with the caret after it mapped', () => {
    const ed = setup(doc(p(txt('hi '), mentionNode(), txt(' yo'))), caret([0, 2], 1))
    expect(ed.commands.setCodeBlock()).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(code('hi @Ann yo'))))
    expect(ed.state.selection).toEqual(caret([0, 0], 8))
  })

  it('setCodeBlock is false inside a code block or with an unsafe language', () => {
    expect(setup(doc(code('a')), caret([0, 0], 0)).commands.setCodeBlock()).toBe(false)
    const ed = setup(doc(p(txt('a'))), caret([0, 0], 0))
    expect(ed.commands.setCodeBlock('js" onclick="x')).toBe(false)
    expect(blocks(ed)).toEqual([{ type: 'paragraph', text: 'a' }])
  })

  it('setLanguage changes the language; an unsafe one is rejected by the schema', () => {
    const ed = setup(doc(code('a')), caret([0, 0], 0))
    expect(ed.commands.setLanguage('python')).toBe(true)
    expect(ed.state.doc.children[0]!.data).toEqual({ language: 'python' })
    expect(ed.commands.setLanguage('x"><script>')).toBe(false)
    expect(ed.state.doc.children[0]!.data).toEqual({ language: 'python' })
    expect(setup(doc(p(txt('a'))), caret([0, 0], 0)).commands.setLanguage('python')).toBe(false)
  })

  it('loading a code block with an unsafe language keeps the code as plaintext', () => {
    const ed = setup(doc(code('a', 'a b"')), caret([0, 0], 0))
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(code('a'))))
  })
})

describe('code block blocks marks and inline nodes', () => {
  it('toggleBold inside returns false and no mark persists', () => {
    const ed = setup(doc(code('abc')), sel([0, 0], 0, [0, 0], 2))
    expect(ed.commands.toggleBold()).toBe(false)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(code('abc'))))
    expect(ed.isActive('bold')).toBe(false)
    // A caret: no stored mark either.
    const atCaret = setup(doc(code('abc')), caret([0, 0], 1))
    expect(atCaret.commands.toggleBold()).toBe(false)
    expect(atCaret.state.storedMarks).toBeNull()
    expect(atCaret.isActive('bold')).toBe(false)
    atCaret.commands.insertText('x')
    expect(stripIds(atCaret.getJSON())).toEqual(stripIds(doc(code('axbc'))))
  })

  it('a raw add_mark on a code block text is filtered out', () => {
    const ed = setup(doc(code('abc')), caret([0, 0], 1))
    const tr = ed.createTransaction()
    tr.apply({ type: 'add_mark', path: [0, 0], mark: { type: 'bold', data: {} } })
    ed.dispatch(tr)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(code('abc'))))
  })

  it('insertMention inside is rejected', () => {
    const ed = setup(doc(code('abc')), caret([0, 0], 1))
    expect(ed.commands.insertMention({ id: 'u1', label: 'Ann' })).toBe(false)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(code('abc'))))
  })

  it('a raw insert of an inline element into a code block is filtered out', () => {
    const ed = setup(doc(code('abc')), caret([0, 0], 1))
    const tr = ed.createTransaction()
    tr.insertNode([0, 1], { id: 'm1', type: 'mention', data: { userId: 'u1', label: 'Ann' }, children: [] })
    ed.dispatch(tr)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(code('abc'))))
  })

  it('a selection over a paragraph and a code block bolds the paragraph part only', () => {
    const ed = setup(doc(p(txt('ab')), code('cd')), sel([0, 0], 0, [1, 0], 2))
    expect(ed.commands.toggleBold()).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p(txt('ab', 'bold')), code('cd'))))
  })

  it('can().toggleBold() is false inside a code block', () => {
    const ed = setup(doc(code('abc')), sel([0, 0], 0, [0, 0], 2))
    expect(ed.can().toggleBold()).toBe(false)
    const atCaret = setup(doc(code('abc')), caret([0, 0], 1))
    expect(atCaret.can().toggleBold()).toBe(false)
    expect(atCaret.state.storedMarks).toBeNull()
  })

  it('can().toggleBold() is true in a paragraph', () => {
    const ed = setup(doc(p(txt('ab')), code('c')), sel([0, 0], 0, [0, 0], 2))
    const before = ed.state
    expect(ed.can().toggleBold()).toBe(true)
    expect(ed.state).toBe(before)
  })

  it('bold still works outside the code block', () => {
    const ed = setup(doc(p(txt('ab')), code('c')), sel([0, 0], 0, [0, 0], 2))
    expect(ed.commands.toggleBold()).toBe(true)
    expect(ed.isActive('bold')).toBe(true)
  })
})

describe('undo after normalizing into a code block', () => {
  const join = (inline: Node) => {
    const ed = setup(doc(code('x'), p(txt('a'), inline)), caret([1, 0], 0))
    const before = stripIds(ed.getJSON())
    // Backspace at the paragraph start: the keymap passes (not in a code block), the intent joins.
    expect(ed.runKeymap('Backspace')).toBe(false)
    expect(ed.handleIntent({ inputType: 'deleteContentBackward', data: null, range: ed.state.selection && mainRange(ed.state.selection) })).toBe(true)
    expect(ed.state.doc.children).toHaveLength(1)
    return { ed, before }
  }

  it('undoes a Backspace-join of a paragraph with bold text', () => {
    const { ed, before } = join(txt('b', 'bold'))
    expect(ed.commands.undo()).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(before)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(code('x'), p(txt('a'), txt('b', 'bold')))))
  })

  it('undoes a Backspace-join of a paragraph with a mention', () => {
    const { ed, before } = join(mentionNode())
    expect(ed.commands.undo()).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(before)
    const restored = ed.state.doc.children[1]!.children!.find((c) => 'type' in c && c.type === 'mention') as ElementNode
    expect(restored.data).toEqual({ userId: 'u1', label: 'Ann' })
  })

  it('redo re-applies the join', () => {
    const { ed } = join(txt('b', 'bold'))
    const joined = stripIds(ed.getJSON())
    expect(ed.commands.undo()).toBe(true)
    expect(ed.commands.redo()).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(joined)
    expect(blocks(ed)).toEqual([{ type: 'codeBlock', text: 'xab' }])
  })
})

describe('code block paste', () => {
  it('rich HTML pasted inside becomes plain text with its newlines', () => {
    const ed = setup(doc(code('')), caret([0, 0], 0))
    paste(ed, { 'text/html': '<p>a<b>b</b></p><p>c</p>' })
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(code('ab\nc'))))
    expect(ed.state.selection).toEqual(caret([0, 0], 4))
  })

  it('a mention in pasted HTML keeps its text (@label) inside a code block', () => {
    const ed = setup(doc(code('ab')), caret([0, 0], 1))
    paste(ed, { 'text/html': '<p>hi <span data-mention data-id="u1">@Ann</span> x</p>' })
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(code('ahi @Ann xb'))))
  })

  it('Backspace joining a paragraph with a mention into a code block keeps the mention as text', () => {
    const ed = setup(doc(code('x'), p(txt('hi '), mentionNode(), txt(' yo'))), caret([1, 0], 0))
    ed.handleIntent({ inputType: 'deleteContentBackward', data: null, range: ed.state.selection && mainRange(ed.state.selection) })
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(code('xhi @Ann yo'))))
    expect(ed.state.selection).toEqual(caret([0, 0], 1))
  })

  it('rich HTML dropped into a code block (caret in a paragraph) becomes plain text there', () => {
    const ed = setup(doc(p(txt('pq')), code('ab')), caret([0, 0], 1))
    drop(ed, caret([1, 0], 1), '<p>x<b>y</b></p><p>z</p>')
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p(txt('pq')), code('axy\nzb'))))
  })

  it('rich HTML dropped into a paragraph (caret in a code block) stays rich there', () => {
    const ed = setup(doc(p(txt('pq')), code('ab')), caret([1, 0], 1))
    drop(ed, caret([0, 0], 1), '<p>x<b>y</b></p><p>z</p>')
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p(txt('px'), txt('y', 'bold')), p(txt('zq')), code('ab'))))
  })

  it('nested blocks (a list of paragraphs) pasted inside keep a newline per block', () => {
    const list = definePlugin({ name: 'list', node: { kind: 'block' } })
    const ed = createTestEditor({
      plugins: [paragraph, bold, list, codeBlock],
      doc: doc(code('')),
      selection: caret([0, 0], 0),
    })
    const json = JSON.stringify([el('list', p(txt('a')), p(txt('b'))), p(txt('c'))])
    paste(ed as unknown as Ed, { 'application/x-hte-fragment': json })
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(code('a\nb\nc'))))
  })

  it('multi-line plain text pasted inside stays in the block', () => {
    const ed = setup(doc(code('[]')), caret([0, 0], 1))
    paste(ed, { 'text/plain': 'x\ny' })
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(code('[x\ny]'))))
  })

  it('copying x\\ny from a code block and pasting it into a paragraph gives two paragraphs', () => {
    const ed = setup(doc(code('x\ny'), p(txt(''))), caret([1, 0], 0))
    const flavors = serializeForClipboard(ed, { start: { path: [0, 0], offset: 0 }, end: { path: [0, 0], offset: 3 } })
    expect(flavors.text).toBe('x\ny')
    paste(ed, { 'application/x-hte-fragment': flavors.json, 'text/html': flavors.html, 'text/plain': flavors.text })
    expect(blocks(ed)).toEqual([
      { type: 'codeBlock', text: 'x\ny' },
      { type: 'paragraph', text: 'x' },
      { type: 'paragraph', text: 'y' },
    ])
  })
})

describe('code block HTML', () => {
  it('round-trips <pre><code class="language-x"> with its newlines', () => {
    const ed = setup(doc(p(txt(''))), caret([0, 0], 0))
    const html = '<pre><code class="language-python">x = 1\ny = 2</code></pre>'
    ed.setContent(html)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(code('x = 1\ny = 2', 'python'))))
    expect(ed.getHTML()).toBe(html)
  })

  it('a <pre> without a language class parses as plaintext', () => {
    const ed = setup(doc(p(txt(''))), caret([0, 0], 0))
    ed.setContent('<pre>a</pre>')
    expect(ed.state.doc.children[0]!.data).toEqual({ language: 'plaintext' })
  })

  it('merges HTMLAttributes into the <pre>; the language class stays on <code>', () => {
    const ed = setup(doc(code('a', 'css')), caret([0, 0], 0), codeBlock.configure({ HTMLAttributes: { class: 'snippet' } }))
    expect(ed.getHTML()).toBe('<pre class="snippet"><code class="language-css">a</code></pre>')
  })
})

describe('code block decorations', () => {
  const inline = (ed: Ed) => ed.getDecorations(ed.state).filter((d) => d.type === 'inline')

  it('javascript `const a = 1` has a keyword token over `const`', () => {
    const ed = setup(doc(p(txt('x')), code('const a = 1', 'javascript')), caret([0, 0], 0))
    expect(inline(ed)).toContainEqual({
      type: 'inline',
      from: { path: [1, 0], offset: 0 },
      to: { path: [1, 0], offset: 5 },
      attrs: { class: 'hljs-keyword' },
    })
  })

  it('plaintext has none', () => {
    const ed = setup(doc(code('const a = 1')), caret([0, 0], 0))
    expect(inline(ed)).toEqual([])
  })

  it('uses the highlighter option', () => {
    const plugin = codeBlock.configure({ highlighter: (text, lang) => [{ from: 0, to: text.length, className: `hljs-${lang}` }] })
    const ed = setup(doc(code('ab', 'x')), caret([0, 0], 0), plugin)
    expect(inline(ed)).toEqual([
      { type: 'inline', from: { path: [0, 0], offset: 0 }, to: { path: [0, 0], offset: 2 }, attrs: { class: 'hljs-x' } },
    ])
  })

  /** A highlighter recording each call, giving one token over the whole text. */
  function counting() {
    const calls: string[] = []
    const plugin = codeBlock.configure({
      highlighter: (text, lang) => {
        calls.push(text)
        return [{ from: 0, to: text.length, className: `hljs-${lang}` }]
      },
    })
    return { calls, plugin }
  }
  const tok = (path: number[], to: number, lang: string) => ({
    type: 'inline',
    from: { path, offset: 0 },
    to: { path, offset: to },
    attrs: { class: `hljs-${lang}` },
  })

  it('an edit outside the code blocks re-highlights none; an edit in one re-highlights only it', () => {
    const { calls, plugin } = counting()
    const ed = setup(doc(code('ab', 'x'), p(txt('p')), code('cd', 'y')), caret([1, 0], 1), plugin)
    expect(inline(ed)).toEqual([tok([0, 0], 2, 'x'), tok([2, 0], 2, 'y')])
    expect(calls).toEqual(['ab', 'cd'])
    calls.length = 0
    ed.commands.insertText('q')
    expect(inline(ed)).toEqual([tok([0, 0], 2, 'x'), tok([2, 0], 2, 'y')])
    expect(calls).toEqual([])
    ed.dispatch(ed.createTransaction().insertText('e', { start: { path: [0, 0], offset: 2 }, end: { path: [0, 0], offset: 2 } }))
    expect(inline(ed)).toEqual([tok([0, 0], 3, 'x'), tok([2, 0], 2, 'y')])
    expect(calls).toEqual(['abe'])
  })

  it('a block inserted before the code blocks shifts their decorations without re-highlighting', () => {
    const { calls, plugin } = counting()
    const ed = setup(doc(p(txt('p')), code('ab', 'x')), caret([0, 0], 0), plugin)
    expect(inline(ed)).toEqual([tok([1, 0], 2, 'x')])
    calls.length = 0
    ed.commands.splitBlock()
    expect(inline(ed)).toEqual([tok([2, 0], 2, 'x')])
    expect(calls).toEqual([])
  })

  it('a changed language or highlighter highlights again', () => {
    const { calls, plugin } = counting()
    const ed = setup(doc(code('ab', 'x')), caret([0, 0], 0), plugin)
    inline(ed)
    calls.length = 0
    ed.commands.setLanguage('css')
    expect(inline(ed)).toEqual([tok([0, 0], 2, 'css')])
    expect(calls).toEqual(['ab'])
    const other = counting()
    const ed2 = setup(ed.state.doc as Doc, caret([0, 0], 0), other.plugin)
    expect(ed2.getDecorations(ed.state).filter((d) => d.type === 'inline')).toEqual([tok([0, 0], 2, 'css')])
    expect(other.calls).toEqual(['ab'])
  })

  it('does not walk again into a subtree that did not change', () => {
    const { plugin } = counting()
    const ed = setup(doc(p(txt('a')), code('ab', 'x')), caret([0, 0], 0), plugin)
    let reads = 0
    const para = new Proxy(ed.state.doc.children[0]!, {
      get(target, key, receiver) {
        if (key === 'children') reads++
        return Reflect.get(target, key, receiver)
      },
    })
    const withPara = (children: readonly unknown[]) => ({ ...ed.state, doc: { ...ed.state.doc, children } }) as typeof ed.state
    const [, block] = ed.state.doc.children
    expect(ed.getDecorations(withPara([para, block])).filter((d) => d.type === 'inline')).toEqual([tok([1, 0], 2, 'x')])
    reads = 0
    // A new doc (another block appended) holding the same paragraph node.
    const extra = { id: 'z', type: 'paragraph', data: {}, children: [{ text: 'z', marks: [] }] }
    expect(ed.getDecorations(withPara([para, block, extra])).filter((d) => d.type === 'inline')).toEqual([tok([1, 0], 2, 'x')])
    expect(reads).toBe(0)
  })
})

describe('defaultHighlighter', () => {
  it('gives UTF-16 offsets into the unescaped text', () => {
    const tokens = defaultHighlighter('"<é>" + 1', 'javascript')
    expect(tokens).toContainEqual({ from: 0, to: 5, className: 'hljs-string' })
    expect(tokens).toContainEqual({ from: 8, to: 9, className: 'hljs-number' })
  })

  it('knows html (via xml) and no unknown language', () => {
    expect(defaultHighlighter('<a></a>', 'html').length).toBeGreaterThan(0)
    expect(defaultHighlighter('const a', 'plaintext')).toEqual([])
    expect(defaultHighlighter('const a', 'nope')).toEqual([])
  })
})

describe('IME inside a code block', () => {
  it('composition commits like in any text block, keeping newlines and the caret', () => {
    const ed = setup(doc(code('a\nb')), caret([0, 0], 3))
    const root = document.createElement('div')
    document.body.appendChild(root)
    ed.mount(root)
    ed.view!.focus()
    const fire = (type: string) => root.dispatchEvent(new Event(type, { bubbles: true }))
    fire('compositionstart')
    const leaf = ed.view!.renderer.leafAt([0, 0])!
    const walker = leaf.ownerDocument.createTreeWalker(leaf, 4)
    const texts: Text[] = []
    for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text)
    // The IME appends to the last DOM text of the leaf.
    texts[texts.length - 1]!.data += 'ế'
    fire('compositionend')
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(code('a\nbế'))))
    expect(ed.state.selection).toEqual(caret([0, 0], 4))
    expect((ed.state.doc.children[0] as ElementNode).children as TextNode[]).toHaveLength(1)
    ed.destroy()
  })
})

describe('code block with several ranges', () => {
  const rng = (path: number[], from: number, to = from) => ({ anchor: { path, offset: from }, focus: { path, offset: to } })
  const multi = (...ranges: ReturnType<typeof rng>[]) => createSelection(ranges)
  const texts = (ed: Ed) => blocks(ed).map((b) => b.text)

  it('Tab at two carets in different blocks indents both', () => {
    const ed = setup(doc(code('ab'), code('cd')), multi(rng([0, 0], 1), rng([1, 0], 1)))
    expect(ed.runKeymap('Tab')).toBe(true)
    expect(texts(ed)).toEqual(['a  b', 'c  d'])
    expect(ed.state.selection).toEqual(multi(rng([0, 0], 3), rng([1, 0], 3)))
  })

  it('Tab with two ranges on the same line indents it once', () => {
    // "a\nbb\nc": the ranges 0..3 (lines a, bb) and 4..6 (bb, c) share line bb.
    const ed = setup(doc(code('a\nbb\nc')), multi(rng([0, 0], 0, 3), rng([0, 0], 4, 6)))
    expect(ed.runKeymap('Tab')).toBe(true)
    expect(texts(ed)).toEqual(['  a\n  bb\n  c'])
  })

  it('Tab at a caret on a line another range indents does not indent it twice', () => {
    const ed = setup(doc(code('a\nbc\nd')), multi(rng([0, 0], 0, 3), rng([0, 0], 4)))
    expect(ed.runKeymap('Tab')).toBe(true)
    expect(texts(ed)).toEqual(['  a\n  bc\nd'])
  })

  it('Tab with a caret in a code block and a caret in a paragraph leaves the paragraph alone', () => {
    const ed = setup(doc(code('ab'), p(txt('cd'))), multi(rng([0, 0], 1), rng([1, 0], 1)))
    expect(ed.runKeymap('Tab')).toBe(true)
    expect(texts(ed)).toEqual(['a  b', 'cd'])
    expect(ed.state.selection).toEqual(multi(rng([0, 0], 3), rng([1, 0], 1)))
  })

  it('Tab with every caret outside a code block is left to the editor', () => {
    const ed = setup(doc(p(txt('ab')), p(txt('cd'))), multi(rng([0, 0], 1), rng([1, 0], 1)))
    expect(ed.runKeymap('Tab')).toBe(false)
    expect(texts(ed)).toEqual(['ab', 'cd'])
  })

  it('Shift-Tab dedents each distinct line once', () => {
    const ed = setup(doc(code('  a\n  b'), code('  c')), multi(rng([0, 0], 0, 4), rng([0, 0], 5), rng([1, 0], 3)))
    expect(ed.runKeymap('Shift-Tab')).toBe(true)
    expect(texts(ed)).toEqual(['a\nb', 'c'])
  })

  it('Enter at two carets inserts two newlines', () => {
    const ed = setup(doc(code('ab'), code('cd')), multi(rng([0, 0], 1), rng([1, 0], 1)))
    expect(ed.runKeymap('Enter')).toBe(true)
    expect(texts(ed)).toEqual(['a\nb', 'c\nd'])
    expect(ed.state.selection).toEqual(multi(rng([0, 0], 2), rng([1, 0], 2)))
  })

  it('Enter with a caret in a code block and one in a paragraph adds a newline there and splits the paragraph', () => {
    const ed = setup(doc(code('ab'), p(txt('cd'))), multi(rng([0, 0], 1), rng([1, 0], 1)))
    expect(ed.runKeymap('Enter')).toBe(true)
    expect(blocks(ed)).toEqual([
      { type: 'codeBlock', text: 'a\nb' },
      { type: 'paragraph', text: 'c' },
      { type: 'paragraph', text: 'd' },
    ])
  })

  it('Shift-Enter at a code caret adds a newline and splits the paragraph for the plain caret', () => {
    const ed = setup(doc(code('ab'), p(txt('cd'))), multi(rng([0, 0], 1), rng([1, 0], 1)))
    expect(ed.runKeymap('Shift-Enter')).toBe(true)
    expect(texts(ed)).toEqual(['a\nb', 'c', 'd'])
  })

  it('Enter with every caret in a paragraph is left to the editor', () => {
    const ed = setup(doc(p(txt('ab')), p(txt('cd'))), multi(rng([0, 0], 1), rng([1, 0], 1)))
    expect(ed.runKeymap('Enter')).toBe(false)
  })

  it('triple-Enter exits only at the caret at a \\n\\n end', () => {
    const ed = setup(doc(code('ab\n\n'), code('cd\n\n')), multi(rng([0, 0], 4), rng([1, 0], 1)))
    expect(ed.runKeymap('Enter')).toBe(true)
    expect(blocks(ed)).toEqual([
      { type: 'codeBlock', text: 'ab' },
      { type: 'paragraph', text: '' },
      { type: 'codeBlock', text: 'c\nd\n\n' },
    ])
    expect(ed.state.selection).toEqual(multi(rng([1, 0], 0), rng([2, 0], 2)))
  })

  it('the line-break intents take the same per-caret path', () => {
    const ed = setup(doc(code('ab'), p(txt('cd'))), multi(rng([0, 0], 1), rng([1, 0], 1)))
    ed.handleIntent({ inputType: 'insertParagraph', data: null, range: null })
    expect(texts(ed)).toEqual(['a\nb', 'c', 'd'])
  })

  it('Backspace at the start of two empty code blocks turns both into paragraphs', () => {
    const ed = setup(doc(code(''), p(txt('x')), code('')), multi(rng([0, 0], 0), rng([2, 0], 0)))
    expect(ed.runKeymap('Backspace')).toBe(true)
    expect(blocks(ed).map((b) => b.type)).toEqual(['paragraph', 'paragraph', 'paragraph'])
    expect(ed.state.selection).toEqual(multi(rng([0, 0], 0), rng([2, 0], 0)))
  })

  it('Backspace with a code caret not in an empty block is left to the editor', () => {
    const ed = setup(doc(code(''), p(txt('xy'))), multi(rng([0, 0], 0), rng([1, 0], 1)))
    expect(ed.runKeymap('Backspace')).toBe(false)
  })

  it('setCodeBlock converts every block with a range, once per block', () => {
    const ed = setup(doc(p(txt('ab')), p(txt('cd')), p(txt('ef'))), multi(rng([0, 0], 1), rng([0, 0], 2), rng([2, 0], 1)))
    expect(ed.commands.setCodeBlock('json')).toBe(true)
    expect(blocks(ed)).toEqual([
      { type: 'codeBlock', text: 'ab' },
      { type: 'paragraph', text: 'cd' },
      { type: 'codeBlock', text: 'ef' },
    ])
    expect((ed.state.doc.children[0] as ElementNode).data).toEqual({ language: 'json' })
    expect(ed.state.selection).toEqual(multi(rng([0, 0], 1), rng([0, 0], 2), rng([2, 0], 1)))
    ed.commands.undo()
    expect(blocks(ed).map((b) => b.type)).toEqual(['paragraph', 'paragraph', 'paragraph'])
    expect(ed.state.selection).toEqual(multi(rng([0, 0], 1), rng([0, 0], 2), rng([2, 0], 1)))
  })

  it('setCodeBlock keeps every range at its text offsets', () => {
    const ed = setup(doc(p(txt('abc')), p(txt('def'))), multi(rng([0, 0], 0, 1), rng([1, 0], 2)))
    expect(ed.commands.setCodeBlock()).toBe(true)
    expect(ed.state.selection).toEqual(multi(rng([0, 0], 0, 1), rng([1, 0], 2)))
  })

  it('setCodeBlock skips a block that is already code', () => {
    const ed = setup(doc(p(txt('ab')), code('cd')), multi(rng([0, 0], 1), rng([1, 0], 1)))
    expect(ed.commands.setCodeBlock()).toBe(true)
    expect(blocks(ed).map((b) => b.type)).toEqual(['codeBlock', 'codeBlock'])
  })

  it('setLanguage updates every code block with a range', () => {
    const ed = setup(doc(code('a'), p(txt('x')), code('b'), code('c')), multi(rng([0, 0], 0), rng([1, 0], 0), rng([2, 0], 1)))
    expect(ed.commands.setLanguage('python')).toBe(true)
    const langs = ed.state.doc.children.map((b) => (b.type === 'codeBlock' ? (b.data as { language: string }).language : null))
    expect(langs).toEqual(['python', null, 'python', 'plaintext'])
  })

  it('exitCodeBlock adds one paragraph after every distinct block holding a range', () => {
    const ed = setup(doc(code('ab'), code('cd')), multi(rng([0, 0], 0), rng([0, 0], 2), rng([1, 0], 1)))
    expect(ed.commands.exitCodeBlock()).toBe(true)
    expect(blocks(ed).map((b) => b.type)).toEqual(['codeBlock', 'paragraph', 'codeBlock', 'paragraph'])
    expect(ed.state.selection).toEqual(multi(rng([1, 0], 0), rng([3, 0], 0)))
  })

  it('paste gives plain text to carets in code blocks and the rich fragment to the others', () => {
    const ed = setup(doc(code('ab'), p(txt('cd'))), multi(rng([0, 0], 1), rng([1, 0], 1)))
    paste(ed, { 'text/html': '<p>x<strong>y</strong></p><p>z</p>' })
    expect(blocks(ed)).toEqual([
      { type: 'codeBlock', text: 'axy\nzb' },
      { type: 'paragraph', text: 'cxy' },
      { type: 'paragraph', text: 'zd' },
    ])
    const rich = (ed.state.doc.children[1] as ElementNode).children as TextNode[]
    expect(rich.some((c) => c.marks.length > 0)).toBe(true)
    expect(((ed.state.doc.children[0] as ElementNode).children as TextNode[])[0]!.marks).toEqual([])
  })
})

describe('code block bold with a range in code and a caret in a paragraph', () => {
  const rng = (path: number[], from: number, to = from) => ({ anchor: { path, offset: from }, focus: { path, offset: to } })

  it('the paragraph caret gets bold stored marks; the code text stays plain', () => {
    const ed = setup(doc(code('abc'), p(txt('xy'))), createSelection([rng([0, 0], 0, 2), rng([1, 0], 1)]))
    expect(ed.commands.toggleBold()).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(code('abc'), p(txt('xy')))))
    expect(ed.state.storedMarks).toEqual([{ type: 'bold', data: {} }])
    // Typing at both ranges: bold only in the paragraph.
    ed.commands.insertText('Z')
    const codeText = (ed.state.doc.children[0] as ElementNode).children as TextNode[]
    expect(codeText.every((c) => c.marks.length === 0)).toBe(true)
    expect(blocks(ed).map((b) => b.text)).toEqual(['Zc', 'xZy'])
    const para = (ed.state.doc.children[1] as ElementNode).children as TextNode[]
    expect(para.find((c) => c.text.includes('Z'))!.marks).toEqual([{ type: 'bold', data: {} }])
  })
})
