import type { User } from '@hte/mention'

export const USERS: readonly User[] = [
  { id: 'u-alice', label: 'Alice' },
  { id: 'u-anna', label: 'Anna' },
  { id: 'u-andrew', label: 'Andrew' },
  { id: 'u-bob', label: 'Bob' },
  { id: 'u-carol', label: 'Carol' },
  { id: 'u-dan', label: 'Dan' },
]

const DELAY_MS = 150
/** `?slowUsers=1`: queries of 0–1 characters answer after this, longer ones after `SLOW_FAST_MS`. */
const SLOW_SHORT_MS = 400
const SLOW_FAST_MS = 50

/** One fake request: its query and, once answered, in which order it resolved. */
export interface UsersRequest {
  query: string
  /** Position among resolutions (0 = first answered); undefined while pending. */
  resolvedAs?: number
}

let resolvedCount = 0

/**
 * A stand-in for a user search: the users whose label starts with `query` (case-insensitive), after
 * 150 ms. With `?slowUsers=1` in the page URL, shorter queries answer slower (`@a` 400 ms, `@an`
 * 50 ms), so typing `@a` then `n` always gets the `an` response before the stale `a` one (used by the
 * e2e race test). In dev, every request is logged in `window.usersRequests`, in sending order.
 */
export function fetchUsers(query: string): Promise<User[]> {
  const slow = new URLSearchParams(window.location.search).get('slowUsers') === '1'
  const delay = slow ? (query.length < 2 ? SLOW_SHORT_MS : SLOW_FAST_MS) : DELAY_MS
  const request: UsersRequest = { query }
  if (import.meta.env.DEV) (window.usersRequests ??= []).push(request)
  const q = query.toLowerCase()
  return new Promise((resolve) => {
    setTimeout(() => {
      request.resolvedAs = resolvedCount++
      resolve(USERS.filter((u) => u.label.toLowerCase().startsWith(q)))
    }, delay)
  })
}
