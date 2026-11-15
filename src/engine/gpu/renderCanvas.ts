/**
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
