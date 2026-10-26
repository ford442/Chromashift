import bandTable from '../../../shared/band.json';

/** BT.709 luminance scaled 0–255 (matches WGSL / C++). */
export function bt709Luminance(r: number, g: number, b: number): number {
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

/**
 * Preprocessed rgb value used for band thresholds — mirrors WGSL layer shaders
 * and chromashift_engine.cpp classifyPixel.
 */
export function computeAdjustedRgb(
  r: number,
  g: number,
  b: number,
  avgLum: number,
): number {
  const lum = bt709Luminance(r, g, b);
  const lightDark = 128 + Math.abs(avgLum - 128) / 2;
  return lum + lightDark / 2;
}

/**
 * Canonical named band thresholds — the single source of truth for the
 * colour-separation bands. Consumers:
 *   - WGSL layer fragment shaders (`shaders/layers.ts`, via `BAND_WGSL`)
 *   - WGSL compute classification (`compute/wgslSnippets.ts`)
 *   - the TS classifier below
 *   - `chromashift_engine.cpp` classifyPixel mirrors it (guarded by
 *     `compute/goldenMask.test.ts`, which parses the C++ source)
 * Key order matters: it defines the band indices (0 = greyHighlight …
 * 9 = borderYellow, 10 = dark/grey).
 */
/** Canonical thresholds from shared/band.json (codegen source for C++ / WGSL). */
export const BAND = bandTable.bands;

export type BandName = keyof typeof BAND;

/**
 * Band thresholds, highest first. Band index i is assigned when
 * `rgb > BAND_THRESHOLDS[i]`; values at or below the last threshold get
 * band `BAND_THRESHOLDS.length` (dark/grey).
 */
export const BAND_THRESHOLDS: readonly number[] = Object.values(BAND);

/** How many band indices there are: one per threshold, plus dark/grey. C++'s `BAND_COUNT + 1`. */
export const BAND_INDEX_COUNT = BAND_THRESHOLDS.length + 1;

/**
 * Classify adjusted rgb into a Chromashift colour band index (0–10).
 *
 * Band mapping (matches WGSL shaders and C++ host tests):
 *   0  grey highlight  (rgb > 229)
 *   1  orange          (209 < rgb ≤ 229)
 *   2  red             (193 < rgb ≤ 209)
 *   3  border red      (190 < rgb ≤ 193)
 *   4  violet          (177 < rgb ≤ 190)
 *   5  blue            (161 < rgb ≤ 177)
 *   6  border blue     (158 < rgb ≤ 161)
 *   7  green           (145 < rgb ≤ 158)
 *   8  yellow          (128 < rgb ≤ 145)
 *   9  border yellow   (125 < rgb ≤ 128)
 *  10  dark / grey     (rgb ≤ 126)
 */
export function classifyBandIndex(rgb: number): number {
  for (let i = 0; i < BAND_THRESHOLDS.length; i += 1) {
    if (rgb > BAND_THRESHOLDS[i]!) return i;
  }
  return BAND_THRESHOLDS.length;
}

export function classifyPixelBands(
  r: number,
  g: number,
  b: number,
  avgLum: number,
): number {
  return classifyBandIndex(computeAdjustedRgb(r, g, b, avgLum));
}

const BT709_R_F32 = Math.fround(0.2126);
const BT709_G_F32 = Math.fround(0.7152);
const BT709_B_F32 = Math.fround(0.0722);

/**
 * `classifyPixelBands` evaluated in float32, rounding after every operation in
 * the order C++ `classifyPixel` and the WGSL `classify_band()` mask kernel use.
 *
 * The plain version computes in doubles, so a pixel whose luminance lands
 * within float32 rounding of a threshold can fall on the other side of it (a
 * handful per 4K frame). The classification-mask lanes — WebGPU, WASM and this
 * TypeScript fallback — must produce the same bytes, so the mask uses this one.
 * The thresholds are integers, exact in float32, so only the arithmetic needs
 * rounding.
 */
export function classifyPixelBandsF32(
  r: number,
  g: number,
  b: number,
  avgLum: number,
): number {
  const f = Math.fround;
  const lum = f(f(f(r * BT709_R_F32) + f(g * BT709_G_F32)) + f(b * BT709_B_F32));
  const lightDark = f(128 + f(Math.abs(f(f(avgLum) - 128)) / 2));
  return classifyBandIndex(f(lum + f(lightDark / 2)));
}

/** lightDark/2 offset from average luminance — shared by LUT build and lookup. */
export function bandLutOffset(avgLum: number): number {
  const lightDark = 128 + Math.abs(avgLum - 128) / 2;
  return lightDark / 2;
}

/**
 * Build a 256-entry band LUT for the given average luminance.
 * Entry `lut[l]` is the band for integer luminance bucket `l`.
 */
export function buildBandLut(avgLum: number): Uint8Array {
  const offset = bandLutOffset(avgLum);
  const lut = new Uint8Array(256);
  for (let lum = 0; lum < 256; lum += 1) {
    lut[lum] = classifyBandIndex(lum + offset);
  }
  return lut;
}

/**
 * Classify a pixel with a pre-built LUT — matches C++ classifyLumWithLut().
 */
export function classifyPixelBandsLut(
  r: number,
  g: number,
  b: number,
  avgLum: number,
  lut: Uint8Array,
): number {
  const lum = bt709Luminance(r, g, b);
  const offset = bandLutOffset(avgLum);
  const rgb = lum + offset;
  if (lum < 0 || lum >= 255) {
    return classifyBandIndex(rgb);
  }
  const l0 = Math.floor(lum);
  const l1 = l0 + 1;
  // 0 <= l0 < l1 <= 255 here, inside the 256-entry LUT.
  if (lut[l0] === lut[l1]) {
    return lut[l0]!;
  }
  return classifyBandIndex(rgb);
}
