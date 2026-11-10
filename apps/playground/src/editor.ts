import type { Editor } from '@penline/core'
import { bold } from '@penline/bold'
import { codeBlock } from '@penline/code-block'
import { fontSize } from '@penline/font-size'
import { image } from '@penline/image'
import { mention } from '@penline/mention'
import { paragraph } from '@penline/paragraph'

export const plugins = [paragraph, bold, fontSize, image, mention, codeBlock] as const

export type PlaygroundEditor = Editor<typeof plugins>
