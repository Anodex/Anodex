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
    // `.claude` can contain isolated coding-agent worktrees — a full nested
    // checkout of this same repo, including its own test files. Without
    // excluding it, a stray
    // worktree gets swept into every test run here by Vitest's default glob.
    exclude: ['node_modules', 'e2e', 'dist', 'out', '.claude'],
    /**
     * Fifteen seconds, against a default of five.
     *
     * Three suites — `fileTools`, `boundedChatRunner`, `gatheringStreakPlumbing` —
     * time out intermittently on the Windows runner and never anywhere else. They
     * finish in well under a second here on Windows with a warm cache, so the cost
     * is the runner's cold transform and disk, not the tests: the first case in a
     * heavy file pays for the whole module graph, and on a contended runner that
     * alone can exceed five seconds.
     *
     * This makes a slow start survivable rather than making a hang invisible. A
     * test that genuinely never finishes still fails; it fails ten seconds later.
     * Raising it much further would be the version that hides things.
     */
    testTimeout: 15_000,
    /** Same reason: a `beforeAll` that imports the graph pays the same cold cost. */
    hookTimeout: 30_000
  },
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@main': resolve('src/main'),
      '@renderer': resolve('src/renderer')
    }
  }
})
