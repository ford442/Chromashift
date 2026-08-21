/**
 * Documented canvas / device options shared by WebGPU and WebGL2 bootstrap paths.
 * See docs/gpu-bootstrap.md for rationale and browser notes.
 */

export interface RendererCanvasOptions {
  antialias: boolean;
  preserveDrawingBuffer?: boolean;
  xrCompatible?: boolean;
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
    preserveDrawingBuffer: true,
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
