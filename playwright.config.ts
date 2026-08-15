import { defineConfig, devices } from '@playwright/test';

/** Headless Chromium needs this flag for WebGPU in CI (see e2e/webgpu-smoke.spec.ts). */
const WEBGPU_LAUNCH_ARGS = ['--enable-unsafe-webgpu'];

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    headless: true,
  },
  projects: [
    {
      // The WebGL lane. Every spec here drives the app with `?renderer=webgl`,
      // which is disabled for this development phase — they self-skip via
      // `skipWhileWebGlDisabled()` and report as pending until the later
      // fallback wave. Run them with CHROMASHIFT_E2E_WEBGL=1 against a build
      // that has WEBGL_BACKEND_ENABLED flipped on.
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /webgpu-smoke\.spec\.ts|compare-.*\.spec\.ts|preset-compare\.spec\.ts/,
    },
    {
      name: 'chromium-webgpu',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: WEBGPU_LAUNCH_ARGS,
        },
      },
      testMatch: /webgpu-smoke\.spec\.ts|compare-.*\.spec\.ts|preset-compare\.spec\.ts/,
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
