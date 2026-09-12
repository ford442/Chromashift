import { describe, expect, it } from 'vitest';
import {
  persistenceCompositeFragmentSource,
  persistenceCompositeMotionFragmentSource,
  persistenceFragmentSource,
  persistenceMotionFragmentSource,
} from './persistence';
import {
  PERSISTENCE_FRAGMENT_SOURCE,
  PERSISTENCE_MOTION_FRAGMENT_SOURCE,
} from '../webgl/shaders/persistence';
import { emitCoincidenceDecayWgsl } from '../graph/templates/wgsl';
import { emitCoincidenceDecayGlsl } from '../graph/templates/glsl';
import { CANONICAL_LAYER_COUNT } from '../graph/layerSpecs';
import { normaliseShaderSource } from '../graph/shaderText';

/**
 * `motionMode: 'off'` must be *the same program*, not a program that happens
 * to compute the same thing. `graph/__golden__/` already pins the non-motion
 * sources against the pre-motion pipeline; these tests pin the other half of
 * that claim — that the motion term is opt-in and leaves the default emission
 * untouched on both backends.
 */
describe('motion is opt-in', () => {
  it('WGSL: the default emission carries no motion binding, uniform or term', () => {
    expect(persistenceFragmentSource).toBe(emitCoincidenceDecayWgsl(CANONICAL_LAYER_COUNT));
    expect(persistenceFragmentSource).not.toContain('motionTex');
    expect(persistenceFragmentSource).not.toContain('motionMode');
    expect(persistenceFragmentSource).not.toContain('motionDecayScale');
    // The uniform block keeps its original three tail pads.
    expect(persistenceFragmentSource).toContain('_pad2');
  });

  it('GLSL: the default emission carries no motion uniform or term', () => {
    expect(PERSISTENCE_FRAGMENT_SOURCE).toBe(emitCoincidenceDecayGlsl(CANONICAL_LAYER_COUNT));
    expect(PERSISTENCE_FRAGMENT_SOURCE).not.toContain('u_motion');
    expect(PERSISTENCE_FRAGMENT_SOURCE).not.toContain('motionDecayScale');
  });

  it('the compute-fed composite pass is equally untouched by default', () => {
    expect(persistenceCompositeFragmentSource).not.toContain('motionTex');
    expect(persistenceCompositeFragmentSource).not.toContain('motionMode');
  });

  it('passing motion: false is identical to passing nothing', () => {
    expect(normaliseShaderSource(emitCoincidenceDecayWgsl(CANONICAL_LAYER_COUNT, { motion: false })))
      .toBe(normaliseShaderSource(persistenceFragmentSource));
    expect(normaliseShaderSource(emitCoincidenceDecayGlsl(CANONICAL_LAYER_COUNT, { motion: false })))
      .toBe(normaliseShaderSource(PERSISTENCE_FRAGMENT_SOURCE));
  });
});

describe('motion variants', () => {
  it('WGSL binds the field after the uniform block and spends the pads', () => {
    expect(persistenceMotionFragmentSource)
      .toContain('@group(0) @binding(6) var motionTex : texture_2d<f32>;');
    expect(persistenceMotionFragmentSource).toContain('motionMode  : u32,');
    expect(persistenceMotionFragmentSource).toContain('motionGain  : f32,');
    expect(persistenceMotionFragmentSource).toContain('motionDecayBias : f32,');
    expect(persistenceMotionFragmentSource).not.toContain('_pad2');
  });

  it('WGSL implements every mode plus the local decay bias', () => {
    // 2 = gate, 3 = direction; 1 (boost) is the `else` arm.
    expect(persistenceMotionFragmentSource).toContain('pu.motionMode == 2u && motion <= 0.0');
    expect(persistenceMotionFragmentSource).toContain('motionDirectionRgb(motionSample.gb');
    expect(persistenceMotionFragmentSource).toContain('1.0 + pu.motionGain * motion');
    expect(persistenceMotionFragmentSource)
      .toContain('motionDecayScale(motion, pu.motionDecayBias, pu.motionMode != 0u)');
  });

  it('the compute-fed composite variant carries the same term', () => {
    expect(persistenceCompositeMotionFragmentSource).toContain('motionTex');
    expect(persistenceCompositeMotionFragmentSource).toContain('pu.motionMode == 2u && motion <= 0.0');
    expect(persistenceCompositeMotionFragmentSource)
      .toContain('motionDecayScale(motion, pu.motionDecayBias, pu.motionMode != 0u)');
  });

  it('GLSL mirrors the WGSL uniforms and modes field for field', () => {
    expect(PERSISTENCE_MOTION_FRAGMENT_SOURCE).toContain('uniform sampler2D u_motion;');
    expect(PERSISTENCE_MOTION_FRAGMENT_SOURCE).toContain('uniform int u_motionMode;');
    expect(PERSISTENCE_MOTION_FRAGMENT_SOURCE).toContain('uniform float u_motionGain;');
    expect(PERSISTENCE_MOTION_FRAGMENT_SOURCE).toContain('uniform float u_motionDecayBias;');
    expect(PERSISTENCE_MOTION_FRAGMENT_SOURCE).toContain('u_motionMode == 2 && motion <= 0.0');
    expect(PERSISTENCE_MOTION_FRAGMENT_SOURCE)
      .toContain('motionDecayScale(motion, u_motionDecayBias, u_motionMode != 0)');
  });
});
