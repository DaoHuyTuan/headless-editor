/// <reference types="vite/client" />
import type { PlaygroundEditor } from './editor'
import type { UsersRequest } from './fake-users'

declare global {
  interface Window {
    /** The playground's editor, exposed in dev for debugging and e2e tests. */
    editor: PlaygroundEditor
    /** Every fake `fetchUsers` request, in sending order (dev only; read by the e2e race test). */
    usersRequests?: UsersRequest[]
  }
}
