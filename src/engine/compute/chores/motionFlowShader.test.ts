import { describe, expect, it } from 'vitest';
import { MOTION_FIELD_COMPUTE_SHADER } from './kernels';
import {
  MOTION_FLOW_COARSE_COMPUTE_SHADER,
  MOTION_FLOW_REFINE_COMPUTE_SHADER,
} from './motionFlowKernels';
import {
  LK_EPSILON,
  LK_MAX_FLOW,
  LK_MAX_STEP,
  LK_REGULARIZATION,
} from './motionKernel';

/**
 * The WGSL flow passes cannot be executed in this repo's Vitest environment —
 * there is no device, and `?renderer=webgl` is exactly the configuration that
 * has no compute lane at all. What *can* be pinned here is the part that
 * silently rots: that the shader spells the same tuning constants the CPU
 * kernels do, in the same places, rather than a hand-copied second set.
 *
 * Behavioural parity is the job of `motionKernel.test.ts` (TS), the
 * `computeMotionFlow` tests in `cpp/tests/test_engine.cpp` (C++/scalar) and the
 * motion-flow fixture in `npm run bench:wasm` (C++/SIMD128); the WGSL lane is
 * covered by `e2e/live-source.spec.ts` on a real device.
 */
describe('motion flow WGSL', () => {
  it('emits every LK constant as a float literal, not an integer', () => {
    for (const source of [MOTION_FLOW_COARSE_COMPUTE_SHADER, MOTION_FLOW_REFINE_COMPUTE_SHADER]) {
      expect(source).toContain(`${LK_REGULARIZATION} * (acc.ixx + acc.iyy) + ${LK_EPSILON}`);
      // WGSL has no implicit int-to-float promotion: `2` here is a type error.
      expect(source).toContain(`clamp(step_x, ${(-LK_MAX_STEP).toFixed(1)}, ${LK_MAX_STEP.toFixed(1)})`);
      expect(source).toContain(`vec2<f32>(${LK_MAX_FLOW.toFixed(1)})`);
      expect(source).not.toMatch(/clamp\(step_x, -2,/);
    }
  });

  it('declares the two entry points the backend compiles', () => {
    expect(MOTION_FLOW_COARSE_COMPUTE_SHADER).toContain('fn motion_flow_coarse_main');
    expect(MOTION_FLOW_REFINE_COMPUTE_SHADER).toContain('fn motion_flow_refine_main');
    for (const source of [MOTION_FLOW_COARSE_COMPUTE_SHADER, MOTION_FLOW_REFINE_COMPUTE_SHADER]) {
      expect(source).toContain('@compute @workgroup_size(8, 8)');
    }
  });

  it('writes only core storage-texture formats', () => {
    // `rg16float` would fit the velocity exactly, but it is not a core
    // storage format — requesting the feature for it would add a failure mode
    // to one quarter-scale texture.
    for (const source of [MOTION_FLOW_COARSE_COMPUTE_SHADER, MOTION_FLOW_REFINE_COMPUTE_SHADER]) {
      expect(source).toContain('texture_storage_2d<rgba16float, write>');
      expect(source).not.toContain('rg16float');
    }
  });

  it('keeps the magnitude channel the frame-difference pass wrote', () => {
    // `boost` and `gate` sample `.r`. The refine pass copies it through rather
    // than recomputing it, so turning flow on cannot move their pixels.
    expect(MOTION_FLOW_REFINE_COMPUTE_SHADER)
      .toContain('let magnitude = textureLoad(field_tex, cell, 0).r;');
    expect(MOTION_FLOW_REFINE_COMPUTE_SHADER)
      .toContain('vec4<f32>(magnitude, flow.x, flow.y, 1.0)');
  });

  it('zeroes the flow on a reset, exactly as the field pass zeroes the magnitude', () => {
    expect(MOTION_FIELD_COMPUTE_SHADER).toContain('if (mp.reset == 0u)');
    expect(MOTION_FLOW_COARSE_COMPUTE_SHADER).toContain('if (fp.reset != 0u)');
    expect(MOTION_FLOW_REFINE_COMPUTE_SHADER)
      .toContain('textureStore(flow_field_tex, cell, vec4<f32>(magnitude, 0.0, 0.0, 1.0));');
  });

  it('warps only the previous plane, and only in the refine pass', () => {
    // The coarse level's guess is always zero, so its temporal term is a plain
    // difference — the bilinear fetch there would be a no-op with a cost.
    expect(MOTION_FLOW_COARSE_COMPUTE_SHADER).not.toContain('lum_bilinear');
    expect(MOTION_FLOW_REFINE_COMPUTE_SHADER)
      .toContain('lum_bilinear(prev_lum_tex, f32(x) - guess.x, f32(y) - guess.y)');
  });
});
