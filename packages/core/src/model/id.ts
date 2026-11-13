const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'

function defaultGenerator(): string {
  const bytes = new Uint8Array(10)
  globalThis.crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += ALPHABET[b & 63]
  return out
}

let generator: () => string = defaultGenerator

export function createId(): string {
  return generator()
}

/** Override the id generator (e.g. deterministic ids in tests). `null` restores the default. */
export function setIdGenerator(fn: (() => string) | null): void {
  generator = fn ?? defaultGenerator
}

/**
 * @internal Runs `body` and appends every id it creates to `ids`: a dry run of an edit that may
 * have to be dropped, replayed with `replayIds` so the real edit gets the same ids (and the
 * generator is called once per id, as without the dry run).
 */
export function recordIds<T>(ids: string[], body: () => T): T {
  const outer = generator
  generator = () => {
    const id = outer()
    ids.push(id)
    return id
  }
  try {
    return body()
  } finally {
    generator = outer
  }
}

/** @internal Runs `body` with `createId` returning `ids` in order (then the generator again). */
export function replayIds<T>(ids: readonly string[], body: () => T): T {
  const outer = generator
  let i = 0
  generator = () => (i < ids.length ? ids[i++]! : outer())
  try {
    return body()
  } finally {
    generator = outer
  }
}
