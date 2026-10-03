import { describe, expect, it } from 'vitest';
import {
  compareFragmentSource,
  coincidenceHeatmapFragmentSource,
  compositorFragmentSource,
  displayTextureFragmentSource,
  tracerViewFragmentSource,
  toHdrPresentWgsl,
  WGSL_OUTPUT_ENCODE,
  WGSL_OUTPUT_ENCODE_EXTENDED,
} from './index';
import { encodeDisplay, encodeDisplayExtended } from '../color/displayEncode';

/**
 * Every pass that targets the *canvas* format owns the linear -> sRGB OETF.
 *
 * Source images are uploaded as `rgba8unorm-srgb`, so samples arrive in linear
 * light, and `navigator.gpu.getPreferredCanvasFormat()` never returns an
 * `-srgb` format. Writing linear values straight to the swap chain makes the
 * display apply its EOTF twice, which is what crushed every frame.
 */
const CANVAS_TARGET_SHADERS: ReadonlyArray<readonly [string, string]> = [
  ['compositor', compositorFragmentSource],
  ['tracer view', tracerViewFragmentSource],
  ['display texture', displayTextureFragmentSource],
  ['coincidence heatmap', coincidenceHeatmapFragmentSource],
  ['compare', compareFragmentSource],
];

describe('canvas-format shaders encode their output', () => {
  it.each(CANVAS_TARGET_SHADERS)('%s defines the OETF', (_name, source) => {
    expect(source).toContain('fn linear_to_srgb(');
    expect(source).toContain('fn encode_display(');
  });

  it.each(CANVAS_TARGET_SHADERS)('%s applies it on the way out', (_name, source) => {
    expect(source).toMatch(/encode_display\(/);
  });

  it('encodes the compositor result once, at the end of compositeAt', () => {
    // `main` reads compositeAt's return value (directly, or twice for the
    // half-overlay), so the encode belongs there and must not be repeated.
    const occurrences = compositorFragmentSource.match(/encode_display\(/g) ?? [];
    expect(occurrences).toHaveLength(2); // the fn definition plus the one call
    expect(compositorFragmentSource).toContain('return vec4<f32>(encode_display(graded), 1.0);');
  });

  it('leaves display-referred literals unencoded', () => {
    // Letterbox fill is authored in display space and returned before the
    // encode; the compare view samples in linear light, so its letterbox is
    // the same grey expressed in linear.
    expect(displayTextureFragmentSource).toContain('return vec4<f32>(0.02, 0.02, 0.03, 1.0);');
    expect(compareFragmentSource).toContain('return vec3<f32>(0.00155, 0.00155, 0.00235);');
  });

  it('no longer carries the ad-hoc Reinhard curve that darkened every frame', () => {
    for (const [, source] of CANVAS_TARGET_SHADERS) {
      expect(source).not.toContain('vec3<f32>(0.15)');
      expect(source).not.toContain('* 1.04');
    }
  });
});

describe('hdr-extended present variant', () => {
  it.each(CANVAS_TARGET_SHADERS)('%s swaps in the unclamped OETF', (_name, source) => {
    const hdr = toHdrPresentWgsl(source);
    expect(hdr).not.toContain(WGSL_OUTPUT_ENCODE);
    expect(hdr).toContain(WGSL_OUTPUT_ENCODE_EXTENDED);
    expect(hdr).not.toContain('clamp(c, vec3<f32>(0.0), vec3<f32>(1.0))');
    // Only the encode block changes; every call site is untouched.
    expect(hdr.split(WGSL_OUTPUT_ENCODE_EXTENDED).join(WGSL_OUTPUT_ENCODE)).toBe(source);
  });

  it('leaves the SDR sources as they were', () => {
    expect(compositorFragmentSource).toContain(WGSL_OUTPUT_ENCODE);
    expect(compositorFragmentSource).not.toContain(WGSL_OUTPUT_ENCODE_EXTENDED);
  });

  it('keeps an over-bright additive tracer above SDR white', () => {
    expect(encodeDisplay(2)).toBeCloseTo(1, 12);
    expect(encodeDisplayExtended(2)).toBeGreaterThan(1.3);
  });

  it('matches the SDR encode everywhere inside [0, 1]', () => {
    for (let i = 0; i <= 64; i++) {
      const x = i / 64;
      expect(encodeDisplayExtended(x)).toBeCloseTo(encodeDisplay(x), 12);
    }
    expect(encodeDisplayExtended(-0.5)).toBeCloseTo(-encodeDisplay(0.5), 12);
  });
});
