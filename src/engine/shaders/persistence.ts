// ─── Persistence fragment shader ─────────────────────────────────────────────────────
//
// Accumulates layer overlaps (collisions) over time with configurable decay.
// When layers overlap, we capture the blended color.
// When they don't overlap, we decay the previous persistence.
//
// Every uniform block here is declared as a layout (`PERSIST_UNIFORMS` in
// graph/templates/wgsl.ts, `PERSIST_COMPOSITE_UNIFORMS` below) and the struct is
// emitted from it, so the writer in graph/exec/uniforms.ts cannot disagree with
// the shader about where a field lives.
//
// The decay-rate exponents are interpolated from the canonical table in
// shared/decay.json (via DECAY_WGSL) — never hand-write them here; see
// math/decay.ts and decayTable.test.ts.

import { CANONICAL_LAYER_COUNT } from '../graph/layerSpecs';
import { WGSL_MOTION_HELPERS, emitCoincidenceDecayWgsl } from '../graph/templates/wgsl';
import { defineUniformLayout, emitUniformStructWgsl } from '../graph/templates/uniformLayout';
import { DECAY_WGSL } from './decayLiterals';

export const persistenceFragmentSource = emitCoincidenceDecayWgsl(CANONICAL_LAYER_COUNT);

/**
 * Motion-aware variant of the pass above — one extra binding (the motion
 * field) and three extra uniforms (`motionMode`, `motionGain`,
 * `motionDecayBias`) spent out of the original block's tail padding.
 *
 * It is a separate *module*, not a branch inside the shader above, for one
 * reason: with `motionMode: 'off'` the renderer must be running byte-for-byte
 * the shader it ran before the temporal term existed, so "off is pixel
 * identical" is a fact about which program is bound rather than a claim about
 * floating-point luck. See `docs/LIVE_SOURCE.md`.
 */
export const persistenceMotionFragmentSource = emitCoincidenceDecayWgsl(
  CANONICAL_LAYER_COUNT,
  { motion: true },
);

// ─── Persistence composite (compute-fed) fragment shader ─────────────────────────────
//
// Lighter counterpart to the fragment shader above, used when the WebGPU
// `coincidence` compute pass (engine/compute/chores/kernels.ts) is available.
// The compute pass does the per-pixel 3-layer overlap detection *once* per
// frame (it does not depend on decay duration, so the fused shader above was
// doing that work twice — once for "below" and once for "above" — for no
// reason). This pass only does the cheap part: sample the stamp it produced
// and decay/select against the previous persistence texture.
//
// `stampTex.b` doubles as the "2+ layers overlapping" flag whenever
// `stampTex.a` is 0 (see the compute shader's doc comment for why that's
// safe) — used here to reproduce the original decay-rate switch.

/** Uniforms of the compute-fed composite pass: 16 bytes, or 32 with the temporal term. */
export const PERSIST_COMPOSITE_UNIFORMS = defineUniformLayout('PersistCompositeUniforms', [
  { name: 'decayFactor', kind: 'f32' },
  { name: 'peakMode', kind: 'u32' },
  { name: '_pad0', kind: 'u32' },
  { name: '_pad1', kind: 'u32' },
], { column: 12 });

export const PERSIST_COMPOSITE_MOTION_UNIFORMS = defineUniformLayout('PersistCompositeUniforms', [
  { name: 'decayFactor', kind: 'f32' },
  { name: 'peakMode', kind: 'u32' },
  { name: 'motionMode', kind: 'u32' },
  { name: 'motionGain', kind: 'f32' },
  { name: 'motionDecayBias', kind: 'f32' },
  { name: '_pad0', kind: 'u32' },
  { name: '_pad1', kind: 'u32' },
  { name: '_pad2', kind: 'u32' },
], { column: 12 });

const persistCompositeBody = (motion: boolean) => /* wgsl */ `
@group(0) @binding(0) var stampTex : texture_2d<f32>;
@group(0) @binding(1) var prevTex  : texture_2d<f32>;
${motion ? `
@group(0) @binding(3) var motionSampler : sampler;
@group(0) @binding(4) var motionTex : texture_2d<f32>;
` : ''}
${emitUniformStructWgsl(motion ? PERSIST_COMPOSITE_MOTION_UNIFORMS : PERSIST_COMPOSITE_UNIFORMS)}
@group(0) @binding(2) var<uniform> pu : PersistCompositeUniforms;
${motion ? WGSL_MOTION_HELPERS : ''}
struct FragmentOutputs {
  @location(0) persistence : vec4<f32>,
};

@fragment
fn main(@builtin(position) fragCoord : vec4<f32>) -> FragmentOutputs {
  let coord = vec2<i32>(fragCoord.xy);
  let stamp = textureLoad(stampTex, coord, 0);
  let prev  = textureLoad(prevTex, coord, 0);
${motion ? `
  // The field is quarter-resolution, so it is sampled rather than loaded: the
  // bilinear filter is what keeps a 4x4 cell boundary from showing as a seam
  // in the tracer.
  let dims = vec2<f32>(textureDimensions(prevTex, 0));
  let motionSample = textureSample(motionTex, motionSampler, (vec2<f32>(coord) + vec2<f32>(0.5)) / dims);
  let motion = clamp(motionSample.r, 0.0, 1.0);
` : ''}
  var newColor   = vec4<f32>(stamp.rgb, stamp.a);
  let hadOverlap = stamp.a > 0.5 || stamp.b > 0.5;
${motion ? `
  if (pu.motionMode != 0u && newColor.a > 0.0) {
    if (pu.motionMode == 2u && motion <= 0.0) {
      newColor = vec4<f32>(0.0);
    } else if (pu.motionMode == 3u) {
      newColor = vec4<f32>(motionDirectionRgb(motionSample.gb, motion, pu.motionGain), newColor.a);
    } else {
      newColor = vec4<f32>(min(newColor.rgb * (1.0 + pu.motionGain * motion), vec3<f32>(1.0)), newColor.a);
    }
  }
` : ''}
  let decayMod = select(${DECAY_WGSL.idleDecayExponent}, ${DECAY_WGSL.overlapDecayExponent}, hadOverlap)${motion ? ' * motionDecayScale(motion, pu.motionDecayBias, pu.motionMode != 0u)' : ''};
  let effectiveDecay = pow(pu.decayFactor, decayMod);
  var decayed = prev * effectiveDecay;
  if (pu.peakMode == 1u) {
    decayed = vec4<f32>(0.0);
  }

  var out : FragmentOutputs;
  out.persistence = select(decayed, newColor, newColor.a > decayed.a);
  return out;
}
`;

export const persistenceCompositeFragmentSource = persistCompositeBody(false);

/** Motion-aware twin of the compute-fed composite pass (see above). */
export const persistenceCompositeMotionFragmentSource = persistCompositeBody(true);
