import { BAND, type BandName } from '../math/bandClassification';

/**
 * Band thresholds formatted as GPU shader f32 literals (e.g. "229.0"),
 * generated from the canonical BAND table so WGSL/GLSL cannot drift from
 * the TS/C++ classifiers.
 */
export const BAND_SHADER_FLOAT = Object.fromEntries(
  (Object.entries(BAND) as [BandName, number][]).map(([name, value]) => [
    name,
    value.toFixed(1),
  ]),
) as Record<BandName, string>;

/** WGSL alias — interpolate into WGSL template strings. */
export const BAND_WGSL = BAND_SHADER_FLOAT;

/** GLSL alias — interpolate into GLSL template strings. */
export const BAND_GLSL = BAND_SHADER_FLOAT;

/** Dark/grey band upper bound (rgb <= this) — derived from borderYellow. */
export const DARK_BAND_RGB_MAX = (BAND.borderYellow + 1).toFixed(1);
