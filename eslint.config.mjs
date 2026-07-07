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
  { ignores: ['out/**', 'dist/**', 'node_modules/**', '.claude/**', 'dev.cmd'] },
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
  }
)
