import type { Page } from '@playwright/test';

export async function waitForWebGL(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(() => window.usingWebGL === true, undefined, { timeout });
}

export async function waitForWebGPU(page: Page, timeout = 45_000): Promise<void> {
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
