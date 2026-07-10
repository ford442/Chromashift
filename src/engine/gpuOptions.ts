/**
 * Documented canvas / device options shared by WebGPU and WebGL2 bootstrap paths.
 * See docs/gpu-bootstrap.md for rationale and browser notes.
 */

export interface RendererCanvasOptions {
  antialias: boolean;
}

/** Maximum 2D texture edge Chromashift targets (8K long edge). Capped by adapter limits. */
export const CHROMASHIFT_TARGET_MAX_TEXTURE = 8192;

/**
 * WebGPU features Chromashift may use when present. None are required for the
 * core renderer — missing features are logged at bootstrap and skipped.
 */
export const CHROMASHIFT_OPTIONAL_FEATURES = [
  'timestamp-query',
  'float32-filterable',
  'rg11b10ufloat-renderable',
] as const satisfies readonly GPUFeatureName[];

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
    preserveDrawingBuffer: RENDERER_CANVAS_OPTIONS_MATRIX.webgl2.preserveDrawingBuffer,
    depth: RENDERER_CANVAS_OPTIONS_MATRIX.webgl2.depth,
    stencil: RENDERER_CANVAS_OPTIONS_MATRIX.webgl2.stencil,
    premultipliedAlpha: RENDERER_CANVAS_OPTIONS_MATRIX.webgl2.premultipliedAlpha,
  };
}
