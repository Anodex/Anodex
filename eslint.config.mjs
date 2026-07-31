import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * ESLint 9 flat config for Anodex.
 *
 * - Main / preload code is treated as Node/Electron.
 * - Renderer code is treated as browser React.
 * - Both projects reference their respective tsconfig files for typed rules.
 */
export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', '.claude/**', 'dev.cmd', 'docs/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.web.json'],
        tsconfigRootDir: __dirname
      }
    },
    settings: {
      react: { version: 'detect' }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  },
  {
    files: ['**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked
  },
  react.configs.flat.recommended,
  react.configs.flat['jsx-runtime'],
  {
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'warn'
    }
  },
  {
    files: [
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'electron.vite.config.ts',
      'scripts/**/*.mjs'
    ],
    languageOptions: {
      globals: globals.node
    }
  },
  {
    files: ['src/renderer/**/*.ts', 'src/renderer/**/*.tsx'],
    languageOptions: {
      globals: globals.browser
    }
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'vitest.config.mjs', 'e2e/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser
      }
    }
  },
  /**
   * `installer-shell/` is a second, self-contained Electron app with its own
   * package.json — the branded window that wraps the real NSIS installer. It
   * is plain CommonJS/JS with no TypeScript, and belongs to neither tsconfig
   * project, so the type-checked rules cannot be applied to it at all: the
   * parser errors out looking for a project that will never list these files.
   */
  {
    files: ['installer-shell/**/*.{js,cjs}'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      parserOptions: { project: null, projectService: false },
      globals: globals.node
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      // Electron's main and preload entry points are genuinely CommonJS here;
      // this app has no bundler to turn ESM into anything runnable.
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  {
    files: ['installer-shell/renderer.js'],
    languageOptions: {
      globals: globals.browser
    }
  }
)
