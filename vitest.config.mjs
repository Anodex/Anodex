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
    // `.claude` can contain isolated agent worktrees (see the Agent tool's
    // `isolation: "worktree"` mode) — a full nested checkout of this same
    // repo, including its own test files. Without excluding it, a stray
    // worktree gets swept into every test run here by Vitest's default glob.
    exclude: ['node_modules', 'e2e', 'dist', 'out', '.claude']
  },
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@main': resolve('src/main'),
      '@renderer': resolve('src/renderer')
    }
  }
})
