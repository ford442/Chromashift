/**
 * Per-pixel tracer overlap ("coincidence") detection.
 *
 * Mirrors `COINCIDENCE_COMPUTE_SHADER` in `engine/compute/chores/kernels.ts`
 * and the fused overlap math that used to live inline in
 * `engine/shaders/persistence.ts`'s fragment shader (still the WGSL fallback
 * used when compute storage textures are unavailable). Both must stay in
 * lockstep with this function — see `coincidence.test.ts`.
 */

export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface CoincidenceParams {
  /** Minimum alpha to consider a layer "visible" at a pixel. */
  colorThresh: number;
  /** Brightness multiplier applied only to a fresh collision stamp. */
  stampBoost: number;
  /** 0 = combined colour, 1 = grey highlight. */
  tracerMode: number;
}

export interface CoincidenceResult {
  /** Fresh collision stamp for this frame; the zero vector when nothing was painted. */
  stamp: RgbaColor;
  /**
   * Diagnostic encoding for CPU readback / visualisation: r = dominant layer
   * index / 2, g = 1.0 when all 3 layers overlap else 0.5, b = colour
   * variance among active layers (scaled, clamped), a = 1.0 when a stamp was
   * painted. The zero vector when nothing was painted.
   */
  diag: RgbaColor;
  /**
   * True when 2 or more layers have visible colour at this pixel. Drives the
   * persistence decay-rate switch and is independent of whether a stamp was
   * actually painted (uniform-colour overlaps still decay faster).
   */
  hadOverlap: boolean;
}

const ZERO: RgbaColor = { r: 0, g: 0, b: 0, a: 0 };

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

function luminance(c: RgbaColor): number {
  return c.r * LUMA_R + c.g * LUMA_G + c.b * LUMA_B;
}

export function computeCoincidence(
  layers: readonly [RgbaColor, RgbaColor, RgbaColor],
  params: CoincidenceParams,
): CoincidenceResult {
  const thresh = params.colorThresh;
  const active: [boolean, boolean, boolean] = [
    layers[0].a > thresh,
    layers[1].a > thresh,
    layers[2].a > thresh,
  ];
  const layerCount = (active[0] ? 1 : 0) + (active[1] ? 1 : 0) + (active[2] ? 1 : 0);

  if (layerCount < 2) {
    return { stamp: ZERO, diag: ZERO, hadOverlap: false };
  }

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (let i = 0; i < 3; i += 1) {
    if (active[i]) {
      sumR += layers[i].r;
      sumG += layers[i].g;
      sumB += layers[i].b;
    }
  }
  const combined: RgbaColor = { r: sumR / layerCount, g: sumG / layerCount, b: sumB / layerCount, a: 1 };

  let variance = 0;
  for (let i = 0; i < 3; i += 1) {
    if (active[i]) {
      const dr = layers[i].r - combined.r;
      const dg = layers[i].g - combined.g;
      const db = layers[i].b - combined.b;
      variance += Math.sqrt(dr * dr + dg * dg + db * db);
    }
  }

  if (variance <= 0.01) {
    return { stamp: ZERO, diag: ZERO, hadOverlap: true };
  }

  let dominantLayer = 0;
  let maxLum = 0;
  for (let i = 0; i < 3; i += 1) {
    if (active[i]) {
      const lum = luminance(layers[i]);
      if (lum > maxLum) {
        maxLum = lum;
        dominantLayer = i;
      }
    }
  }

  let stamp: RgbaColor;
  if (params.tracerMode === 1) {
    const boosted = Math.min(luminance(combined) * params.stampBoost, 1.0);
    stamp = { r: boosted, g: boosted, b: boosted, a: 1.0 };
  } else {
    stamp = {
      r: Math.min(combined.r * params.stampBoost, 1.0),
      g: Math.min(combined.g * params.stampBoost, 1.0),
      b: Math.min(combined.b * params.stampBoost, 1.0),
      a: 1.0,
    };
  }

  const diag: RgbaColor = {
    r: dominantLayer / 2,
    g: layerCount >= 3 ? 1.0 : 0.5,
    b: Math.min(Math.max(variance * 10, 0), 1),
    a: 1.0,
  };

  return { stamp, diag, hadOverlap: true };
}
