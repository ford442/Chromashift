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
  if (rgb > 229) return 0;
  if (rgb > 209) return 1;
  if (rgb > 193) return 2;
  if (rgb > 190) return 3;
  if (rgb > 177) return 4;
  if (rgb > 161) return 5;
  if (rgb > 158) return 6;
  if (rgb > 145) return 7;
  if (rgb > 128) return 8;
  if (rgb > 125) return 9;
  return 10;
}

export function classifyPixelBands(
  r: number,
  g: number,
  b: number,
  avgLum: number,
): number {
  return classifyBandIndex(computeAdjustedRgb(r, g, b, avgLum));
}
