/**
 * Presentation space: the one place that decides what the pixels leaving the
 * compositor are encoded *for*, and what the canvas (or exported still) is
 * tagged with.
 *
 * Three things that are easy to conflate (see `docs/COLOR_PROFILES.md`):
 *
 * - the **band profile** (LUT) picks hues for each luminance band;
 * - the **working space** is sRGB / BT.709 — every band, LUT and tracer is
 *   defined and accumulated there, and nothing here changes that;
 * - the **presentation space** is the canvas tag plus the conversion into it,
 *   applied once at the very end of the frame.
 *
 * `srgb` is the identity: shaders write exactly what they wrote before this
 * module existed (pinned by the `e2e/__golden__` frames). `display-p3`
 * converts the composited, clipped linear-sRGB frame into linear Display P3
 * with {@link SRGB_TO_DISPLAY_P3} before the OETF, so a `display-p3`-tagged
 * canvas shows the same hues an sRGB canvas does instead of a mis-tagged,
 * desaturated image.
 */
import type { CanvasPresentation, DisplayColorSpace } from '../gpu/gpuOptions';

/** A row-major 3×3 matrix: `out[r] = Σ m[r*3 + c] * in[c]`. */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

export const IDENTITY_MAT3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * Linear sRGB (BT.709 primaries, D65) → linear Display P3 (DCI-P3 primaries,
 * D65). Both spaces share the white point, so no chromatic adaptation: each
 * row sums to 1 and white maps to white. Derived from the primaries as
 * `M_P3⁻¹ · M_sRGB` (RGB→XYZ matrices), rounded to 7 places — the same
 * values CSS Color 4 uses.
 */
export const SRGB_TO_DISPLAY_P3: Mat3 = [
  0.8224621, 0.1775380, 0.0000000,
  0.0331941, 0.9668058, 0.0000000,
  0.0170827, 0.0723974, 0.9105199,
];

/** Linear Display P3 → linear sRGB: the inverse of {@link SRGB_TO_DISPLAY_P3}. */
export const DISPLAY_P3_TO_SRGB: Mat3 = [
  1.2249401, -0.2249404, 0.0000000,
  -0.0420569, 1.0420571, 0.0000000,
  -0.0196376, -0.0786361, 1.0982735,
];

export interface PresentationRequest {
  /** What the user asked for (`viewport.colorSpace`). */
  colorSpace: DisplayColorSpace;
  /** Canvas HDR. HDR stays extended sRGB: it is never converted into P3. */
  presentation?: CanvasPresentation;
}

export interface PresentationPlan {
  /** The space the pixels are actually encoded for, and what to tag with. */
  space: DisplayColorSpace;
  /** Linear-light matrix applied to the composited frame before the OETF. */
  matrix: Mat3;
}

/**
 * Decide the pixel path. `srgb` (and anything under Canvas HDR) is the
 * identity; `display-p3` is the sRGB→P3 conversion plus a `display-p3` tag.
 */
export function resolvePresentation(request: PresentationRequest): PresentationPlan {
  if (request.colorSpace === 'display-p3' && request.presentation !== 'hdr-extended') {
    return { space: 'display-p3', matrix: SRGB_TO_DISPLAY_P3 };
  }
  return { space: 'srgb', matrix: IDENTITY_MAT3 };
}

/** The conversion for an already-resolved space. */
export function presentationMatrix(space: DisplayColorSpace | undefined): Mat3 {
  return space === 'display-p3' ? SRGB_TO_DISPLAY_P3 : IDENTITY_MAT3;
}

export function applyMat3(m: Mat3, rgb: readonly [number, number, number]): [number, number, number] {
  const [r, g, b] = rgb;
  return [
    m[0] * r + m[1] * g + m[2] * b,
    m[3] * r + m[4] * g + m[5] * b,
    m[6] * r + m[7] * g + m[8] * b,
  ];
}

/** Uniform field names for the matrix, `presentM00` … `presentM22` (row, column). */
export const PRESENT_MATRIX_FIELDS = [
  'presentM00', 'presentM01', 'presentM02',
  'presentM10', 'presentM11', 'presentM12',
  'presentM20', 'presentM21', 'presentM22',
] as const;

export type PresentMatrixField = (typeof PRESENT_MATRIX_FIELDS)[number];

export function presentMatrixUniforms(m: Mat3): Record<PresentMatrixField, number> {
  const out = {} as Record<PresentMatrixField, number>;
  PRESENT_MATRIX_FIELDS.forEach((name, i) => { out[name] = m[i]!; });
  return out;
}

/** GLSL `mat3` literal (column-major constructor) for a row-major {@link Mat3}. */
export function mat3ToGlsl(m: Mat3): string {
  const f = (v: number) => (Number.isInteger(v) ? `${v}.0` : `${v}`);
  // GLSL fills columns first.
  const cols = [0, 1, 2].flatMap((c) => [0, 1, 2].map((r) => f(m[r * 3 + c]!)));
  return `mat3(${cols.join(', ')})`;
}

/**
 * What the decoder said a source image was encoded in. `null`: the UA gave no
 * answer, and the bytes are left exactly as they are today.
 */
export type ReportedImageColorSpace = DisplayColorSpace | null;

/**
 * Map WebCodecs `VideoColorSpace.primaries` (what `ImageDecoder` reports for a
 * decoded still) to the spaces we handle. Anything else — including absent —
 * is "not reported": we never guess a gamut.
 */
export function reportedSpaceFromPrimaries(primaries: string | null | undefined): ReportedImageColorSpace {
  if (primaries === 'smpte432') return 'display-p3';
  if (primaries === 'bt709') return 'srgb';
  return null;
}

export interface UploadColorPlan {
  /** Pass to `copyExternalImageToTexture`'s destination: convert into sRGB. */
  convertToSrgb: boolean;
  /** One-line diagnostic for `imageColorSpace`. */
  diagnostic: string;
}

export function planImageUpload(reported: ReportedImageColorSpace): UploadColorPlan {
  if (reported === 'display-p3') {
    return { convertToSrgb: true, diagnostic: 'display-p3 source converted to sRGB at upload' };
  }
  if (reported === 'srgb') {
    return { convertToSrgb: false, diagnostic: 'srgb source (decoder reported bt709)' };
  }
  return { convertToSrgb: false, diagnostic: 'not reported by this browser; bytes uploaded unchanged' };
}
