import { defineConfig, type TestProjectInlineConfiguration } from 'vitest/config';

/**
 * Opt-in (`npm run test:gpu`): renders on a real WebGPU device through Dawn's
 * Node bindings — the headless renderer's pixel goldens and its browser parity
 * (docs/HEADLESS.md). Off by default, so `npm test` needs no Vulkan driver.
 */
const gpuProject: TestProjectInlineConfiguration = {
  extends: true,
  test: {
    name: 'gpu',
    environment: 'node',
    include: ['src/**/*.gpu.test.ts'],
    // Shader compiles on a software rasterizer take seconds per variant.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
};

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
      {
        extends: true,
        test: { name: 'node', environment: 'node', include: ['src/**/*.test.ts'], exclude: ['src/**/*.gpu.test.ts'] },
      },
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
      ...(process.env.CHROMASHIFT_GPU_TESTS === '1' ? [gpuProject] : []),
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/__fixtures__/**', 'src/test/**'],
      reporter: ['text-summary', 'json-summary', 'html'],
    },
  },
});
