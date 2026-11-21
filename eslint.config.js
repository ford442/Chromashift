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
      // The type-checked set: `projectService` below already pays for type
      // information, so the rules that need it (no-unsafe-*, no-unnecessary-
      // type-assertion, restrict-template-expressions, ...) cost nothing extra.
      tseslint.configs.recommendedTypeChecked,
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
  // Tests and E2E specs. The type-checked rules that guard shipped code fight the
  // grain of test code rather than find bugs in it: `vi.fn()` mocks and
  // `page.evaluate` results are `any` by construction (`no-unsafe-*`), `expect(obj.method)`
  // reads a method to assert on it (`unbound-method`), and a spec's `async`
  // callbacks routinely have nothing to await (`require-await`). Floating and
  // misused promises stay on: those catch real, silent test bugs.
  {
    files: ['**/*.test.{ts,tsx}', '**/*.dom.test.tsx', '**/__fixtures__/**', 'e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
  // Plain ES modules that run outside the app's TypeScript projects: the Node
  // scripts (codegen, bench, dist checks) and the page-served benchmark core.
  // They match none of the blocks above, so they were linted by nothing at all -
  // an unused variable or an undefined name in `scripts/bench-wasm.mjs` only
  // surfaced when someone ran it. No type information (there is no project to
  // draw it from); `js.configs.recommended` catches the real mistakes.
  {
    files: ['scripts/**/*.mjs', 'public/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      // `public/*.mjs` is imported by the browser benchmark page as well as by
      // Node, so both sets of globals are in scope.
      globals: { ...globals.node, ...globals.browser },
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
  // Every context goes through src/engine/gpu/ (#244): the WebGPU configure,
  // the WebGL2 attributes and the 2D contexts' colour space and
  // willReadFrequently are decided there, from the options matrix
  // (gpuOptions.ts), not at each call site. `configure` with one argument is
  // a presentation context's (the graph pools' take two or three).
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/engine/gpu/**', '**/*.test.ts', '**/*.dom.test.tsx', '**/__fixtures__/**'],
    rules: {
      'no-restricted-syntax': ['error',
        {
          selector: "CallExpression[callee.property.name='getContext']",
          message: 'Create contexts through src/engine/gpu/: webGpuContextOf / webgl2ContextOf (renderCanvas.ts) or getReadback2DContext (readbackContext.ts).',
        },
        {
          selector: "CallExpression[callee.property.name='configure'][arguments.length=1]",
          message: 'Configure a presentation context through configurePresentation (src/engine/gpu/renderCanvas.ts), with a configuration from buildWebGpuCanvasConfiguration.',
        },
        {
          selector: "CallExpression[callee.property.name='requestDevice']",
          message: 'Only the device gate (webgpu/adapter.ts) requests a device, through requestAdapterDevice (src/engine/gpu/renderCanvas.ts).',
        },
      ],
    },
  },
  // The frame never touches the page (#253): the executors, the WebGPU
  // renderer and the frame clock also run in the render worker, which has no
  // `window` or `document`. Page facts (URL flags, sizes, DPR) arrive as
  // messages; breadcrumbs go through `diagnostics.ts`, which forwards them.
  {
    files: [
      'src/engine/graph/exec/**/*.{ts,tsx}',
      'src/engine/webgpu/**/*.{ts,tsx}',
      'src/engine/frame/**/*.{ts,tsx}',
    ],
    ignores: ['**/*.test.ts', '**/*.dom.test.tsx'],
    rules: {
      'no-restricted-globals': ['error',
        {
          name: 'window',
          message: 'This code also runs in the render worker (#253), which has no window. Take the value as a parameter, or use globalThis for a realm global.',
        },
        {
          name: 'document',
          message: 'This code also runs in the render worker (#253), which has no document. Use OffscreenCanvas, or take the value as a parameter.',
        },
      ],
    },
  },
])
