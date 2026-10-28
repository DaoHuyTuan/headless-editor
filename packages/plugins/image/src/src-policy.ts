const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i
const DATA_IMAGE_RE = /^data:image\/(png|jpeg|gif|webp|avif);base64,/i

/**
 * `src` when it is safe to put in an `<img src>`, else null. Allowed: `https:`, `http:`, `blob:`,
 * base64 `data:image/(png|jpeg|gif|webp|avif)` and relative URLs; everything else (`javascript:`,
 * `vbscript:`, `data:text/html`, `file:`, …) is null. The scheme is read the way browsers do: after
 * stripping leading/trailing C0 controls and spaces and removing tabs and newlines anywhere.
 */
export function safeSrc(src: string): string | null {
  // eslint-disable-next-line no-control-regex
  const url = src.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '').replace(/[\t\n\r]/g, '')
  if (url === '') return null
  const scheme = SCHEME_RE.exec(url)?.[1]?.toLowerCase()
  if (scheme === undefined) return src
  if (scheme === 'https' || scheme === 'http' || scheme === 'blob') return src
  if (scheme === 'data' && DATA_IMAGE_RE.test(url)) return src
  return null
}
