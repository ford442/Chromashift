import { defineConfig, devices } from '@playwright/test';

/**
 * Headless Chromium needs `--enable-unsafe-webgpu` for WebGPU in CI (see
 * e2e/webgpu-smoke.spec.ts).
 *
 * The other three keep the device alive. Without them, on a GPU-less runner
 * the GPU process cannot allocate the canvas swap-chain image
 * (`Could not find SharedImageBackingFactory … WebgpuSwapChainTexture`) and
 * Dawn destroys the device a few frames in — so every WebGPU frame, hand
 * encoder and graph executor alike, came back black and no pixel comparison
 * could run. Only all three together avoid it. See
 * e2e/helpers/gpuCanvasReadback.ts for how the specs then read the frame.
 */
const WEBGPU_LAUNCH_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-vulkan=swiftshader',
  '--use-angle=swiftshader',
];

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
      // Named WebGL diagnostic backend. Specs here drive `?renderer=webgl`
      // (Playwright screenshots, kiosk, presets). Distinct from chromium-webgpu.
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /webgpu-smoke\.spec\.ts|compare-.*\.spec\.ts|preset-compare\.spec\.ts|graph-executor\.spec\.ts|motion-flow-parity\.spec\.ts/,
    },
    {
      name: 'chromium-webgpu',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: WEBGPU_LAUNCH_ARGS,
        },
      },
      testMatch: /webgpu-smoke\.spec\.ts|compare-.*\.spec\.ts|preset-compare\.spec\.ts|graph-executor\.spec\.ts|motion-flow-parity\.spec\.ts/,
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
