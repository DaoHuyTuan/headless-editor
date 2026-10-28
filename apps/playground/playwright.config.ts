import { defineConfig, devices } from '@playwright/test'

// A dedicated port, never reused: a stray dev server on Vite's default port (5173) would otherwise
// make the e2e suite silently test stale code.
const PORT = 5174

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: `http://localhost:${PORT}`, trace: 'on-first-retry' },
  webServer: { command: `pnpm dev --port ${PORT} --strictPort`, port: PORT, reuseExistingServer: false },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
