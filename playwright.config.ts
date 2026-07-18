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
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /webgpu-smoke\.spec\.ts/,
    },
    {
      name: 'chromium-webgpu',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: WEBGPU_LAUNCH_ARGS,
        },
      },
      testMatch: /webgpu-smoke\.spec\.ts/,
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
