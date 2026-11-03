import type { Editor } from '@hte/core'
import { bold } from '@hte/bold'
import { codeBlock } from '@hte/code-block'
import { fontSize } from '@hte/font-size'
import { image } from '@hte/image'
import { mention } from '@hte/mention'
import { paragraph } from '@hte/paragraph'

export const plugins = [paragraph, bold, fontSize, image, mention, codeBlock] as const

export type PlaygroundEditor = Editor<typeof plugins>
