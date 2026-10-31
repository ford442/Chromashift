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
