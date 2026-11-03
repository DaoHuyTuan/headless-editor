import type { Doc } from '@hte/core'

export interface Scenario {
  label: string
  content: Doc | string
  /** Which React view renders images: the default `ImageView`, or a custom view built from the image hooks only. */
  imageView?: 'default' | 'custom'
}

const unknownBlockDoc: Doc = {
  type: 'doc',
  children: [
    { id: 'unknown-heading', type: 'heading', data: { level: 1 }, children: [{ text: 'Title', marks: [] }] },
    { id: 'body', type: 'paragraph', data: {}, children: [{ text: 'Body text', marks: [] }] },
  ],
}

/** A 1×1 png (one blue pixel). */
const PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPwqv3/HwAFoQLGyKhj2wAAAABJRU5ErkJggg=='

const imageDoc: Doc = {
  type: 'doc',
  children: [
    { id: 'before', type: 'paragraph', data: {}, children: [{ text: 'before', marks: [] }] },
    { id: 'img', type: 'image', data: { src: PIXEL_PNG, alt: '', width: 120 }, children: [] },
    { id: 'after', type: 'paragraph', data: {}, children: [{ text: 'after', marks: [] }] },
  ],
}

const mentionDoc: Doc = {
  type: 'doc',
  children: [
    {
      id: 'greeting',
      type: 'paragraph',
      data: {},
      children: [
        { text: 'Hi ', marks: [] },
        { id: 'm-anna', type: 'mention', data: { userId: 'u-anna', label: 'Anna' }, children: [] },
        { text: ' and ', marks: [] },
        { id: 'm-bob', type: 'mention', data: { userId: 'u-bob', label: 'Bob' }, children: [] },
        { text: ', welcome!', marks: [] },
      ],
    },
  ],
}

const codeBlockDoc: Doc = {
  type: 'doc',
  children: [
    { id: 'intro', type: 'paragraph', data: {}, children: [{ text: 'A JS snippet:', marks: [] }] },
    {
      id: 'code',
      type: 'codeBlock',
      data: { language: 'javascript' },
      children: [{ text: 'function greet(name) {\n  return `Hello, ${name}!`\n}', marks: [] }],
    },
    { id: 'outro', type: 'paragraph', data: {}, children: [{ text: 'after', marks: [] }] },
  ],
}

const scenarioDefs = {
  empty: { label: 'Empty', content: { type: 'doc', children: [] } },
  paragraphs: {
    label: 'Paragraphs',
    content: '<p>The first paragraph.</p><p>The second paragraph.</p><p>The third paragraph.</p>',
  },
  bold: { label: 'Bold', content: '<p>Some <strong>bold</strong> text and some <b>more bold</b>.</p>' },
  pastedHtml: {
    label: 'Pasted HTML',
    content:
      '<meta charset="utf-8"><div><span style="font-weight:700">Bold via style</span> then plain</div>' +
      '<p>Para with <b style="font-weight:normal">not bold</b> and <em>unknown em</em></p>loose text',
  },
  fontSizes: {
    label: 'Font sizes',
    content:
      '<p>Default, <span style="font-size:12px">small 12px</span>, <span style="font-size:16px">16px</span>, ' +
      '<span style="font-size:24px">large 24px</span> and <span style="font-size:32px">huge 32px</span>.</p>' +
      '<p><span style="font-size:24px">A 24px line with <strong>bold</strong> inside.</span></p>',
  },
  image: { label: 'Image', content: imageDoc },
  // The same image doc, rendered by a custom image view built from the image hooks only (App.tsx).
  customImage: { label: 'Custom image view', content: imageDoc, imageView: 'custom' },
  mention: { label: 'Mention', content: mentionDoc },
  codeBlock: { label: 'Code block', content: codeBlockDoc },
  // A block type no plugin registers: kept losslessly, rendered as an empty non-editable placeholder.
  unknownBlock: { label: 'Unknown block', content: unknownBlockDoc },
} satisfies Record<string, Scenario>

export type ScenarioName = keyof typeof scenarioDefs

/** The scenarios by name, each typed as a `Scenario` (optional fields readable on every entry). */
export const scenarios: Record<ScenarioName, Scenario> = scenarioDefs
