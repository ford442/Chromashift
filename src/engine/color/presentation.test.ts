import { describe, expect, it } from 'vitest';
import { compositorUniforms } from '../graph/exec/uniforms';
import { fakeRendererState } from '../graph/exec/__fixtures__/fakeDevice';
import { createUniformData, packUniforms, uniformOffset } from '../graph/templates/uniformLayout';
import { compositorUniformLayout } from '../graph/templates/wgsl';
import { encodeDisplay } from './displayEncode';
import {
  DISPLAY_P3_TO_SRGB,
  IDENTITY_MAT3,
  PRESENT_MATRIX_FIELDS,
  SRGB_TO_DISPLAY_P3,
  applyMat3,
  mat3ToGlsl,
  planImageUpload,
  presentationMatrix,
  reportedSpaceFromPrimaries,
  resolvePresentation,
  type Mat3,
} from './presentation';
import { emitPresentBlitGlsl } from '../webgl/shaders/presentBlit';
import { webglPresentationNote } from '../webgl/presentationTag';
import { readback2DAttributes } from '../gpu/readbackContext';

function packedMatrix(space: 'srgb' | 'display-p3' | undefined): number[] {
  const layout = compositorUniformLayout(3);
  const data = packUniforms(
    layout,
    compositorUniforms(fakeRendererState({ presentationSpace: space }), 3),
    createUniformData(layout),
  );
  return PRESENT_MATRIX_FIELDS.map((name) => data.f32[uniformOffset(layout, name) / 4]!);
}

const srgbDecode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

describe('resolvePresentation', () => {
  it('srgb is the identity, tagged srgb', () => {
    expect(resolvePresentation({ colorSpace: 'srgb' })).toEqual({ space: 'srgb', matrix: IDENTITY_MAT3 });
  });

  it('display-p3 converts and tags display-p3', () => {
    expect(resolvePresentation({ colorSpace: 'display-p3', presentation: 'sdr' }))
      .toEqual({ space: 'display-p3', matrix: SRGB_TO_DISPLAY_P3 });
  });

  it('Canvas HDR is never converted into P3', () => {
    expect(resolvePresentation({ colorSpace: 'display-p3', presentation: 'hdr-extended' }).space).toBe('srgb');
  });
});

describe('the sRGB → Display P3 matrix', () => {
  it('maps white to white (shared D65)', () => {
    for (const v of applyMat3(SRGB_TO_DISPLAY_P3, [1, 1, 1])) expect(v).toBeCloseTo(1, 6);
  });

  it('round-trips through its documented inverse', () => {
    const m = (a: Mat3, b: Mat3) => [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) =>
      a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!));
    m(DISPLAY_P3_TO_SRGB, SRGB_TO_DISPLAY_P3).forEach((v, i) => expect(v).toBeCloseTo(IDENTITY_MAT3[i]!, 6));
  });

  it('lands sRGB red on the CSS Color 4 display-p3 value', () => {
    const p3 = applyMat3(SRGB_TO_DISPLAY_P3, [1, 0, 0]).map(encodeDisplay);
    expect(p3[0]).toBeCloseTo(0.9175, 3);
    expect(p3[1]).toBeCloseTo(0.2003, 3);
    expect(p3[2]).toBeCloseTo(0.1386, 3);
  });
});

describe('compositor uniforms', () => {
  it('write the identity for srgb — the conversion must never run in that mode', () => {
    expect(packedMatrix('srgb')).toEqual([...IDENTITY_MAT3]);
    expect(packedMatrix(undefined)).toEqual([...IDENTITY_MAT3]);
  });

  it('write SRGB_TO_DISPLAY_P3 for display-p3, and a saturated band colour round-trips', () => {
    const packed = packedMatrix('display-p3');
    packed.forEach((v, i) => expect(v).toBeCloseTo(SRGB_TO_DISPLAY_P3[i]!, 6));
    // A saturated orange band colour, as the compositor would hold it (linear).
    const band: [number, number, number] = [srgbDecode(1), srgbDecode(0.4), srgbDecode(0)];
    const p3 = applyMat3(packed as unknown as Mat3, band);
    const back = applyMat3(DISPLAY_P3_TO_SRGB, p3);
    back.forEach((v, i) => expect(v).toBeCloseTo(band[i]!, 5));
    expect(presentationMatrix('display-p3')).toBe(SRGB_TO_DISPLAY_P3);
  });
});

describe('WebGL presentation', () => {
  it('emits the same matrix into the blit, column-major', () => {
    expect(mat3ToGlsl(IDENTITY_MAT3)).toBe('mat3(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)');
    const glsl = emitPresentBlitGlsl(SRGB_TO_DISPLAY_P3);
    expect(glsl).toContain(mat3ToGlsl(SRGB_TO_DISPLAY_P3));
    expect(mat3ToGlsl(SRGB_TO_DISPLAY_P3).startsWith('mat3(0.8224621, 0.0331941, 0.0170827,')).toBe(true);
  });

  it('says where the conversion happened, and never claims an untagged P3 canvas', () => {
    expect(webglPresentationNote('srgb', true)).toBeNull();
    expect(webglPresentationNote('display-p3', true)).toMatch(/converted in the blit/);
    expect(webglPresentationNote('display-p3', false)).toMatch(/cannot tag.*presenting sRGB/);
  });
});

describe('uploads and readback', () => {
  it('converts only what the decoder reports as Display P3', () => {
    expect(reportedSpaceFromPrimaries('smpte432')).toBe('display-p3');
    expect(reportedSpaceFromPrimaries('bt709')).toBe('srgb');
    expect(reportedSpaceFromPrimaries(undefined)).toBeNull();
    expect(reportedSpaceFromPrimaries('bt2020')).toBeNull();
    expect(planImageUpload('display-p3').convertToSrgb).toBe(true);
    expect(planImageUpload(null)).toMatchObject({ convertToSrgb: false });
    expect(planImageUpload(null).diagnostic).toMatch(/not reported/);
  });

  it('asks the 2D readback context for the presentation space', () => {
    expect(readback2DAttributes()).toEqual({ colorSpace: 'srgb' });
    expect(readback2DAttributes({ colorSpace: 'display-p3', willReadFrequently: true }))
      .toEqual({ colorSpace: 'display-p3', willReadFrequently: true });
  });
});
