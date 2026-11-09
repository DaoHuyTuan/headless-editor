/** How long the fake upload takes, so the blob preview and the pending state are visible. */
const DELAY_MS = 300

/**
 * The object URLs `fakeUpload` returned. They stand in for permanent server URLs, so they must live
 * as long as anything may show them: the doc, the undo / redo history, a copy on the clipboard. They
 * are revoked only by `revokeFakeUploads`, when the editor that used them goes away.
 */
const urls = new Set<string>()

/**
 * A stand-in for a real upload: resolves after 300 ms with a new object URL for `file` plus
 * `#uploaded`, so the result differs from the editor's blob preview. With `?uploadFail=1` in the
 * page URL it rejects instead (used by the e2e suite).
 */
export function fakeUpload(file: File): Promise<string> {
  const fail = new URLSearchParams(window.location.search).get('uploadFail') === '1'
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (fail) {
        reject(new Error(`Upload of ${file.name} failed (?uploadFail=1)`))
        return
      }
      const url = URL.createObjectURL(file)
      urls.add(url)
      resolve(`${url}#uploaded`)
    }, DELAY_MS)
  })
}

/** Revokes every URL `fakeUpload` returned (call when the editor is destroyed). */
export function revokeFakeUploads(): void {
  for (const url of urls) URL.revokeObjectURL(url)
  urls.clear()
}

/**
 * The image plugin's `onUploadError`: the image is already gone from the doc; this tells the user.
 * A warning, not an error: the failure is expected with `?uploadFail=1`, and the e2e suite fails on
 * any `console.error`.
 */
export function onUploadError(error: unknown, file: File): void {
  console.warn(`Image upload failed for ${file.name}:`, error)
}
