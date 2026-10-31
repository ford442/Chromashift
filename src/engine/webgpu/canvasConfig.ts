/**
 * WebGPU canvas configuration: SDR / `hdr-extended` presentation, and the
 * page-lifetime tone-mapping and HDR probes that keep every reconfigure cheap.
 */
import { HDR_CANVAS_FORMAT, type CanvasPresentation } from '../gpu/gpuOptions';
import { publishDiagnostics } from '../diagnostics';
import type { PresentationTarget } from './presentationTarget';

export interface WebGpuCanvasOptions {
  colorSpace?: PredefinedColorSpace;
  toneMappingMode?: GPUCanvasToneMappingMode;
  /**
   * `hdr-extended` configures an `rgba16float` canvas with extended tone
   * mapping; `sdr` (the default) is the preferred format clipped at white.
   * Falls back to `sdr` wherever the UA cannot honour it.
   */
  presentation?: CanvasPresentation;
}

export function buildWebGpuCanvasConfiguration(
  device: GPUDevice,
  format: GPUTextureFormat,
  options?: WebGpuCanvasOptions,
): GPUCanvasConfiguration {
  const hdr = options?.presentation === 'hdr-extended';
  const config: GPUCanvasConfiguration = {
    device,
    format: hdr ? HDR_CANVAS_FORMAT : format,
    alphaMode: 'opaque',
    // Render target only. Nothing copies out of the swap chain — previews,
    // exports and the collision-stats blit all read offscreen targets — and
    // an unused COPY_SRC can keep the compositor off its scanout path.
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
    colorSpace: options?.colorSpace ?? 'srgb',
  };

  if (hdr) {
    config.toneMapping = { mode: 'extended' };
  } else if (options?.toneMappingMode) {
    config.toneMapping = { mode: options.toneMappingMode };
  }

  return config;
}

/**
 * Page-lifetime capability bit for canvas tone mapping.
 *
 * `null` = not yet determined. Chromashift reconfigures the canvas on every
 * resize, DPR change, and Display-P3 toggle, so the old catch-and-retry cost a
 * thrown exception *per configure* on a browser without tone mapping. Both the
 * probe and the cache exist so the common path — every configure after the
 * first — decides from a boolean.
 */
let canvasToneMappingSupported: boolean | null = null;

/**
 * The same page-lifetime bit for `hdr-extended` (an `rgba16float` canvas with
 * `toneMapping: 'extended'`), so a refused HDR configure is not retried on
 * every resize either.
 */
let canvasHdrSupported: boolean | null = null;

/** Test-only: forget the probed capability so cases do not leak into each other. */
export function resetCanvasToneMappingSupportForTests(): void {
  canvasToneMappingSupported = null;
  canvasHdrSupported = null;
}

/** What the HDR probe concluded, or `null` before one ran. */
export function getCanvasHdrSupport(): boolean | null {
  return canvasHdrSupported;
}

/** What the probe concluded, or `null` before any canvas has been configured. */
export function getCanvasToneMappingSupport(): boolean | null {
  return canvasToneMappingSupported;
}

/**
 * Feature-detect tone mapping without provoking an exception, where the browser
 * lets us: `getConfiguration()` (Chrome 131+) echoes back the applied
 * configuration, so a `toneMapping` that the UA dropped as an unknown
 * dictionary member is visible as an absent key.
 *
 * Returns `null` when the browser gives us nothing to read, in which case the
 * caller falls back to configure-and-catch — once.
 */
function probeToneMappingFromConfiguration(
  context: PresentationTarget,
  mode: GPUCanvasToneMappingMode = 'standard',
  format?: GPUTextureFormat,
): boolean | null {
  // Absent on a canvas context before Chrome 131.
  const readConfiguration = context.getConfiguration;
  if (typeof readConfiguration !== 'function') return null;
  try {
    const applied = readConfiguration.call(context);
    if (!applied) return null;
    return applied.toneMapping?.mode === mode && (format === undefined || applied.format === format);
  } catch {
    return null;
  }
}

/**
 * Configure for `hdr-extended`. Returns false (leaving the canvas unconfigured
 * for the caller's SDR configure) when the UA throws or silently drops the
 * format or tone mapping. The result is cached either way.
 */
