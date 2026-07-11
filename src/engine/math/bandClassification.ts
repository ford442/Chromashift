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
 * Band thresholds, highest first. Band index i is assigned when
 * `rgb > BAND_THRESHOLDS[i]`; values at or below the last threshold get
 * band `BAND_THRESHOLDS.length` (dark/grey). This table is the single
 * source of truth — the WGSL compute shader threshold chain in
 * `compute/wgslSnippets.ts` is generated from it, and
 * `chromashift_engine.cpp` classifyPixel mirrors it.
 */
export const BAND_THRESHOLDS = [229, 209, 193, 190, 177, 161, 158, 145, 128, 125] as const;

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
    if (rgb > BAND_THRESHOLDS[i]) return i;
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
