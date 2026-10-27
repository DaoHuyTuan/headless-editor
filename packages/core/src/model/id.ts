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
