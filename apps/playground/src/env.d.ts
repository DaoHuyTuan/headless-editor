/// <reference types="vite/client" />
import type { PlaygroundEditor } from './editor'

declare global {
  interface Window {
    /** The playground's editor, exposed in dev for debugging and e2e tests. */
    editor: PlaygroundEditor
  }
}
