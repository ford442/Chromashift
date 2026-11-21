/**
 * Every context Chromashift creates goes through `src/engine/gpu/` — this
 * file for WebGPU / WebGL2 and the device request, `readbackContext.ts` for
 * 2D — so its attributes come from one place (`gpuOptions.ts`). A lint rule
 * (`eslint.config.js`) bans a bare `getContext` / `configure` /
 * `requestDevice` anywhere else in `src/`.
 *
 * A canvas the renderer presents to: the page's `<canvas>`, or — in the
 * render worker (#253) — the `OffscreenCanvas` the page transferred to it.
 * Both have the `getContext('webgpu')` the WebGPU path needs; only the
 * element has the WebGL2 context and DOM events the diagnostic backend uses.
 */
export type RenderCanvas = HTMLCanvasElement | OffscreenCanvas;

/** A transferred canvas (the render worker's) — the WebGL backend never draws one. */
export function isOffscreenCanvas(canvas: RenderCanvas): canvas is OffscreenCanvas {
  return typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas;
}

/** `getContext('webgpu')` on either kind; the union has no common overload to call. */
export function webGpuContextOf(canvas: RenderCanvas): GPUCanvasContext | null {
  return isOffscreenCanvas(canvas) ? canvas.getContext('webgpu') : canvas.getContext('webgpu');
}

/**
 * One `getContext('webgl2')` attempt with `attributes` — always from
 * `getWebGL2ContextAttributes` (`gpuOptions.ts`); `webgl/webgl2Context.ts`
 * walks the attempts.
 */
export function webgl2ContextOf(
  canvas: HTMLCanvasElement,
  attributes: WebGLContextAttributes,
): WebGL2RenderingContext | null {
  return canvas.getContext('webgl2', attributes);
}

/**
 * Configure a WebGPU presentation context (a canvas's, or an offscreen
 * target's) — `configuration` always from `buildWebGpuCanvasConfiguration`
 * (`webgpu/canvasConfig.ts`), which derives it from the options matrix.
 */
export function configurePresentation(
  context: { configure(configuration: GPUCanvasConfiguration): undefined | void },
  configuration: GPUCanvasConfiguration,
): void {
  context.configure(configuration);
}

/**
 * The one `requestDevice` call: `webgpu/adapter.ts`'s device gate makes it,
 * with the strategy's descriptor, and nothing else asks for a device (a
 * second device is the regression `gpu-chores` exists to make impossible).
 */
export function requestAdapterDevice(adapter: GPUAdapter, descriptor: GPUDeviceDescriptor): Promise<GPUDevice> {
  return adapter.requestDevice(descriptor);
}
