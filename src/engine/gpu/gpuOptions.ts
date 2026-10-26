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
  /**
   * Ask for a low-latency (`desynchronized`) WebGL2 canvas. Off by default; it
   * is resolved by {@link resolveWebGL2Desynchronized}, which refuses it while
   * `preserveDrawingBuffer` is on — the two fight over the same buffer, and a
   * desynchronized canvas blanks the captures preserve exists for.
   */
  desynchronized?: boolean;
  xrCompatible?: boolean;
}

/**
 * Force the WebGL2 drawing buffer on (`=1`) or off (`=0`) from the URL.
 * Overrides the automation heuristic below; mainly an escape hatch for
 * reproducing a capture problem in a normal browser tab.
 */
const PRESERVE_DRAWING_BUFFER_PARAM = 'preserve_drawing_buffer';

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

/**
 * Opt in to a low-latency (`desynchronized`) WebGL2 canvas with `=1`. Honoured
 * only when preserve-drawing-buffer resolved off — see
 * {@link resolveWebGL2Desynchronized}.
 */
const DESYNCHRONIZED_PARAM = 'desynchronized';

/**
 * Decide `desynchronized` for the live WebGL2 diagnostic session, given what
 * {@link resolveWebGL2PreserveDrawingBuffer} decided.
 *
 * Off unless `?desynchronized=1`, and off whatever the URL says while
 * preserve-drawing-buffer is on: low-latency presentation can hand the
 * compositor the buffer before `readPixels` / `toBlob` / a Playwright
 * screenshot reads it, so the capture comes back blank.
 */
export function resolveWebGL2Desynchronized(preserveDrawingBuffer: boolean): boolean {
  if (preserveDrawingBuffer || typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get(DESYNCHRONIZED_PARAM) === '1';
  } catch {
    return false;
  }
}

/**
 * WebGPU features Chromashift actually consumes when the adapter grants them.
 * None are required for the core renderer — missing features skip the
 * corresponding path (CPU timing only, rgba8unorm internal targets).
 *
 * - `timestamp-query` → `GpuTimestampProfiler` (Diagnostics Perf HUD)
 * - `rg11b10ufloat-renderable` → HDR layer/tracer/compositor targets
 *   (`selectInternalColorFormat`); additive tracers otherwise clip in rgba8
 * - `texture-formats-tier1` → `r8uint` storage textures, which the GPU
 *   image-analysis lane writes its classification mask into
 *   (`supportsR8uintStorage`); the WASM/TS lanes produce it otherwise
 *
 * `float32-filterable` is not requested: we never sample r32float/rgba32float.
 * `rgba16float` / `rg11b10ufloat` filtering is core WebGPU.
 */
export const CHROMASHIFT_OPTIONAL_FEATURES = [
  'timestamp-query',
  'rg11b10ufloat-renderable',
  'texture-formats-tier1',
] as const satisfies readonly GPUFeatureName[];

/** 8-bit LDR internal targets — default when HDR renderables are not granted. */
export const INTERNAL_COLOR_FORMAT_LDR: GPUTextureFormat = 'rgba8unorm';
/** Packed HDR internal targets — used only when `rg11b10ufloat-renderable` is granted. */
export const INTERNAL_COLOR_FORMAT_HDR: GPUTextureFormat = 'rg11b10ufloat';

/**
 * Swap-chain format for `hdr-extended` presentation. The 8-bit preferred
 * formats cannot carry values above 1.0, so extended tone mapping only has
 * headroom to show on a float canvas.
 */
export const HDR_CANVAS_FORMAT: GPUTextureFormat = 'rgba16float';

/** `sdr` = today's clamped sRGB present; `hdr-extended` = opt-in Canvas HDR. */
export type CanvasPresentation = 'sdr' | 'hdr-extended';

export type DisplayColorSpace = Extract<PredefinedColorSpace, 'srgb' | 'display-p3'>;

