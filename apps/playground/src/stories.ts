import type { Doc } from '@penline/core'

export type StoryId =
  | 'empty'
  | 'paragraphs'
  | 'pastedHtml'
  | 'unknownBlock'
  | 'bold'
  | 'fontSizes'
  | 'image'
  | 'customImage'
  | 'mention'
  | 'codeBlock'

export interface Story {
  id: StoryId
  group: string
  slug: string
  title: string
  /** One sentence saying what to try. */
  description: string
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

/** The stories in sidebar order. */
export const stories: readonly Story[] = [
  {
    id: 'empty',
    group: 'Basics',
    slug: 'empty',
    title: 'Empty',
    description: 'Start from an empty document and type.',
    content: { type: 'doc', children: [] },
  },
  {
    id: 'paragraphs',
    group: 'Basics',
    slug: 'paragraphs',
    title: 'Paragraphs',
    description: 'Edit, split and merge paragraphs with Enter and Backspace.',
    content: '<p>The first paragraph.</p><p>The second paragraph.</p><p>The third paragraph.</p>',
  },
  {
    id: 'pastedHtml',
    group: 'Basics',
    slug: 'pasted-html',
    title: 'Pasted HTML',
    description: 'Messy HTML as pasted from other apps: styled bold, fake-normal bold, unknown tags and loose text.',
    content:
      '<meta charset="utf-8"><div><span style="font-weight:700">Bold via style</span> then plain</div>' +
      '<p>Para with <b style="font-weight:normal">not bold</b> and <em>unknown em</em></p>loose text',
  },
  {
    id: 'unknownBlock',
    group: 'Basics',
    slug: 'unknown-block',
    title: 'Unknown block',
    description: 'A block type no plugin registers is kept losslessly and rendered as a non-editable placeholder.',
    content: unknownBlockDoc,
  },
  {
    id: 'bold',
    group: 'Bold',
    slug: 'basic',
    title: 'Bold',
    description: 'Select text and press Ctrl/Cmd+B to toggle bold.',
    content: '<p>Some <strong>bold</strong> text and some <b>more bold</b>.</p>',
  },
  {
    id: 'fontSizes',
    group: 'Font size',
    slug: 'sizes',
    title: 'Font sizes',
    description: 'Select text and change its font size; sizes combine with bold.',
    content:
      '<p>Default, <span style="font-size:12px">small 12px</span>, <span style="font-size:16px">16px</span>, ' +
      '<span style="font-size:24px">large 24px</span> and <span style="font-size:32px">huge 32px</span>.</p>' +
      '<p><span style="font-size:24px">A 24px line with <strong>bold</strong> inside.</span></p>',
  },
  {
    id: 'image',
    group: 'Image',
    slug: 'default',
    title: 'Image',
    description: 'Click the image to select it, then resize it or press Backspace to remove it.',
    content: imageDoc,
  },
  {
    id: 'customImage',
    group: 'Image',
    slug: 'custom-view',
    title: 'Custom image view',
    description: 'The same image, rendered by a custom view built from the image hooks only.',
    content: imageDoc,
    imageView: 'custom',
  },
  {
    id: 'mention',
    group: 'Mention',
    slug: 'basic',
    title: 'Mention',
    description: 'Type @ to search users; Backspace after a mention removes it whole.',
    content: mentionDoc,
  },
  {
    id: 'codeBlock',
    group: 'Code block',
    slug: 'javascript',
    title: 'Code block',
    description: 'Type inside the snippet; Enter inserts a newline within the block.',
    content: codeBlockDoc,
  },
]

/** The stories grouped for the sidebar, in first-appearance order. */
export const storyGroups: readonly { name: string; stories: readonly Story[] }[] = stories.reduce<
  { name: string; stories: Story[] }[]
>((groups, story) => {
  const group = groups.find((g) => g.name === story.group)
  if (group) group.stories.push(story)
  else groups.push({ name: story.group, stories: [story] })
  return groups
}, [])