function tryConfigureHdrCanvas(
  context: PresentationTarget,
  device: GPUDevice,
  format: GPUTextureFormat,
  options: WebGpuCanvasOptions,
): boolean {
  if (canvasHdrSupported === false) return false;
  try {
    context.configure(buildWebGpuCanvasConfiguration(device, format, options));
  } catch (error) {
    canvasHdrSupported = false;
    console.warn('[Chromashift:GPU] Canvas HDR configure failed; presenting SDR', error);
    return false;
  }
  if (canvasHdrSupported === null) {
    // `null` (no getConfiguration) counts as support, same as tone mapping.
    canvasHdrSupported = probeToneMappingFromConfiguration(context, 'extended', HDR_CANVAS_FORMAT) !== false;
    if (!canvasHdrSupported) {
      console.info('[Chromashift:GPU] Canvas HDR not supported; presenting SDR');
    }
  }
  return canvasHdrSupported;
}

/**
 * Configure a canvas. `presentation: 'hdr-extended'` is honoured when the UA
 * accepts it; otherwise — and always for `sdr` — the preferred format with
 * `'standard'` tone mapping. Never throws for an unsupported option, and never
 * leaves the canvas unconfigured (a black canvas). Returns the presentation
 * actually applied.
 */
export function configureWebGpuCanvas(
  context: PresentationTarget,
  device: GPUDevice,
  format: GPUTextureFormat,
  options?: WebGpuCanvasOptions,
): CanvasPresentation {
  if (options?.presentation === 'hdr-extended'
    && tryConfigureHdrCanvas(context, device, format, options)) {
    return 'hdr-extended';
  }
  configureSdrCanvas(context, device, format, { ...options, presentation: 'sdr' });
  return 'sdr';
}

function configureSdrCanvas(
  context: PresentationTarget,
  device: GPUDevice,
  format: GPUTextureFormat,
  options: WebGpuCanvasOptions,
): void {
  const requested: WebGpuCanvasOptions = {
    ...options,
    toneMappingMode: options?.toneMappingMode ?? 'standard',
  };

  // Known-unsupported: configure straight away, no tone mapping, no throw.
  if (canvasToneMappingSupported === false) {
    context.configure(buildWebGpuCanvasConfiguration(device, format, options));
    return;
  }

  // Known-supported, or not yet probed. The try/catch below can only fire on
  // the not-yet-probed pass, and its result is cached either way.
  try {
    context.configure(buildWebGpuCanvasConfiguration(device, format, requested));
  } catch (error) {
    canvasToneMappingSupported = false;
    console.warn(
      '[Chromashift:GPU] Canvas configure with tone mapping failed; '
      + 'disabling it for this page and retrying without',
      error,
    );
    context.configure(buildWebGpuCanvasConfiguration(device, format, options));
    return;
  }

  if (canvasToneMappingSupported !== null) return;

  const probed = probeToneMappingFromConfiguration(context);
  if (probed === false) {
    // The UA accepted the configure but silently dropped the member. Record it
    // so later configures skip the key entirely; the current frame is already
    // configured correctly (tone mapping simply is not applied).
    canvasToneMappingSupported = false;
    console.info('[Chromashift:GPU] Canvas tone mapping not supported; configuring without it');
    return;
  }
  // `true`, or `null` when the browser exposes no getConfiguration — treat an
  // un-thrown configure as support so the fast path is taken next time.
  canvasToneMappingSupported = true;
}

/**
 * One `hdr-extended` configure at bootstrap, so the Viewport toggle can be
 * offered (or greyed out) before anyone asks for it. Leaves the canvas
 * configured for whatever the caller configures next; never throws.
 */
export function probeCanvasHdr(
  context: PresentationTarget,
  device: GPUDevice,
  format: GPUTextureFormat,
): { available: boolean; reason: string } {
  const available = tryConfigureHdrCanvas(context, device, format, { presentation: 'hdr-extended' });
  if (!available) {
    return { available, reason: 'canvas toneMapping "extended" / rgba16float not supported by this browser' };
  }
  const hdrDisplay = typeof matchMedia === 'function'
    && matchMedia('(dynamic-range: high)').matches;
  return {
    available,
    reason: hdrDisplay
      ? 'extended tone mapping supported; display reports high dynamic range'
      : 'extended tone mapping supported; display reports standard dynamic range (highlights will still clip)',
  };
}

export function publishCanvasHdrBreadcrumbs(available: boolean, reason: string): void {
  publishDiagnostics({ canvasHdrAvailable: available, canvasHdrReason: reason });
}
