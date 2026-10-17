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
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
