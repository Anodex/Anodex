import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Vitest configuration for Anodex.
 *
 * Mirrors the alias resolution from `electron.vite.config.ts` so tests can
 * import `@shared`, `@main`, and `@renderer` paths exactly like source code.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    exclude: ['node_modules', 'e2e', 'dist', 'out']
  },
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@main': resolve('src/main'),
      '@renderer': resolve('src/renderer')
    }
  }
})