function isDisplayColorSpace(value: unknown): value is DisplayColorSpace {
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

/**
 * Diagnostics note for an HDR canvas over 8-bit internal targets: the frame
 * already clipped before it reached the extended present, so HDR buys nothing.
 * Deliberately not fixed by requesting `rgba16float`/`float32-filterable`.
 */
export function canvasHdrInternalNote(
  presentingHdr: boolean,
  internalFormat: GPUTextureFormat,
): string | null {
  if (!presentingHdr || internalFormat === INTERNAL_COLOR_FORMAT_HDR) return null;
  return `canvas HDR requested, internal targets are ${internalFormat} — highlights still clip`;
}

/** WebGL2 internal targets when the context cannot render `RGBA16F`. */
export const WEBGL_INTERNAL_FORMAT_LDR = 'rgba8';
/** WebGL2 internal targets under `EXT_color_buffer_half_float` / `EXT_color_buffer_float`. */
export const WEBGL_INTERNAL_FORMAT_HDR = 'rgba16f';
export type WebGLInternalFormat = typeof WEBGL_INTERNAL_FORMAT_LDR | typeof WEBGL_INTERNAL_FORMAT_HDR;

/**
 * Diagnostics note for a WebGL2 context whose layer / tracer targets are 8-bit
 * — the WebGL twin of {@link canvasHdrInternalNote}. This is not Canvas HDR
 * (WebGL has no extended present); it says the tracers clip in the pool.
 * `null` when the targets are half-float.
 */
export function webglInternalFormatNote(format: WebGLInternalFormat): string | null {
  if (format === WEBGL_INTERNAL_FORMAT_HDR) return null;
  return 'WebGL internal targets are rgba8 (no renderable RGBA16F) — additive tracers clip';
}

export function internalColorFormatBytesPerPixel(format: GPUTextureFormat): number {
  if (format === 'rgba16float') return 8;
  return 4;
}

/**
 * `requestAdapter` power-preference attempt list, in order.
 *
 * These are **adapter** attempts, not the two `requestDevice` strategies in
 * `webgpu/adapter.ts` (`default-limits` → `no-optional-features`). They are easy
 * to confuse and count separately: an adapter is requested once per device
 * (Retry GPU after a loss needs a fresh one), then at most
 * `MAX_DEVICE_REQUEST_STRATEGIES` device requests run against it.
 *
 * `high-performance` first (discrete GPU on a laptop), `low-power` second (some
 * Chrome builds return null for `high-performance` under battery saver), then a
 * preference-less call so a machine with exactly one adapter still boots.
 */
export const WEBGPU_POWER_PREFERENCE_ATTEMPTS = [
  'high-performance',
  'low-power',
] as const satisfies readonly GPUPowerPreference[];

/**
 * `getContext('webgl2')` attempts, in order — the WebGL twin of
 * {@link WEBGPU_POWER_PREFERENCE_ATTEMPTS}, ending in the same
 * preference-less try. `null` omits `powerPreference`, which a machine that
 * declines both explicit preferences (battery saver, a hybrid GPU exposing
 * only the low-power one) may still grant.
 *
 * A null `getContext` creates nothing on the canvas, so the next attempt is a
 * fresh request. Once one succeeds the context is sticky: the canvas returns
 * that context (or null) to every later call, whatever the attributes.
 */
export const WEBGL2_POWER_PREFERENCE_ATTEMPTS = [
  'high-performance',
  'low-power',
  null,
] as const satisfies readonly (WebGLPowerPreference | null)[];

export const RENDERER_CANVAS_OPTIONS_MATRIX = {
  webgpu: {
    powerPreference: 'high-performance' as GPUPowerPreference,
    alphaMode: 'opaque' as GPUCanvasAlphaMode,
    colorSpace: 'srgb' as PredefinedColorSpace,
    usage: 'RENDER_ATTACHMENT | COPY_SRC',
    toneMapping: 'standard (when supported by configure); extended + rgba16float under Canvas HDR',
    msaa: 'layer pass sampleCount 1 or 4 (renderer toggle)',
  },
  webgl2: {
    alpha: false,
    // The default framebuffer is never multisampled. Every pass draws into an
    // FBO and the canvas is only the compositor's / upsample blit's target, so
    // the flag antialiased nothing. MSAA is the band layers' multisample
    // renderbuffer instead, toggled by `setAntialiasing` on the same context.
    antialias: false,
    msaa: 'band-layer passes render to a samples:4 renderbuffer, blitted to the layer texture (renderer toggle)',
    powerPreference: 'WEBGL2_POWER_PREFERENCE_ATTEMPTS: high-performance → low-power → omitted',
    // Opt-in via ?desynchronized=1, never alongside preserveDrawingBuffer
    // (resolveWebGL2Desynchronized).
    desynchronized: false,
    internalFormat: 'rgba16f layer/tracer targets when RGBA16F renders (EXT_color_buffer_half_float / _float), else rgba8',
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

/**
 * The attributes for one `getContext('webgl2')` attempt. `powerPreference` is
 * an entry of {@link WEBGL2_POWER_PREFERENCE_ATTEMPTS}; `null` omits the key.
 * `options.antialias` is the renderer's MSAA toggle and never reaches the
 * context (see the matrix).
 */
export function getWebGL2ContextAttributes(
  options: RendererCanvasOptions,
  powerPreference: WebGLPowerPreference | null = WEBGL2_POWER_PREFERENCE_ATTEMPTS[0],
): WebGLContextAttributes {
  const preserveDrawingBuffer =
    options.preserveDrawingBuffer ?? RENDERER_CANVAS_OPTIONS_MATRIX.webgl2.preserveDrawingBuffer;
  return {
    alpha: RENDERER_CANVAS_OPTIONS_MATRIX.webgl2.alpha,
    antialias: RENDERER_CANVAS_OPTIONS_MATRIX.webgl2.antialias,
    preserveDrawingBuffer,
    // Never with preserve, whatever the caller passed (resolveWebGL2Desynchronized).
    desynchronized: !preserveDrawingBuffer
      && (options.desynchronized ?? RENDERER_CANVAS_OPTIONS_MATRIX.webgl2.desynchronized),
    depth: RENDERER_CANVAS_OPTIONS_MATRIX.webgl2.depth,
    stencil: RENDERER_CANVAS_OPTIONS_MATRIX.webgl2.stencil,
    premultipliedAlpha: RENDERER_CANVAS_OPTIONS_MATRIX.webgl2.premultipliedAlpha,
    ...(powerPreference === null ? {} : { powerPreference }),
    xrCompatible: options.xrCompatible,
  };
}
