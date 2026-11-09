import { defineConfig, devices } from '@playwright/test'

// A dedicated port (not Vite's default 5173, where a stray dev server may run). `E2E_PORT` picks
// another one, e.g. when 5174 is taken by a process that must not be killed.
const PORT = Number(process.env.E2E_PORT ?? 5174)
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) throw new Error(`E2E_PORT must be a port number, got "${process.env.E2E_PORT}"`)

// Never reused by default: a server already on the port may be another checkout's (other worktrees
// share it) and would make the suite silently test stale code. When the port is taken, Playwright
// fails before any test with "http://localhost:<port> is already used"; set E2E_PORT to another
// port. `E2E_REUSE_SERVER=1` reuses a dev server you started yourself from this checkout (never on CI).
const reuseExistingServer = !process.env.CI && process.env.E2E_REUSE_SERVER === '1'

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: `http://localhost:${PORT}`, trace: 'on-first-retry' },
  webServer: { command: `pnpm dev --port ${PORT} --strictPort`, port: PORT, reuseExistingServer },
  // Chromium and WebKit only: Firefox is not part of the automated suite (it is checked by hand).
  projects: [
    // Clipboard permissions are Chromium-only: WebKit rejects them as unknown.
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], permissions: ['clipboard-read', 'clipboard-write'] },
    },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
})
