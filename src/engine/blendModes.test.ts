import { describe, expect, it } from 'vitest';
import { applyBlend, BLEND_MODES, getBlendModeInfo, type Rgba } from './blendModes';

describe('BLEND_MODES metadata', () => {
  it('exposes 13 modes with contiguous ids', () => {
    expect(BLEND_MODES).toHaveLength(13);
    BLEND_MODES.forEach((mode, index) => {
      expect(mode.id).toBe(index);
      expect(getBlendModeInfo(index)?.name).toBe(mode.name);
    });
  });
});

describe('applyBlend', () => {
  const dst: Rgba = [0.2, 0.4, 0.6, 1];
  const src: Rgba = [0.8, 0.5, 0.1, 1];

  it('alpha mode is Porter-Duff source-over', () => {
    const out = applyBlend(dst, src, 0);
    expect(out[0]).toBeCloseTo(src[0] + dst[0] * (1 - src[3]));
    expect(out[3]).toBeCloseTo(1);
  });

  it('add mode clamps to white', () => {
    const bright: Rgba = [0.9, 0.9, 0.9, 1];
    const addSrc: Rgba = [0.5, 0.5, 0.5, 1];
    const out = applyBlend(bright, addSrc, 1);
    expect(out[0]).toBeCloseTo(1);
    expect(out[1]).toBeCloseTo(1);
    expect(out[2]).toBeCloseTo(1);
  });

  it('multiply mode darkens channels', () => {
    const out = applyBlend(dst, src, 3);
    expect(out[0]).toBeCloseTo(dst[0] * src[0], 3);
    expect(out[1]).toBeCloseTo(dst[1] * src[1], 3);
    expect(out[2]).toBeCloseTo(dst[2] * src[2], 3);
  });

  it('screen mode lightens channels', () => {
    const out = applyBlend(dst, src, 4);
    const expectedR = 1 - (1 - dst[0]) * (1 - src[0]);
    expect(out[0]).toBeCloseTo(expectedR, 3);
  });

  it('falls back to alpha blend for unknown mode ids', () => {
    const alpha = applyBlend(dst, src, 0);
    const unknown = applyBlend(dst, src, 99);
    expect(unknown[0]).toBeCloseTo(alpha[0]);
    expect(unknown[3]).toBeCloseTo(alpha[3]);
  });
});
