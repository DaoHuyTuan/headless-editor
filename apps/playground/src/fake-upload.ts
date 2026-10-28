/** How long the fake upload takes, so the blob preview and the pending state are visible. */
const DELAY_MS = 300

/**
 * A stand-in for a real upload: resolves after 300 ms with a new object URL for `file` plus
 * `#uploaded`, so the result differs from the editor's blob preview. With `?uploadFail=1` in the
 * page URL it rejects instead (used by the e2e suite).
 */
export function fakeUpload(file: File): Promise<string> {
  const fail = new URLSearchParams(window.location.search).get('uploadFail') === '1'
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (fail) reject(new Error(`Upload of ${file.name} failed (?uploadFail=1)`))
      else resolve(`${URL.createObjectURL(file)}#uploaded`)
    }, DELAY_MS)
  })
}
