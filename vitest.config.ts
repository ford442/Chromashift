import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      // wgsl_reflect's `main` is a CommonJS build inside a `"type": "module"`
      // package, which Node refuses to load; its ESM build is fine.
      { find: /^wgsl_reflect$/, replacement: 'wgsl_reflect/wgsl_reflect.module.js' },
    ],
  },
  test: {
    projects: [
      // Engine and state tests stay on plain Node: no DOM to lean on by accident.
      { extends: true, test: { name: 'node', environment: 'node', include: ['src/**/*.test.ts'] } },
      // Hooks and components, through React Testing Library on happy-dom.
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'happy-dom',
          include: ['src/**/*.dom.test.tsx'],
          setupFiles: ['src/test/domSetup.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/__fixtures__/**', 'src/test/**'],
      reporter: ['text-summary', 'json-summary', 'html'],
    },
  },
});
