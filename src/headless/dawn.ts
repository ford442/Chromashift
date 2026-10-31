import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * WebGPU in Node through Dawn's bindings (the `webgpu` package): the one
 * place the headless renderer gets a `navigator.gpu`.
 *
 * Nothing else here talks to Dawn. The adapter and device come from the
 * page's own gate — its power-preference attempts and two `requestDevice`
 * strategies (`engine/webgpu/adapter.ts`) — so a headless session asks for a
 * device exactly the way a browser tab does.
 */

/**
 * Which Vulkan driver Dawn runs on. `system` is whatever the machine has — a
 * GPU, or Mesa's lavapipe on a GPU-less box. `swiftshader` is the Vulkan
 * SwiftShader that Playwright's Chromium ships: the rasterizer the E2E WebGPU
 * project draws with, so a frame rendered here on it is byte-identical to the
 * browser's (docs/HEADLESS.md § Which rasterizer). The pixel goldens are
 * pinned on it.
 */
export type HeadlessRasterizer = 'system' | 'swiftshader';

/**
 * The SwiftShader Vulkan ICD manifest beside Playwright's Chromium, or
 * `null` when that browser is not installed (`npx playwright install
 * chromium`). `CHROMASHIFT_VK_ICD` names another manifest.
 */
export async function findSwiftShaderIcd(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (env.CHROMASHIFT_VK_ICD) return env.CHROMASHIFT_VK_ICD;
  try {
    const { chromium } = await import('@playwright/test');
    const manifest = join(dirname(chromium.executablePath()), 'vk_swiftshader_icd.json');
    return existsSync(manifest) ? manifest : null;
  } catch {
    return null;
  }
}

export interface DawnGpu {
  gpu: GPU;
  /**
   * Drop `navigator.gpu`. dawn.node keeps the process alive for as long as
   * something references the object `create` returned, so a CLI that never
   * lets go never exits.
   */
  release(): void;
}

/**
 * Comma-separated Dawn options from `CHROMASHIFT_DAWN_FLAGS`, e.g.
 * `backend=vulkan` or `adapter=llvmpipe` (see the `webgpu` package README).
 */
function dawnFlagsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.CHROMASHIFT_DAWN_FLAGS ?? '')
    .split(/\s+/)
    .map((flag) => flag.trim())
    .filter(Boolean);
}

export async function installDawnGpu(
  flags: readonly string[] = dawnFlagsFromEnv(),
  rasterizer: HeadlessRasterizer = 'system',
): Promise<DawnGpu> {
  if (rasterizer === 'swiftshader') {
    const icd = await findSwiftShaderIcd();
    if (!icd) {
      throw new Error('SwiftShader Vulkan not found: run `npx playwright install chromium`, or set CHROMASHIFT_VK_ICD.');
    }
    // The Vulkan loader reads these when Dawn creates its instance. Both
    // names: VK_DRIVER_FILES is the current one, VK_ICD_FILENAMES the old.
    process.env.VK_DRIVER_FILES = icd;
    process.env.VK_ICD_FILENAMES = icd;
  }
  const { create, globals } = await import('webgpu');
  // GPUBufferUsage, GPUTextureUsage, GPUShaderStage, GPUMapMode, … — the
  // constants the engine reads as globals, as it does in a browser.
  Object.assign(globalThis, globals);
  const gpu = create([...flags]);
  // Node 20 has no `navigator`; 21+ has one without `gpu`.
  if (typeof globalThis.navigator === 'undefined') {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
  }
  Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
  return {
    gpu,
    release: () => {
      Reflect.deleteProperty(globalThis.navigator, 'gpu');
    },
  };
}
