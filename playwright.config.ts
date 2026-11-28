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

/**
 * The port the app under test is served on. `PW_PORT` (default 5173) so two
 * checkouts, or this one and an unrelated Vite app, can share a machine: the
 * server below is started with `--strictPort`, so a taken port is an error here
 * rather than a quietly different app answering on it.
 */
const PORT = Number(process.env.PW_PORT ?? 5173);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error(`PW_PORT must be a port number, got "${process.env.PW_PORT}"`);
}
const BASE_URL = `http://localhost:${PORT}`;

/**
 * `PW_SERVER=preview` serves the production build (`vite preview` over `dist/`,
 * so `npm run build` first) instead of the dev server, and runs only the
 * preview project below. The dev server serves unbundled source with a
 * `base` of `/`; nothing else here exercises the minified bundles, the
 * closure-compiled WASM glue, the ES-module workers' emitted chunks, or
 * `base: './'` in a built page.
 */
const PREVIEW = process.env.PW_SERVER === 'preview';

/**
 * Reusing a running server is opt-in (`PW_REUSE_SERVER=1`), never the local
 * default: Playwright only checks that *something* answers at the URL, so with
 * reuse on, whichever app happened to hold the port was the one under test.
 * CI never reuses.
 */
const REUSE_SERVER = !process.env.CI && process.env.PW_REUSE_SERVER === '1';

const DEV_PROJECTS = [
  {
    // Named WebGL diagnostic backend. Specs here drive `?renderer=webgl`
    // (Playwright screenshots, kiosk, presets). Distinct from chromium-webgpu.
    name: 'chromium',
    use: { ...devices['Desktop Chrome'] },
    testIgnore: /[\\/]release[\\/]|webgpu-smoke\.spec\.ts|webgpu-bgra-export\.spec\.ts|webgpu-device-loss\.spec\.ts|compare-.*\.spec\.ts|preset-compare\.spec\.ts|graph-executor\.spec\.ts|motion-flow-parity\.spec\.ts|render-transport\.spec\.ts|video-export-transport\.spec\.ts|webgpu-image-switch\.spec\.ts/,
  },
  {
    name: 'chromium-webgpu',
    use: {
      ...devices['Desktop Chrome'],
      launchOptions: {
        args: WEBGPU_LAUNCH_ARGS,
      },
    },
    // The render transport specs (#253), and the renderer-agnostic ones that
    // run on both WebGPU transports here and on WebGL in `chromium`
    // (`RENDERER_SESSIONS` in e2e/helpers/renderer.ts).
    testMatch: /webgpu-smoke\.spec\.ts|webgpu-bgra-export\.spec\.ts|webgpu-device-loss\.spec\.ts|compare-.*\.spec\.ts|preset-compare\.spec\.ts|graph-executor\.spec\.ts|motion-flow-parity\.spec\.ts|render-transport\.spec\.ts|video-export-transport\.spec\.ts|frame-clock\.spec\.ts|render-churn\.spec\.ts|webgpu-image-switch\.spec\.ts/,
  },
  // WebGPU in Firefox and WebKit (#228): the smoke and the executor specs,
  // on each browser's default WebGPU exposure. Where the build exposes no
  // `navigator.gpu` (Playwright's Linux builds, today) each test skips on
  // `webgpuProbe.stage` (`waitForWebGPU`), and the frame goldens, which are
  // SwiftShader's, become a content check. Non-blocking in CI.
  {
    name: 'firefox',
    use: { ...devices['Desktop Firefox'] },
    testMatch: /webgpu-smoke\.spec\.ts|graph-executor\.spec\.ts/,
  },
  {
    name: 'webkit',
    use: { ...devices['Desktop Safari'] },
    testMatch: /webgpu-smoke\.spec\.ts|graph-executor\.spec\.ts/,
  },
];

/**
 * The production build's smoke (`PW_SERVER=preview`): the WebGL boot specs, and
 * the WASM engine spec, which loads the closure-compiled glue on the main thread
 * and in both workers — the lanes a minified, base-`./` build can break while
 * the dev server stays green.
 */
const PREVIEW_PROJECTS = [
  {
    name: 'chromium-preview',
    use: { ...devices['Desktop Chrome'] },
    testMatch: /smoke\.spec\.ts|wasm-engine\.spec\.ts/,
    testIgnore: /[\\/]release[\\/]|webgpu-smoke\.spec\.ts/,
  },
];

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    headless: true,
  },
  projects: PREVIEW ? PREVIEW_PROJECTS : DEV_PROJECTS,
  webServer: {
    // `--strictPort`: fail if the port is taken instead of drifting to the next
    // one, which would leave `url` below answering from some other server.
    command: PREVIEW
      ? `npm run preview -- --port ${PORT} --strictPort`
      : `npm run dev -- --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: REUSE_SERVER,
    timeout: 120000,
  },
});
