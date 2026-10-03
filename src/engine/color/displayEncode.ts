/**
 * Scalar mirrors of the WGSL output encodes in `graph/templates/wgsl.ts`
 * (`WGSL_OUTPUT_ENCODE` / `WGSL_OUTPUT_ENCODE_EXTENDED`), for unit tests and
 * any CPU path that has to agree with the canvas present.
 */

function srgbOetf(lin: number): number {
  return lin <= 0.0031308 ? lin * 12.92 : 1.055 * Math.pow(lin, 1 / 2.4) - 0.055;
}

/** `sdr` presentation: linear -> sRGB, clipped to [0, 1] first. */
export function encodeDisplay(linear: number): number {
  return srgbOetf(Math.min(1, Math.max(0, linear)));
}

/** `hdr-extended` presentation: the same curve, sign-mirrored and unclamped. */
export function encodeDisplayExtended(linear: number): number {
  return Math.sign(linear) * srgbOetf(Math.abs(linear));
}
