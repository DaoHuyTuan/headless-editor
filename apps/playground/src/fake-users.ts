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

/**
 * A stand-in for a user search: the users whose label starts with `query` (case-insensitive), after
 * 150 ms. With `?slowUsers=1` in the page URL each response takes a random 50–400 ms instead, so
 * responses can arrive out of order (used by the e2e race test).
 */
export function fetchUsers(query: string): Promise<User[]> {
  const slow = new URLSearchParams(window.location.search).get('slowUsers') === '1'
  const delay = slow ? 50 + Math.random() * 350 : DELAY_MS
  const q = query.toLowerCase()
  return new Promise((resolve) => {
    setTimeout(() => resolve(USERS.filter((u) => u.label.toLowerCase().startsWith(q))), delay)
  })
}
