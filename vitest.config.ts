import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.{ts,tsx}', 'apps/playground/test/**/*.test.ts'],
    typecheck: { include: ['packages/**/test/**/*.test-d.{ts,tsx}'] },
  },
})
