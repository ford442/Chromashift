import { test, type Page } from '@playwright/test';
import { readDiagnostic, waitForDiagnostic } from './diagnostics';

/**
 * Projects where a browser without WebGPU is a skip, not a failure: Firefox
 * and WebKit run the WebGPU specs wherever their build exposes it (#228).
 * In Chromium a missing `navigator.gpu` is a failure.
 */
const SKIP_WITHOUT_WEBGPU = new Set(['firefox', 'webkit']);

/**
 * Skip the test when this browser build exposes no `navigator.gpu`: the
 * page's boot probe reports it as `window.webgpuProbe.stage ===
 * 'navigator-gpu'`. Any later stage (no adapter, a device that fails) still
 * fails the test. Without `navigator.gpu` there is no need to wait for the app
 * to boot and say so, which a slow first load can push past the test's timeout.
 */
async function skipWithoutWebGpu(page: Page, timeout: number): Promise<void> {
  const project = test.info().project.name;
  if (!SKIP_WITHOUT_WEBGPU.has(project)) return;
  await page.waitForFunction(() => window.webgpuProbe !== undefined || !navigator.gpu, undefined, { timeout });
  const probe = await readDiagnostic(page, 'webgpuProbe');
  const exposed = probe ? probe.stage !== 'navigator-gpu' : await page.evaluate(() => !!navigator.gpu);
  test.skip(!exposed, `${probe?.browser ?? project} exposes no navigator.gpu (webgpuProbe.stage: ${probe?.stage ?? 'not yet published'})`);
}

export async function waitForWebGL(page: Page, timeout = 30_000): Promise<void> {
  await waitForDiagnostic(page, 'usingWebGL', true, timeout);
}

export async function waitForWebGPU(page: Page, timeout = 45_000): Promise<void> {
  await skipWithoutWebGpu(page, timeout);
  try {
    // Probe success sets webgpuProbe.ok before requestDevice. Wait for the
    // renderer breadcrumb, which is published only after device + swapchain.
    await page.waitForFunction(
      () => window.rendererType === 'webgpu' && window.usingWebGPU === true,
      undefined,
      { timeout },
    );
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      rendererType: window.rendererType,
      usingWebGPU: window.usingWebGPU,
      usingWebGL: window.usingWebGL,
      rendererFallbackReason: window.rendererFallbackReason ?? null,
      hasNavigatorGpu: typeof navigator !== 'undefined' && !!navigator.gpu,
      gpuErrorVisible: document.body?.innerText?.includes('not supported') ?? false,
    }));
    throw new Error(
      `WebGPU bootstrap timed out after ${timeout}ms: ${JSON.stringify(diagnostics)}`,
      { cause: error },
    );
  }
}

/**
 * Arm `window.__renderDebug` (`src/engine/render/debug.ts`) before navigation:
 * the frame readback, the simulated device loss and the render clock's
 * timeline. Set in storage rather than the URL, so the URL stays the one under
 * test. Must run before `page.goto` — the service reads it when it boots.
 */
export async function armRenderDebug(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('chromashift:renderDebug', '1');
    } catch {
      // An opaque origin (about:blank) has no storage; the app's page does.
    }
  });
}

/**
 * The sessions a renderer-agnostic spec runs in (#253): the WebGL backend in
 * the `chromium` project, and WebGPU on both render transports — the render
 * worker and `?renderer=main` — in `chromium-webgpu`.
 */
export interface RendererSession {
  name: string;
  /** The `renderer=` query parameter, without the `?`. */
  query: string;
  project: 'chromium' | 'chromium-webgpu';
  transport: 'main' | 'worker';
  /** Resolves once the session's renderer is up on the expected transport. */
  ready: (page: Page) => Promise<void>;
}

export const RENDERER_SESSIONS: readonly RendererSession[] = [
  {
    name: 'webgl',
    query: 'renderer=webgl',
    project: 'chromium',
    transport: 'main',
    ready: (page) => waitForWebGL(page),
  },
  {
    name: 'webgpu, worker transport',
    query: 'renderer=webgpu',
    project: 'chromium-webgpu',
    transport: 'worker',
    ready: async (page) => {
      await waitForWebGPU(page);
      await waitForDiagnostic(page, 'renderTransport', 'worker');
    },
  },
  {
    name: 'webgpu, main transport',
    query: 'renderer=main',
    project: 'chromium-webgpu',
    transport: 'main',
    ready: async (page) => {
      await waitForWebGPU(page);
      await waitForDiagnostic(page, 'renderTransport', 'main');
    },
  },
];

/** Skip the current test unless it runs in `session`'s project. Call from `beforeEach`. */
export function skipUnlessSessionProject(session: RendererSession): void {
  const project = test.info().project.name;
  test.skip(project !== session.project, `${session.name} runs in the ${session.project} project`);
}
