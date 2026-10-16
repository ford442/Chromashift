import { describe, expect, it } from 'vitest';
import {
  createUniformData,
  defineUniformLayout,
  emitUniformStructWgsl,
  packUniforms,
  uniformOffset,
} from './uniformLayout';
import {
  BAND_LAYER_UNIFORMS,
  HISTORY_MAX_FRAMES,
  HISTORY_UNIFORMS,
  PERSIST_MOTION_UNIFORMS,
  PERSIST_UNIFORMS,
  compositorUniformLayout,
  emitCompositorWgsl,
  emitCoincidenceDecayWgsl,
} from './wgsl';
import { WGSL_BLEND_HELPERS } from '../../shaders/common';

const LAYOUT = defineUniformLayout('Example', [
  { name: 'scale', kind: 'f32' },
  { name: 'mode', kind: 'u32', doc: 'Which mode.' },
  { name: '_pad0', kind: 'u32' },
  { name: 'longerThanTheColumn', kind: 'f32' },
  { name: 'gain', kind: 'f32' },
], { column: 6 });

describe('defineUniformLayout', () => {
  it('assigns 4-byte offsets in order and rounds the block up to 16 bytes', () => {
    expect(LAYOUT.fields.map((field) => field.offset)).toEqual([0, 4, 8, 12, 16]);
    expect(LAYOUT.bytes).toBe(32);
    expect(uniformOffset(LAYOUT, 'gain')).toBe(16);
  });

  it('refuses a field declared twice', () => {
    expect(() => defineUniformLayout('Twice', [
      { name: 'a', kind: 'f32' },
      { name: 'a', kind: 'u32' },
    ], { column: 2 })).toThrow(/declares 'a' twice/);
  });
});

describe('emitUniformStructWgsl', () => {
  it('aligns the colon at the column, abuts a name that fills it and spaces one that overruns it', () => {
    expect(emitUniformStructWgsl(LAYOUT)).toBe([
      'struct Example {',
      '  scale : f32,',
      '  /** Which mode. */',
      '  mode  : u32,',
      '  _pad0 : u32,',
      '  longerThanTheColumn : f32,',
      '  gain  : f32,',
      '};',
    ].join('\n'));
    const exact = defineUniformLayout('Exact', [{ name: 'abcdef', kind: 'f32' }], { column: 6 });
    expect(emitUniformStructWgsl(exact)).toContain('  abcdef: f32,');
  });

  it('is what every emitter declares — the struct in the shader comes from the layout', () => {
    expect(emitCoincidenceDecayWgsl(3)).toContain(emitUniformStructWgsl(PERSIST_UNIFORMS));
    expect(emitCoincidenceDecayWgsl(3, { motion: true })).toContain(emitUniformStructWgsl(PERSIST_MOTION_UNIFORMS));
    for (const n of [1, 3, 5, 10]) {
      expect(emitCompositorWgsl(n, WGSL_BLEND_HELPERS)).toContain(emitUniformStructWgsl(compositorUniformLayout(n)));
    }
  });
});

describe('packUniforms', () => {
  it('writes f32 and u32 fields at their offsets and leaves padding alone', () => {
    const data = packUniforms(LAYOUT, { scale: 0.5, mode: 7, longerThanTheColumn: -2, gain: 3 }, createUniformData(LAYOUT));
    const view = new DataView(data.buffer);
    expect(view.getFloat32(0, true)).toBe(0.5);
    expect(view.getUint32(4, true)).toBe(7);
    expect(view.getUint32(8, true)).toBe(0);
    expect(view.getFloat32(12, true)).toBe(-2);
    expect(view.getFloat32(16, true)).toBe(3);
  });

  it('refuses to leave a field stale when a value is missing', () => {
    const layout = compositorUniformLayout(4);
    const partial = { layerOpacity0: 1 } as never;
    expect(() => packUniforms(layout, partial, createUniformData(layout)))
      .toThrow(/No value for uniform 'CompositorUniforms\.tracerAboveOpacity'/);
  });

  it('packs a superset of fields into a layout with padding where the extras go', () => {
    const data = createUniformData(PERSIST_UNIFORMS);
    const withMotion = {
      decayFactor: 0.9, colorThresh: 0.05, stampBoost: 1.8, tracerMode: 1, peakMode: 0,
      motionMode: 3, motionGain: 2, motionDecayBias: 0.5,
    };
    packUniforms(PERSIST_UNIFORMS, withMotion, data);
    // The three tail slots are `_pad0..2` in the non-motion struct.
    expect([...data.u32.slice(5)]).toEqual([0, 0, 0]);
  });
});

describe('the shipped layouts', () => {
  it('keep the block sizes the buffers have always been allocated with', () => {
    expect(BAND_LAYER_UNIFORMS.bytes).toBe(32);
    expect(PERSIST_UNIFORMS.bytes).toBe(32);
    expect(PERSIST_MOTION_UNIFORMS.bytes).toBe(32);
    expect(compositorUniformLayout(3).bytes).toBe(64);
    expect(HISTORY_UNIFORMS.fields).toHaveLength(HISTORY_MAX_FRAMES);
  });

  it('move every compositor field after the opacities with the layer count', () => {
    for (const n of [1, 2, 3, 5, 8, 10]) {
      const layout = compositorUniformLayout(n);
      expect(uniformOffset(layout, `layerOpacity${n - 1}`)).toBe((4 + n - 1) * 4);
      expect(uniformOffset(layout, 'diagnosticsOpacity')).toBe((4 + n) * 4);
      expect(uniformOffset(layout, 'viewportHalfOverlay')).toBe((4 + n + 7) * 4);
    }
  });
});
