import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: globals.browser,
      parserOptions: {
        // Type-aware rules: each file is linted against the tsconfig that owns
        // it (app, node, or e2e — see tsconfig.json's references).
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // GPU lifecycle is promise-shaped (requestDevice, mapAsync,
      // onSubmittedWorkDone, device.lost). A dropped promise is a dropped
      // error; mark a deliberate fire-and-forget with `void`.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      // NodeKind / MotionMode / CompareLayoutMode switches must handle every member.
      '@typescript-eslint/switch-exhaustiveness-check': ['error', {
        considerDefaultExhaustiveForUnions: true,
      }],
    },
  },
  // UI imports engine; engine does not import UI. Panels, hooks and App call the
  // engine, so `src/engine/` stays reusable by the headless CLI and sibling apps
  // (see AGENTS.md, Architecture). Type-only imports count.
  {
    files: ['src/engine/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          regex: '(^|/)(components|hooks)(/|$)|(^|/)App(\\.tsx?)?$',
          allowTypeImports: false,
          message: 'src/engine/ must not import UI (components/, hooks/, App). UI imports engine, not the reverse; move shared types into engine/.',
        }],
      }],
    },
  },
])
