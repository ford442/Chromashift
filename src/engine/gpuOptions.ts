/**
 * Documented canvas / device options shared by WebGPU and WebGL2 bootstrap paths.
 * See docs/gpu-bootstrap.md for rationale and browser notes.
 */

export interface RendererCanvasOptions {
  antialias: boolean;
  /**
   * Opt in to keeping the WebGL2 drawing buffer between frames. Defaults to
   * `false` (see {@link RENDERER_CANVAS_OPTIONS_MATRIX}): the live diagnostic
   * session never reads the canvas back, and preserving costs an extra copy
   * per frame. Set `true` only on a readback path — `canvas.toBlob` /
   * `toDataURL` / `gl.readPixels` outside the draw call, or a Playwright
   * element screenshot — which otherwise captures a cleared buffer.
   */
  preserveDrawingBuffer?: boolean;
  xrCompatible?: boolean;
}

/**
 * Force the WebGL2 drawing buffer on (`=1`) or off (`=0`) from the URL.
 * Overrides the automation heuristic below; mainly an escape hatch for
 * reproducing a capture problem in a normal browser tab.
 */
export const PRESERVE_DRAWING_BUFFER_PARAM = 'preserve_drawing_buffer';

function readPreserveDrawingBufferParam(): boolean | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = new URLSearchParams(window.location.search).get(PRESERVE_DRAWING_BUFFER_PARAM);
    if (raw === null) return null;
    // Bare `?preserve_drawing_buffer` (empty value) reads as on.
    return raw !== '0' && raw.toLowerCase() !== 'false';
  } catch {
    return null;
  }
}

/**
 * Decide `preserveDrawingBuffer` for the live WebGL2 diagnostic session.
 *
 * Order: explicit URL param → automation → off. The automation branch is what
 * keeps the Playwright specs working: they capture the canvas with
 * `canvas.screenshot()` / `toBlob` / `toDataURL` well after the frame that drew
 * it, which needs the buffer preserved, and they drive the page through
 * WebDriver rather than passing a flag on all ~40 navigations.
 *
 * WebXR passes `preserveDrawingBuffer: false` explicitly and is unaffected.
 */
export function resolveWebGL2PreserveDrawingBuffer(): boolean {
  const override = readPreserveDrawingBufferParam();
  if (override !== null) return override;
  if (typeof navigator !== 'undefined' && navigator.webdriver === true) return true;
  return RENDERER_CANVAS_OPTIONS_MATRIX.webgl2.preserveDrawingBuffer;
}

/** Maximum 2D texture edge Chromashift targets (8K long edge). Capped by adapter limits. */
export const CHROMASHIFT_TARGET_MAX_TEXTURE = 8192;

/**
 * WebGPU features Chromashift actually consumes when the adapter grants them.
 * None are required for the core renderer — missing features skip the
 * corresponding path (CPU timing only, rgba8unorm internal targets).
 *
 * - `timestamp-query` → `GpuTimestampProfiler` (Diagnostics Perf HUD)
 * - `rg11b10ufloat-renderable` → HDR layer/tracer/compositor targets
 *   (`selectInternalColorFormat`); additive tracers otherwise clip in rgba8
 *
 * `float32-filterable` is not requested: we never sample r32float/rgba32float.
 * `rgba16float` / `rg11b10ufloat` filtering is core WebGPU.
 */
export const CHROMASHIFT_OPTIONAL_FEATURES = [
  'timestamp-query',
  'rg11b10ufloat-renderable',
] as const satisfies readonly GPUFeatureName[];

/** 8-bit LDR internal targets — default when HDR renderables are not granted. */
export const INTERNAL_COLOR_FORMAT_LDR: GPUTextureFormat = 'rgba8unorm';
/** Packed HDR internal targets — used only when `rg11b10ufloat-renderable` is granted. */
export const INTERNAL_COLOR_FORMAT_HDR: GPUTextureFormat = 'rg11b10ufloat';

export type DisplayColorSpace = Extract<PredefinedColorSpace, 'srgb' | 'display-p3'>;

export function isDisplayColorSpace(value: unknown): value is DisplayColorSpace {
  return value === 'srgb' || value === 'display-p3';
}

export function parseDisplayColorSpace(value: unknown): DisplayColorSpace {
  return isDisplayColorSpace(value) ? value : 'srgb';
}

/**
 * Choose the 5-pass internal color format from granted device features.
 * Never throws — rgba8unorm is always legal.
 */
export function selectInternalColorFormat(device: Pick<GPUDevice, 'features'>): GPUTextureFormat {
  if (device.features.has('rg11b10ufloat-renderable')) {
    return INTERNAL_COLOR_FORMAT_HDR;
  }
  return INTERNAL_COLOR_FORMAT_LDR;
}

export function internalColorFormatBytesPerPixel(format: GPUTextureFormat): number {
  if (format === 'rgba16float') return 8;
  return 4;
}

/**
 * `requestAdapter` power-preference attempt list, in order.
 *
 * These are **adapter** attempts, not the three `requestDevice` strategies in
 * `gpuBootstrap.ts` (`default-limits` → `canvas-limits` →
 * `no-optional-features`). They are easy to confuse and count separately: the
 * adapter is requested once per page, then at most `MAX_DEVICE_REQUEST_STRATEGIES`
 * device requests run against it.
 *
 * `high-performance` first (discrete GPU on a laptop), `low-power` second (some
 * Chrome builds return null for `high-performance` under battery saver), then a
 * preference-less call so a machine with exactly one adapter still boots.
 */
export const WEBGPU_POWER_PREFERENCE_ATTEMPTS = [
  'high-performance',
  'low-power',
] as const satisfies readonly GPUPowerPreference[];

export const RENDERER_CANVAS_OPTIONS_MATRIX = {
  webgpu: {
    powerPreference: 'high-performance' as GPUPowerPreference,
    alphaMode: 'opaque' as GPUCanvasAlphaMode,
    colorSpace: 'srgb' as PredefinedColorSpace,
    usage: 'RENDER_ATTACHMENT | COPY_SRC',
    toneMapping: 'standard (when supported by configure)',
    msaa: 'layer pass sampleCount 1 or 4 (renderer toggle)',
  },
  webgl2: {
    alpha: false,
    antialias: 'matches RendererCanvasOptions.antialias',
    // Off for the live diagnostic session — nothing reads the canvas back, and
    // it matches WebXR, which already passes false. Screenshot / readback
    // callers opt in via RendererCanvasOptions.preserveDrawingBuffer (see
    // resolveWebGL2PreserveDrawingBuffer).
    preserveDrawingBuffer: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
  },
} as const;

export function getWebGL2ContextAttributes(
  options: RendererCanvasOptions,
): WebGLContextAttributes {
  return {
    alpha: RENDERER_CANVAS_OPTIONS_MATRIX.webgl2.alpha,
    antialias: options.antialias,
    preserveDrawingBuffer:
      options.preserveDrawingBuffer ?? RENDERER_CANVAS_OPTIONS_MATRIX.webgl2.preserveDrawingBuffer,
    depth: RENDERER_CANVAS_OPTIONS_MATRIX.webgl2.depth,
    stencil: RENDERER_CANVAS_OPTIONS_MATRIX.webgl2.stencil,
    premultipliedAlpha: RENDERER_CANVAS_OPTIONS_MATRIX.webgl2.premultipliedAlpha,
    xrCompatible: options.xrCompatible,
  };
}
