import { defineConfig, devices } from '@playwright/test';
import type { Renderer } from './e2e/release/gate';

/**
 * The release smoke suite (#269): `npm run release:smoke -- <base-url>`
 * (scripts/release-smoke.mjs sets the environment below and runs this config).
 *
 * Unlike playwright.config.ts it targets any URL — `vite preview` over `dist/`
 * or a deployed site such as https://test.1ink.us/chromashift-staging/ — and
 * starts a server only for a localhost URL. Every scenario runs behind the
 * console/network gate in e2e/release/gate.ts.
 *
 *   RELEASE_URL            base URL (default http://localhost:4173/)
 *   RELEASE_SHA            commit the live version.json must report
 *   RELEASE_STUB_CORPUS=1  answer the remote corpus images locally (PR job)
 *   RELEASE_OUT            where results, gate summaries and screenshots go
 */

const raw = process.env.RELEASE_URL ?? 'http://localhost:4173/';
const BASE_URL = raw.endsWith('/') ? raw : `${raw}/`;
const parsed = new URL(BASE_URL);
const LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
const OUT = process.env.RELEASE_OUT ?? 'release-results';

// SwiftShader Vulkan keeps WebGPU alive on a GPU-less runner; see playwright.config.ts.
const WEBGPU_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-vulkan=swiftshader',
  '--use-angle=swiftshader',
];
// A fake camera for the live-source scenario.
const FAKE_MEDIA_ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];

const viewport = { width: 1440, height: 900 };

export default defineConfig<{ renderer: Renderer }>({
  testDir: './e2e/release',
  outputDir: `${OUT}/pw`,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : 2,
  reporter: [
    ['list'],
    ['json', { outputFile: `${OUT}/results.json` }],
    ['html', { open: 'never', outputFolder: `${OUT}/html` }],
  ],
  use: {
    baseURL: BASE_URL,
    headless: true,
    viewport,
    trace: 'on-first-retry',
    acceptDownloads: true,
  },
  projects: [
    {
      name: 'release-webgpu',
      // *.webgl.spec.ts: scenarios that only exist on the WebGL backend.
      testIgnore: /upscale\.spec\.ts|\.webgl\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport,
        renderer: 'webgpu',
        permissions: ['camera', 'clipboard-read', 'clipboard-write'],
        launchOptions: { args: [...WEBGPU_ARGS, ...FAKE_MEDIA_ARGS] },
      },
    },
    {
      name: 'release-webgl',
      // *.webgpu.spec.ts: scenarios that only exist on the WebGPU backend.
      testIgnore: /upscale\.spec\.ts|\.webgpu\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport,
        renderer: 'webgl',
        permissions: ['camera', 'clipboard-read', 'clipboard-write'],
        launchOptions: { args: FAKE_MEDIA_ARGS },
      },
    },
    {
      // Real model downloads and CPU inference: minutes per model, so its own
      // project (and its own CI job) with a long timeout.
      name: 'release-upscale',
      testMatch: /upscale\.spec\.ts/,
      timeout: 600_000,
      use: {
        ...devices['Desktop Chrome'],
        viewport,
        renderer: 'webgpu',
        launchOptions: { args: WEBGPU_ARGS },
      },
    },
  ],
  webServer: LOCAL
    ? {
        command: `npm run preview -- --port ${parsed.port || 4173} --strictPort`,
        url: BASE_URL,
        reuseExistingServer: process.env.RELEASE_REUSE_SERVER === '1',
        timeout: 120_000,
      }
    : undefined,
});
